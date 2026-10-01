import https from 'https';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const TABLE_NAME = process.env.TABLE_NAME;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-lite-v1:0';
const DEVTO_SECRET_ARN = process.env.DEVTO_SECRET_ARN;
const TOPIC_ARN = process.env.TOPIC_ARN;

// Feed sources to include in the weekly summary. "news" has no pk prefix.
const SOURCES = ['news', 'architecture', 'compute'];

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const bedrock = new BedrockRuntimeClient({});
const secrets = new SecretsManagerClient({});
const sns = new SNSClient({});

/** Returns the pk prefix for a given source ("" for news). */
function pkFor(source, yearMonth) {
  return source === 'news' ? yearMonth : `${source}#${yearMonth}`;
}

function yearMonthOf(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}#${month}`;
}

// Friday = 5 in JS getUTCDay() (Sun=0). The weekly post is anchored to this.
const ANCHOR_WEEKDAY = 5; // Friday
const ANCHOR_HOUR_UTC = 12; // 12:00 UTC — matches the EventBridge schedule

/**
 * Snaps a timestamp back to the most recent Friday 12:00:00 UTC that is at or
 * before `ref`. This anchors the weekly window to the schedule (Friday noon)
 * instead of the exact Lambda invocation time, so boundaries are reproducible
 * regardless of trigger jitter or manual/off-day invocations.
 *
 * Examples (UTC):
 *   ref = Fri 12:00:03  -> Fri 12:00:00 (same day)
 *   ref = Fri 11:59:00  -> previous Fri 12:00:00
 *   ref = Tue 09:00:00  -> previous Fri 12:00:00
 */
function anchorToFridayNoon(ref) {
  const d = new Date(Date.UTC(
    ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(),
    ANCHOR_HOUR_UTC, 0, 0, 0,
  ));
  // Step back day-by-day until we land on a Friday that is <= ref.
  while (d.getUTCDay() !== ANCHOR_WEEKDAY || d.getTime() > ref.getTime()) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

/**
 * Collect the set of month partitions (YYYY#MM) that overlap the window
 * [since, now]. A 7-day window can straddle a month boundary, so we query
 * both the current month and the previous month when needed.
 */
function monthsInWindow(since, now) {
  const months = new Set([yearMonthOf(now), yearMonthOf(since)]);
  return [...months];
}

async function queryItems(pk) {
  const items = [];
  let lastKey;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Reads all items from the included sources with pubDate within the last 7 days. */
async function collectWeeklyItems(now, since) {
  const months = monthsInWindow(since, now);
  const seen = new Set();
  const items = [];

  for (const source of SOURCES) {
    for (const yearMonth of months) {
      const pk = pkFor(source, yearMonth);
      let records;
      try {
        records = await queryItems(pk);
      } catch (err) {
        console.error(`Failed to query ${pk}:`, err.message);
        continue;
      }
      for (const r of records) {
        const pub = new Date(r.pubDate);
        if (isNaN(pub.getTime()) || pub < since || pub > now) continue;
        if (seen.has(r.sk)) continue; // dedupe by link across month partitions
        seen.add(r.sk);
        items.push({
          title: r.title,
          link: r.sk,
          pubDate: r.pubDate,
          description: r.description || '',
          source,
          analysis: r.analysis || null,
        });
      }
    }
  }

  // Newest first
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return items;
}

/** Asks Bedrock to turn the week's items into a dev.to-ready article. */
async function generateArticle(items, weekStart, weekEnd) {
  const itemLines = items.map((it, i) => {
    const impact = it.analysis?.impactScore != null ? ` [impact ${it.analysis.impactScore}/10]` : '';
    const summary = it.analysis?.summary ? ` — ${it.analysis.summary}` : ` — ${it.description}`;
    return `${i + 1}. (${it.source}) ${it.title}${impact}${summary}\n   Link: ${it.link}`;
  }).join('\n');

  const range = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;

  // Note: we deliberately do NOT ask for JSON here. Multi-line Markdown packed
  // into a JSON string field routinely produces invalid JSON (unescaped
  // newlines/tabs), which breaks JSON.parse. Instead we use line delimiters
  // that are immune to whatever control characters appear in the body.
  const prompt = `You are an AWS serverless expert writing a weekly roundup blog post for dev.to.

Below are the AWS serverless-related announcements from the week of ${range}. Write an engaging, well-structured article in Markdown that summarizes the week's highlights for serverless developers.

Announcements:
${itemLines}

Requirements:
- Open with a short intro paragraph setting the theme for the week.
- Group related announcements and explain why they matter for serverless developers.
- Reference the original announcements with Markdown links using the provided URLs.
- Close with a brief "What this means" takeaway.
- Use a friendly, professional tone. Use H2 (##) section headings.

Respond in EXACTLY this format, with no extra commentary before or after:
TITLE: <an engaging article title, max 100 chars, on one line>
TAGS: <1-4 comma-separated lowercase single-word tags, letters/numbers only, no spaces or #>
BODY:
<the full article body in Markdown, which may span many lines>

Everything after the "BODY:" line is the article body.`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 3000 },
    }),
  }));

  const result = JSON.parse(new TextDecoder().decode(response.body));
  const text = result.output?.message?.content?.[0]?.text || '';

  return parseArticle(text);
}

/**
 * Parses the delimited TITLE/TAGS/BODY response. Tolerant of extra whitespace
 * and of the model wrapping the output in a markdown code fence.
 */
function parseArticle(raw) {
  const text = raw
    .replace(/^\s*```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const titleMatch = text.match(/^TITLE:\s*(.+)$/im);
  const tagsMatch = text.match(/^TAGS:\s*(.+)$/im);
  const bodyMatch = text.match(/^BODY:\s*\r?\n([\s\S]*)$/im);

  const title = titleMatch?.[1]?.trim();
  const body = bodyMatch?.[1]?.trim();

  if (!title || !body) {
    console.error('Unparseable article response from Bedrock:', text.slice(0, 500));
    throw new Error('Bedrock response did not match expected TITLE/TAGS/BODY format');
  }

  // dev.to allows at most 4 tags; sanitize to be safe.
  const tags = (tagsMatch?.[1] || 'serverless, aws')
    .split(',')
    .map(t => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .slice(0, 4);

  return {
    title: title.slice(0, 100),
    body_markdown: body,
    tags: tags.length ? tags : ['serverless', 'aws'],
  };
}

async function getDevToApiKey() {
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: DEVTO_SECRET_ARN }));
  const raw = result.SecretString || '';
  // Support either a raw key string or a JSON object { "apiKey": "..." }.
  try {
    const parsed = JSON.parse(raw);
    return parsed.apiKey || parsed.DEVTO_API_KEY || parsed.key || raw;
  } catch {
    return raw.trim();
  }
}

/** Publishes a draft article to dev.to. Returns { id, url }. */
function publishDraft(apiKey, article) {
  const payload = JSON.stringify({
    article: {
      title: article.title,
      body_markdown: article.body_markdown,
      published: false, // draft only — never auto-publish
      tags: article.tags,
    },
  });

  const options = {
    method: 'POST',
    hostname: 'dev.to',
    path: '/api/articles',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      'User-Agent': 'serverless-radar',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const body = JSON.parse(data);
            resolve({ id: body.id, url: body.url });
          } catch (err) {
            reject(new Error(`Failed to parse dev.to response: ${err.message}`));
          }
        } else {
          reject(new Error(`dev.to API returned HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function saveSummaryRecord(weekStart, article, devto, itemCount) {
  const yearMonth = yearMonthOf(weekStart);
  const dbItem = {
    pk: `summary#weekly#${yearMonth}`,
    sk: `week#${weekStart.toISOString().slice(0, 10)}`,
    title: article.title,
    status: 'draft',
    devtoArticleId: devto.id ?? null,
    devtoUrl: devto.url ?? null,
    tags: article.tags,
    itemCount,
    savedAt: new Date().toISOString(),
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: dbItem,
  }));

  return dbItem;
}

/** Emails a notification via SNS that a dev.to draft was published. */
async function sendPublishNotification(article, devto, itemCount, weekStart, weekEnd) {
  if (!TOPIC_ARN) {
    console.log('TOPIC_ARN not set — skipping email notification');
    return;
  }

  const range = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;
  const subject = `📝 Serverless Radar: weekly dev.to draft ready — ${article.title}`.slice(0, 100);
  const message = [
    `A new weekly serverless summary has been published to dev.to as a DRAFT.`,
    ``,
    `Title: ${article.title}`,
    `Week:  ${range}`,
    `Items summarized: ${itemCount}`,
    `Tags:  ${(article.tags || []).join(', ')}`,
    ``,
    devto.url ? `Review and publish it here: ${devto.url}` : `Draft id: ${devto.id ?? 'unknown'}`,
    ``,
    `Note: the article is a draft and will NOT go live until you publish it on dev.to.`,
  ].join('\n');

  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN,
    Subject: subject,
    Message: message,
  }));
  console.log('Publish notification email sent');
}

export const handler = async () => {
  // Anchor the window end to the scheduled Friday 12:00 UTC (not the exact
  // invocation time), then look back exactly 7 days to the previous Friday noon.
  const now = anchorToFridayNoon(new Date());
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  console.log(`Building weekly summary for ${since.toISOString()} .. ${now.toISOString()}`);

  const items = await collectWeeklyItems(now, since);
  console.log(`Collected ${items.length} item(s) from the last 7 days`);

  if (items.length === 0) {
    console.log('No items this week — skipping article generation');
    return { statusCode: 200, itemCount: 0, published: false };
  }

  const article = await generateArticle(items, since, now);
  console.log(`Generated article: "${article.title}" (tags: ${article.tags.join(', ')})`);

  // Prepend the covered date range so every post states the window it summarizes.
  const dateFmt = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
  const rangeLabel = `${since.toLocaleDateString('en-US', dateFmt)} – ${now.toLocaleDateString('en-US', dateFmt)}`;
  const rangeLine = `*📅 Covering AWS announcements from **${rangeLabel}** (UTC).*`;
  article.body_markdown = `${rangeLine}\n\n${article.body_markdown.trimStart()}`;

  // Append an AI-generated disclaimer so every published post discloses that
  // it was written automatically by an Amazon Bedrock model.
  const disclaimer = [
    '',
    '---',
    '',
    `> 🤖 *This post was automatically generated by AI using Amazon Bedrock (model \`${BEDROCK_MODEL_ID}\`). It summarizes recent AWS announcements and may contain inaccuracies — please verify details against the official AWS sources linked above.*`,
  ].join('\n');
  article.body_markdown = `${article.body_markdown.trimEnd()}\n${disclaimer}\n`;

  const apiKey = await getDevToApiKey();
  if (!apiKey) {
    throw new Error('dev.to API key is empty — check the Secrets Manager secret');
  }

  const devto = await publishDraft(apiKey, article);
  console.log(`Published dev.to draft id=${devto.id} url=${devto.url}`);

  const record = await saveSummaryRecord(since, article, devto, items.length);
  console.log(`Saved summary record ${record.pk} / ${record.sk}`);

  // Notify by email. The draft + record already succeeded, so don't fail the
  // run if the notification can't be sent — just log it.
  try {
    await sendPublishNotification(article, devto, items.length, since, now);
  } catch (err) {
    console.error('Failed to send publish notification:', err.message);
  }

  return {
    statusCode: 200,
    itemCount: items.length,
    title: article.title,
    devtoArticleId: devto.id ?? null,
    devtoUrl: devto.url ?? null,
    published: false,
  };
};
