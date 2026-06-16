import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const TABLE_NAME = process.env.TABLE_NAME;

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
  // Support both direct Function URL and CloudFront /api/items path
  const params = event.queryStringParameters || {};
  const year = params.year || new Date().getUTCFullYear().toString();
  const month = (params.month || String(new Date().getUTCMonth() + 1)).padStart(2, '0');

  const pk = `${year}#${month}`;

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': pk },
    ScanIndexForward: false, // newest first
  }));

  const items = (result.Items ?? []).map(item => ({
    title: item.title,
    pubDate: item.pubDate,
    link: item.sk,
    description: item.description,
    savedAt: item.savedAt,
  }));

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
    }),
  };
};
