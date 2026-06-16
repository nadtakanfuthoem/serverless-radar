import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME;
const DEFAULT_PAGE_SIZE = 10;

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const year = params.year || new Date().getUTCFullYear().toString();
  const month = (params.month || String(new Date().getUTCMonth() + 1)).padStart(2, '0');
  const limit = Math.min(parseInt(params.limit) || DEFAULT_PAGE_SIZE, 50);
  const cursor = params.cursor || null; // base64-encoded lastEvaluatedKey

  const pk = `${year}#${month}`;

  const queryParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': pk },
    ScanIndexForward: false, // newest first
    Limit: limit,
  };

  // If cursor is provided, decode it and use as ExclusiveStartKey
  if (cursor) {
    try {
      queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64').toString());
    } catch (e) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Invalid cursor' }),
      };
    }
  }

  const result = await ddb.send(new QueryCommand(queryParams));

  const items = (result.Items ?? []).map(item => ({
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
  }));

  // Encode the next cursor if there are more results
  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : null;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
    },
    body: JSON.stringify({
      month: pk,
      itemsFound: items.length,
      items,
      nextCursor,
      hasMore: !!nextCursor,
    }),
  };
};
