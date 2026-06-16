import https from 'https';
import http from 'http';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const FEED_URL = 'https://aws.amazon.com/new/feed/';
const TABLE_NAME = process.env.TABLE_NAME;
const TOPIC_ARN = process.env.TOPIC_ARN;

const SERVERLESS_KEYWORDS = [
  'serverless',
  'lambda',
  'fargate',
  'aurora serverless',
  'redshift serverless',
  'emr serverless',
  'opensearch serverless',
];

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const sns = new SNSClient({});

function fetchFeed(url) {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect with no location header'));
        const redirectUrl = location.startsWith('http') ? location : new URL(location, url).href;
        return fetchFeed(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractTag(block, tag) {
  const match = block.match(
    new RegExp(
      `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`
    )
  );
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function getYearMonth(dateStr) {
  const date = new Date(dateStr);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}#${month}`;
}

async function getExistingLinks(yearMonth) {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': yearMonth },
    ProjectionExpression: 'sk',
  }));
  return new Set((result.Items ?? []).map(item => item.sk));
}

async function saveItem(item) {
  const yearMonth = getYearMonth(item.pubDate);
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      pk: yearMonth,          // partition key: "2026#06"
      sk: item.link,          // sort key: unique link URL (prevents duplicates)
      title: item.title,
      pubDate: item.pubDate,
      description: item.description,
      savedAt: new Date().toISOString(),
      ttl,
    },
    ConditionExpression: 'attribute_not_exists(sk)', // skip if already exists
  }));
}

function buildEmailBody(items, date) {
  const header = `📡 Serverless Radar — ${date.toISOString().slice(0, 10)}\n`;
  const separator = '='.repeat(50);
  const summary = `Found ${items.length} NEW serverless announcement(s):\n`;

  const itemList = items.map((item, i) =>
    `${i + 1}. ${item.title}\n   ${item.pubDate}\n   ${item.link}\n`
  ).join('\n');

  return `${header}${separator}\n\n${summary}\n${itemList}\n${separator}\n\nVisit your Serverless Radar dashboard for details.`;
}

async function sendNotification(items, date) {
  const subject = `📡 Serverless Radar: ${items.length} new item(s) — ${date.toISOString().slice(0, 10)}`;
  const message = buildEmailBody(items, date);

  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN,
    Subject: subject,
    Message: message,
  }));
  console.log('Email notification sent');
}

export const handler = async () => {
  console.log('Fetching AWS RSS feed...');

  const now = new Date();
  const xml = await fetchFeed(FEED_URL);
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  console.log(`Total items in feed: ${itemBlocks.length}`);

  const items = itemBlocks
    .filter(block => {
      const text = block.toLowerCase();
      return SERVERLESS_KEYWORDS.some(kw => text.includes(kw));
    })
    .map(block => ({
      title: extractTag(block, 'title'),
      pubDate: extractTag(block, 'pubDate'),
      link: extractTag(block, 'link'),
      description: extractTag(block, 'description')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300),
    }));

  console.log(`Serverless-related items found: ${items.length}`);

  // Get existing links for the current month to detect new items
  const currentMonth = getYearMonth(now.toISOString());
  const existingLinks = await getExistingLinks(currentMonth);

  // Save each item individually, skip duplicates
  const newItems = [];
  for (const item of items) {
    if (existingLinks.has(item.link)) {
      console.log(`Skipping duplicate: ${item.title}`);
      continue;
    }

    try {
      await saveItem(item);
      newItems.push(item);
      console.log(`Saved: ${item.title}`);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.log(`Skipping duplicate: ${item.title}`);
      } else {
        throw err;
      }
    }
  }

  console.log(`New items saved: ${newItems.length}`);

  // Send email only for NEW items (not previously seen)
  if (newItems.length > 0) {
    await sendNotification(newItems, now);
  } else {
    console.log('No new items — skipping email notification');
  }

  return {
    statusCode: 200,
    totalFiltered: items.length,
    newItems: newItems.length,
    duplicatesSkipped: items.length - newItems.length,
  };
};
