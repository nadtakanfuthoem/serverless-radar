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
    const summary = it.analysis?.summary ? ` — ${it.analysis.summary}` : ` — ${it.description}`;
    return `${i + 1}. (${it.source}) ${it.title}${summary}\n   Read more: ${it.link}`;
  }).join('\n');

  const range = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;

  // Note: we deliberately do NOT ask for JSON here. Multi-line Markdown packed
  // into a JSON string field routinely produces invalid JSON (unescaped
  // newlines/tabs), which breaks JSON.parse. Instead we use line delimiters
  // that are immune to whatever control characters appear in the body.
  const prompt = `You are an AWS serverless expert writing a weekly roundup blog post for dev.to.

Below are ALL ${items.length} AWS serverless-related announcements from the week of ${range}. Write an engaging, well-structured article in Markdown that summarizes them for serverless developers.

Announcements:
${itemLines}

Requirements:
- Cover EVERY announcement in the list above — do not skip any. Each one must be summarized somewhere in the article.
- Open with a short intro paragraph setting the theme for the week.
- Group related announcements under H2 (##) section headings and explain why they matter for serverless developers.
- Reference each announcement with a descriptive Markdown link (e.g. link the announcement's name or a "Read more" phrase), never a bare pasted URL.
- Close with a brief "What this means" takeaway.
- Use a friendly, professional tone.

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
      inferenceConfig: { maxTokens: 5000 },
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

// Friendly headings for each feed source in the New Releases section.
const SOURCE_LABELS = {
  news: "What's New",
  architecture: 'Architecture Blog',
  compute: 'Compute Blog',
};

/**
 * Builds the "New Releases" Markdown section from the in-window items that the
 * AI did NOT already link in its article prose. This keeps the completeness
 * guarantee (every item appears either in the prose or here) while avoiding
 * duplicate links. Items are grouped by source, newest first.
 *
 * Returns '' when every item was already covered in the prose, so the section
 * is omitted entirely.
 */
function buildReleasesSection(items, weekStart, weekEnd, articleBody = '') {
  // Only include items whose link does not already appear in the article body.
  const remaining = items.filter(it => it.link && !articleBody.includes(it.link));
  if (remaining.length === 0) return '';

  const range = `${weekStart.toISOString().slice(0, 10)} – ${weekEnd.toISOString().slice(0, 10)}`;
  const lines = ['', '---', '', '## 📦 New Releases This Week', '', `*Additional announcement(s) from ${range} (UTC) not covered above:*`, ''];

  // Stable source order; include only sources that have remaining items.
  const order = ['news', 'architecture', 'compute'];
  const bySource = new Map(order.map(s => [s, []]));
  for (const it of remaining) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }

  for (const source of bySource.keys()) {
    const group = bySource.get(source);
    if (!group.length) continue;

    // Newest first within the group.
    group.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    const label = SOURCE_LABELS[source] || source;
    lines.push(`### ${label}`, '');
    for (const it of group) {
      const title = (it.title || 'Untitled').replace(/\s+/g, ' ').trim();
      lines.push(`- [${title}](${it.link})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
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

/**
 * Resolves the [since, now] window to summarize.
 *
 * Default (no event / scheduled run): the window END is anchored to the most
 * recent Friday 12:00 UTC and START is exactly 7 days earlier.
 *
 * Overrides (for re-running a specific past week) via the Lambda event:
 *   { "weekEnd": "2026-10-02T12:00:00Z" }
 *       -> uses that instant as the window end, 7 days back for the start.
 *   { "since": "2026-09-25T12:00:00Z", "until": "2026-10-02T12:00:00Z" }
 *       -> uses an explicit custom window (any length).
 */
function resolveWindow(event = {}) {
  const parse = (v, label) => {
    const d = new Date(v);
    if (isNaN(d.getTime())) throw new Error(`Invalid ${label} in event: "${v}"`);
    return d;
  };

  if (event.since || event.until) {
    if (!event.since || !event.until) {
      throw new Error('Provide BOTH "since" and "until" for a custom window, or neither.');
    }
    const since = parse(event.since, 'since');
    const now = parse(event.until, 'until');
    if (since >= now) throw new Error('"since" must be before "until".');
    return { since, now, overridden: true };
  }

  if (event.weekEnd) {
    const now = parse(event.weekEnd, 'weekEnd');
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { since, now, overridden: true };
  }

  // Default: anchor to Friday noon UTC, 7-day lookback.
  const now = anchorToFridayNoon(new Date());
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { since, now, overridden: false };
}

export const handler = async (event = {}) => {
  const { since, now, overridden } = resolveWindow(event);
  console.log(
    `Building weekly summary for ${since.toISOString()} .. ${now.toISOString()}` +
    (overridden ? ' (window overridden via event)' : ' (default Friday-noon window)')
  );

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

  // Append a "New Releases" section listing any in-window items the AI did not
  // already link in its prose, so every item is covered without duplicate links.
  const releases = buildReleasesSection(items, since, now, article.body_markdown);
  if (releases) {
    article.body_markdown = `${article.body_markdown.trimEnd()}\n\n${releases}`;
  }

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
