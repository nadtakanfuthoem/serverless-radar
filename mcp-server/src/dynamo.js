import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME || 'serverless-radar';
const REGION = process.env.AWS_REGION || 'us-east-1';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Sources map to pk prefixes. "news" is the AWS What's New feed and has no prefix.
export const SOURCES = ['news', 'architecture', 'compute', 'training'];

/** Builds the partition key for an announcement source + month. */
export function announcementPk(source, year, month) {
  const ym = `${year}#${String(month).padStart(2, '0')}`;
  return source === 'news' ? ym : `${source}#${ym}`;
}

/** Builds the partition key for the weekly summary entity. */
export function summaryPk(year, month) {
  return `summary#weekly#${year}#${String(month).padStart(2, '0')}`;
}

/** Decodes the HTML entities / strips tags the feeds leave in descriptions. */
export function cleanText(s) {
  return (s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Queries every item under a partition key, following pagination. */
async function queryAll(pk) {
  const items = [];
  let lastKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Normalizes a stored announcement record into a clean tool-facing shape. */
function toAnnouncement(item, source) {
  return {
    title: item.title,
    link: item.sk,
    pubDate: item.pubDate,
    source,
    description: cleanText(item.description),
    savedAt: item.savedAt,
    analysis: item.analysis || null,
    impactScore: item.analysis?.impactScore ?? null,
    tags: item.analysis?.tags ?? [],
    skillbuilderLinks: item.skillbuilderLinks || [],
  };
}

/**
 * Lists announcements for a given source + month, newest first.
 * year/month default to the current UTC month.
 */
export async function listAnnouncements({ source = 'news', year, month, limit = 25 } = {}) {
  const now = new Date();
  const y = year || now.getUTCFullYear();
  const m = month || now.getUTCMonth() + 1;

  const items = (await queryAll(announcementPk(source, y, m)))
    .map(it => toAnnouncement(it, source))
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  return { source, year: y, month: m, total: items.length, items: items.slice(0, limit) };
}

/** Fetches a single announcement by source + month + link. */
export async function getAnnouncement({ source = 'news', year, month, link }) {
  const now = new Date();
  const y = year || now.getUTCFullYear();
  const m = month || now.getUTCMonth() + 1;

  const res = await ddb.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { pk: announcementPk(source, y, m), sk: link },
  }));
  if (!res.Item) return null;
  return toAnnouncement(res.Item, source);
}

/**
 * Searches announcements across one or more sources and a span of recent
 * months, filtering by keyword, date range, and minimum impact score.
 */
export async function searchAnnouncements({
  keyword,
  sources = ['news', 'architecture', 'compute'],
  monthsBack = 1,
  minImpact,
  since,
  until,
  limit = 25,
} = {}) {
  const now = new Date();
  // Build the list of (year, month) partitions to scan.
  const months = [];
  for (let i = 0; i <= monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }

  const sinceTs = since ? new Date(since).getTime() : null;
  const untilTs = until ? new Date(until).getTime() : null;
  const kw = keyword ? keyword.toLowerCase() : null;

  const results = [];
  const seen = new Set();

  for (const source of sources) {
    for (const { year, month } of months) {
      let items;
      try {
        items = await queryAll(announcementPk(source, year, month));
      } catch {
        continue;
      }
      for (const raw of items) {
        const a = toAnnouncement(raw, source);
        if (seen.has(a.link)) continue;

        const pub = new Date(a.pubDate).getTime();
        if (sinceTs && pub < sinceTs) continue;
        if (untilTs && pub > untilTs) continue;
        if (minImpact != null && (a.impactScore == null || a.impactScore < minImpact)) continue;
        if (kw) {
          const hay = `${a.title} ${a.description} ${(a.tags || []).join(' ')}`.toLowerCase();
          if (!hay.includes(kw)) continue;
        }

        seen.add(a.link);
        results.push(a);
      }
    }
  }

  results.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { total: results.length, items: results.slice(0, limit) };
}

/** Lists the published weekly dev.to summaries for a given month. */
export async function getWeeklySummaries({ year, month, monthsBack = 2 } = {}) {
  const now = new Date();
  const baseY = year || now.getUTCFullYear();
  const baseM = month || now.getUTCMonth() + 1;

  const summaries = [];
  const span = year || month ? 0 : monthsBack; // explicit month => just that month
  for (let i = 0; i <= span; i++) {
    const d = new Date(Date.UTC(baseY, baseM - 1 - i, 1));
    const items = await queryAll(summaryPk(d.getUTCFullYear(), d.getUTCMonth() + 1));
    for (const it of items) {
      summaries.push({
        week: it.sk,
        title: it.title,
        status: it.status,
        devtoUrl: it.devtoUrl ?? null,
        devtoArticleId: it.devtoArticleId ?? null,
        tags: it.tags ?? [],
        itemCount: it.itemCount ?? null,
        savedAt: it.savedAt,
      });
    }
  }

  summaries.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  return { total: summaries.length, summaries };
}

/**
 * Aggregates counts by tag and by source over a span of recent months, to
 * surface trends across the stored announcements.
 */
export async function getTrends({ sources = ['news', 'architecture', 'compute'], monthsBack = 1 } = {}) {
  const now = new Date();
  const months = [];
  for (let i = 0; i <= monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }

  const byTag = {};
  const bySource = {};
  let total = 0;

  for (const source of sources) {
    for (const { year, month } of months) {
      let items;
      try {
        items = await queryAll(announcementPk(source, year, month));
      } catch {
        continue;
      }
      bySource[source] = (bySource[source] || 0) + items.length;
      total += items.length;
      for (const it of items) {
        for (const tag of it.analysis?.tags ?? []) {
          byTag[tag] = (byTag[tag] || 0) + 1;
        }
      }
    }
  }

  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  return { total, monthsScanned: monthsBack + 1, bySource, topTags };
}
