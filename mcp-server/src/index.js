#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  SOURCES,
  listAnnouncements,
  getAnnouncement,
  searchAnnouncements,
  getWeeklySummaries,
  getTrends,
} from './dynamo.js';

const server = new McpServer({
  name: 'serverless-radar',
  version: '1.0.0',
});

/** Wraps a result object as MCP tool content (pretty JSON text). */
function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Wraps a handler so thrown errors become MCP tool errors instead of crashing. */
function safe(handler) {
  return async (args) => {
    try {
      const data = await handler(args);
      return jsonResult(data);
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
      };
    }
  };
}

const sourceEnum = z.enum(SOURCES);

server.tool(
  'list_announcements',
  'List stored AWS serverless announcements for a given source and month (newest first). Defaults to the current UTC month and the "news" feed.',
  {
    source: sourceEnum.default('news').describe('Which feed: news, architecture, compute, or training'),
    year: z.number().int().optional().describe('Four-digit year, e.g. 2026. Defaults to current UTC year.'),
    month: z.number().int().min(1).max(12).optional().describe('Month 1-12. Defaults to current UTC month.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Max items to return.'),
  },
  safe((args) => listAnnouncements(args)),
);

server.tool(
  'get_announcement',
  'Fetch a single announcement by its link URL within a source and month.',
  {
    link: z.string().url().describe('The announcement link (sort key).'),
    source: sourceEnum.default('news').describe('Which feed the announcement belongs to.'),
    year: z.number().int().optional().describe('Four-digit year. Defaults to current UTC year.'),
    month: z.number().int().min(1).max(12).optional().describe('Month 1-12. Defaults to current UTC month.'),
  },
  safe(async (args) => {
    const item = await getAnnouncement(args);
    return item ?? { found: false, message: 'No announcement with that link in the given source/month.' };
  }),
);

server.tool(
  'search_announcements',
  'Search announcements across sources and recent months by keyword, date range, and minimum impact score (1-10). Keyword matches title, description, and tags.',
  {
    keyword: z.string().optional().describe('Case-insensitive substring to match in title/description/tags.'),
    sources: z.array(sourceEnum).optional().describe('Sources to search. Defaults to news, architecture, compute.'),
    monthsBack: z.number().int().min(0).max(12).default(1).describe('How many months before the current one to include (0 = current month only).'),
    minImpact: z.number().int().min(1).max(10).optional().describe('Only return items whose AI impact score is at least this value.'),
    since: z.string().optional().describe('ISO date; only items published on/after this.'),
    until: z.string().optional().describe('ISO date; only items published on/before this.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Max items to return.'),
  },
  safe((args) => searchAnnouncements(args)),
);

server.tool(
  'get_weekly_summaries',
  'List the weekly dev.to digest posts that have been generated, including their status and article links.',
  {
    year: z.number().int().optional().describe('Four-digit year. Defaults to current UTC year.'),
    month: z.number().int().min(1).max(12).optional().describe('Month 1-12. If omitted, scans the last few months.'),
    monthsBack: z.number().int().min(0).max(12).default(2).describe('When no explicit month is given, how many prior months to include.'),
  },
  safe((args) => getWeeklySummaries(args)),
);

server.tool(
  'get_trends',
  'Aggregate announcement counts by tag and by source over recent months to surface trends.',
  {
    sources: z.array(sourceEnum).optional().describe('Sources to include. Defaults to news, architecture, compute.'),
    monthsBack: z.number().int().min(0).max(12).default(1).describe('How many months before the current one to include.'),
  },
  safe((args) => getTrends(args)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: do NOT write to stdout — stdio transport uses it for the protocol.
  console.error('serverless-radar MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
