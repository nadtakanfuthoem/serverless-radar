import https from 'https';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const FEED_URL = 'https://aws.amazon.com/new/feed/';
const BUCKET_NAME = process.env.BUCKET_NAME;
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

const s3 = new S3Client({});
const sns = new SNSClient({});

function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchFeed(res.headers.location).then(resolve).catch(reject);
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

function getS3Key(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `data/${year}/${month}/${year}-${month}-${day}.json`;
}

async function saveToS3(key, payload) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(payload, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));
  console.log(`Saved to s3://${BUCKET_NAME}/${key}`);
}

function buildEmailBody(items, date) {
  const header = `📡 Serverless Radar — ${date.toISOString().slice(0, 10)}\n`;
  const separator = '='.repeat(50);
  const summary = `Found ${items.length} serverless announcement(s) today:\n`;

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
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 300),
    }));

  console.log(`Serverless-related items found: ${items.length}`);

  const payload = {
    generatedAt: now.toISOString(),
    itemsFound: items.length,
    items,
  };

  // Save to S3
  const s3Key = getS3Key(now);
  await saveToS3(s3Key, payload);

  // Send email notification only if items were found
  if (items.length > 0) {
    await sendNotification(items, now);
  } else {
    console.log('No serverless items found — skipping email notification');
  }

  return {
    statusCode: 200,
    s3Key,
    itemsFound: items.length,
  };
};
