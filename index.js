import https from 'https';

const FEED_URL = 'https://aws.amazon.com/new/feed/';

const SERVERLESS_KEYWORDS = [
  'serverless',
  'lambda',
  'fargate',
  'aurora serverless',
  'redshift serverless',
  'emr serverless',
  'opensearch serverless',
];

function fetchFeed(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchFeed(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractTag(block, tag) {
  const match = block.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
  );
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

async function main() {
  console.log('Fetching AWS RSS feed...\n');

  const xml = await fetchFeed(FEED_URL);
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  console.log(`Total items in feed: ${itemBlocks.length}`);

  const results = itemBlocks.filter(block => {
    const text = block.toLowerCase();
    return SERVERLESS_KEYWORDS.some(kw => text.includes(kw));
  });

  console.log(`Serverless-related items: ${results.length}\n`);
  console.log('='.repeat(60));

  results.forEach((block, i) => {
    const title = extractTag(block, 'title');
    const pubDate = extractTag(block, 'pubDate');
    const link = extractTag(block, 'link');
    const description = extractTag(block, 'description')
      .replace(/<[^>]+>/g, '')   // strip HTML tags
      .replace(/\s+/g, ' ')      // collapse whitespace
      .slice(0, 150);             // truncate preview

    console.log(`\n${i + 1}. ${title}`);
    console.log(`   Date    : ${pubDate}`);
    console.log(`   Link    : ${link}`);
    console.log(`   Preview : ${description}...`);
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
