import https from 'https';
import http from 'http';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const FEED_URL = 'https://aws.amazon.com/blogs/training-and-certification/feed/';
const TABLE_NAME = process.env.TABLE_NAME;

const SERVERLESS_KEYWORDS = [
  'serverless',
  'lambda',
  'fargate',
  'bedrock',
  'ai',
  'artificial intelligence',
  'generative ai',
  'machine learning',
  'foundation model',
  'sagemaker',
  'step functions',
  'dynamodb',
  'api gateway',
];

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

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

function extractContentEncoded(block) {
  const match = block.match(
    /<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/
  );
  return (match?.[1] ?? '').trim();
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
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  const dbItem = {
    pk: `training#${yearMonth}`,
    sk: item.link,
    title: item.title,
    pubDate: item.pubDate,
    description: item.description,
    skillbuilderLinks: item.skillbuilderLinks || [],
    savedAt: new Date().toISOString(),
    ttl,
  };

  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: dbItem,
    ConditionExpression: 'attribute_not_exists(sk)',
  }));
}

export const handler = async () => {
  console.log('Fetching AWS Training & Certification RSS feed...');

  const now = new Date();
  const xml = await fetchFeed(FEED_URL);
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  console.log(`Total items in feed: ${itemBlocks.length}`);

  // For training blog, filter for bedrock, AI, and serverless content only
  const items = itemBlocks
    .map(block => {
      const rawDescription = extractTag(block, 'description');
      const rawContent = extractContentEncoded(block);
      const fullRaw = rawDescription + ' ' + rawContent;

      // Decode full content for keyword search and link extraction
      const decoded = fullRaw
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');

      // Extract skillbuilder links from the full content
      const skillbuilderLinks = [];
      const linkRegex = /href=["'](https:\/\/skillbuilder\.aws[^"']*?)["']/g;
      let match;
      while ((match = linkRegex.exec(decoded)) !== null) {
        if (!skillbuilderLinks.includes(match[1])) {
          skillbuilderLinks.push(match[1]);
        }
      }

      // Plain text version of full content for keyword matching
      const fullText = decoded
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const description = rawDescription
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

      return {
        title: extractTag(block, 'title'),
        pubDate: extractTag(block, 'pubDate'),
        link: extractTag(block, 'link'),
        description,
        skillbuilderLinks,
        _fullText: fullText, // used for filtering, not stored
      };
    })
    .filter(item => {
      const text = `${item.title} ${item._fullText}`.toLowerCase();
      return SERVERLESS_KEYWORDS.some(kw => text.includes(kw));
    })
    .map(({ _fullText, ...item }) => item); // remove _fullText before saving

  console.log(`Training items found: ${items.length}`);

  // Get existing links for deduplication
  const currentMonth = `training#${getYearMonth(now.toISOString())}`;
  const existingResult = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': currentMonth },
    ProjectionExpression: 'sk',
  }));
  const existingLinks = new Set((existingResult.Items ?? []).map(item => item.sk));

  const newItems = [];
  for (const item of items) {
    if (existingLinks.has(item.link)) {
      console.log(`Skipping duplicate: ${item.title}`);
      continue;
    }

    try {
      await saveItem(item);
      newItems.push(item);
      console.log(`Saved: ${item.title} (${item.skillbuilderLinks.length} skillbuilder links)`);
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        console.log(`Skipping duplicate: ${item.title}`);
      } else {
        throw err;
      }
    }
  }

  console.log(`New training items saved: ${newItems.length}`);

  return {
    statusCode: 200,
    totalInFeed: items.length,
    newItems: newItems.length,
    duplicatesSkipped: items.length - newItems.length,
  };
};
