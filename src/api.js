import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME;

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const year = params.year || new Date().getUTCFullYear().toString();
  const month = (params.month || String(new Date().getUTCMonth() + 1)).padStart(2, '0');
  const page = Math.max(parseInt(params.page) || 1, 1);
  const pageSize = Math.min(parseInt(params.pageSize) || 12, 50);
  const source = params.source || 'news'; // "news", "architecture", "compute", "training"

  const prefix = source === 'news' ? '' : `${source}#`;
  const pk = `${prefix}${year}#${month}`;

  // Fetch all items for the month (typically <100 items, safe to fetch all)
  let allItems = [];
  let lastKey = undefined;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey: lastKey,
    }));

    allItems.push(...(result.Items ?? []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // Sort by pubDate newest first
  const sorted = allItems
    .map(item => ({
      title: item.title,
      pubDate: item.pubDate,
      link: item.sk,
      description: (item.description || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
      savedAt: item.savedAt,
      analysis: item.analysis || null,
      skillbuilderLinks: item.skillbuilderLinks || [],
    }))
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Paginate
  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / pageSize);
  const startIndex = (page - 1) * pageSize;
  const items = sorted.slice(startIndex, startIndex + pageSize);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
    },
    body: JSON.stringify({
      month: pk,
      source,
      totalItems,
      totalPages,
      currentPage: page,
      pageSize,
      hasMore: page < totalPages,
      items,
    }),
  };
};
