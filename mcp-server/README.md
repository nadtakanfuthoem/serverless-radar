# Serverless Radar — MCP Server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Serverless Radar DynamoDB table (`serverless-radar`) as tools, so any MCP-aware AI client
(Kiro, Claude Desktop, Cursor, etc.) can query and reason over the stored AWS serverless
announcements and weekly dev.to summaries in natural language.

It runs locally over **stdio** and uses your own AWS credentials — nothing is hosted or
exposed to the network.

## Tools

| Tool | Description |
|------|-------------|
| `list_announcements` | List announcements for a source + month (newest first). Defaults to current UTC month and the `news` feed. |
| `get_announcement` | Fetch a single announcement by its link URL. |
| `search_announcements` | Search across sources and recent months by keyword, date range, and minimum AI impact score (1–10). |
| `get_weekly_summaries` | List the weekly dev.to digest posts, with status and article links. |
| `get_trends` | Aggregate announcement counts by tag and source over recent months. |

Sources: `news`, `architecture`, `compute`, `training`.

## Setup

```bash
cd mcp-server
npm install
```

## Configuration (environment)

| Variable | Default | Purpose |
|----------|---------|---------|
| `TABLE_NAME` | `serverless-radar` | DynamoDB table to read. |
| `AWS_REGION` | `us-east-1` | Region of the table. |
| `AWS_PROFILE` | — | AWS profile providing read credentials (e.g. `dev-nadtakan`). |

The server only needs **read** access to the table (`dynamodb:Query`, `dynamodb:GetItem`).

## Run it directly

```bash
AWS_PROFILE=dev-nadtakan npm start
```

(It prints `serverless-radar MCP server running on stdio` to stderr and then waits for an
MCP client to connect over stdio.)

## Register with an MCP client

### Kiro (workspace-level)

Add to `.kiro/settings/mcp.json` in this workspace:

```json
{
  "mcpServers": {
    "serverless-radar": {
      "command": "node",
      "args": ["mcp-server/src/index.js"],
      "env": {
        "AWS_PROFILE": "dev-nadtakan",
        "AWS_REGION": "us-east-1",
        "TABLE_NAME": "serverless-radar"
      },
      "disabled": false,
      "autoApprove": ["list_announcements", "get_announcement", "search_announcements", "get_weekly_summaries", "get_trends"]
    }
  }
}
```

> Use an absolute path in `args` (e.g. `/Users/you/.../mcp-server/src/index.js`) if your
> client does not resolve relative to the workspace root.

### Claude Desktop

Add the same `serverless-radar` block to the `mcpServers` object in
`claude_desktop_config.json`, using an absolute path in `args`.

## Try it

Once registered, ask your assistant things like:

- *"List this month's high-impact Lambda announcements."*
- *"Search serverless-radar for anything about Aurora in the last 3 months."*
- *"What tags are trending across the compute and news feeds?"*
- *"Show me the weekly dev.to summaries that have been published."*

## Debugging

Run the MCP Inspector to exercise the tools interactively:

```bash
AWS_PROFILE=dev-nadtakan npm run inspect
```

## Notes

- Reads only; it never writes to the table.
- Dependencies are isolated here (`mcp-server/node_modules`) and separate from the Lambda
  code in `../src`, which relies on the AWS SDK bundled in the Lambda runtime.
- The AWS SDK v3 will require Node ≥ 22 after January 2027; this server runs on Node ≥ 18
  today but upgrading your local Node to 22+ is recommended.
