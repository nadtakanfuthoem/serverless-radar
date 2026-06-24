# 📡 Serverless Radar

An automated tracker that monitors multiple AWS RSS feeds, filters content related to serverless, AI, and cloud technologies, and provides AI-powered analysis to help you think about how new features fit into your existing architecture.

**Live:** [serverless-radar.nadtakanfuthoem.com](https://serverless-radar.nadtakanfuthoem.com)

## Features

- **Multi-source feeds** — aggregates from 4 AWS RSS sources
- **Keyword filtering** — surfaces only serverless, AI, and cloud content
- **AI analysis** — each item is analyzed by Amazon Bedrock (Nova Lite) with summary, impact score, and a thought-provoking question
- **Email notifications** — SNS alerts when new items are detected
- **Deduplication** — items are never stored or emailed twice
- **Dark/Light theme** — toggle with persistent preference
- **Pagination** — browse items sorted newest first
- **Course links** — training posts surface Skill Builder links

## Data Sources

| Source | Feed URL | Dropdown Label |
|--------|----------|----------------|
| AWS What's New | `aws.amazon.com/new/feed/` | 📢 AWS News |
| Architecture Blog | `aws.amazon.com/blogs/architecture/feed/` | 🏗️ Architecture Blog |
| Compute Blog | `aws.amazon.com/blogs/compute/feed/` | ⚡ Compute Blog |
| Training & Certification | `aws.amazon.com/blogs/training-and-certification/feed/` | 🎓 Training & Courses |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  EventBridge (9 AM / 9 PM UTC)                          │
│    ├── serverless-radar         → News, Arch, Compute   │
│    └── serverless-radar-training → Training blog        │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  Lambda (fetch + filter + AI analysis)                   │
│    ├── Fetch RSS feeds                                   │
│    ├── Filter by serverless/AI keywords                  │
│    ├── Deduplicate against DynamoDB                      │
│    ├── Analyze with Amazon Bedrock (Nova Lite)           │
│    ├── Save to DynamoDB                                  │
│    └── Notify via SNS (email)                            │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  DynamoDB (serverless-radar)                             │
│    pk: source#year#month    sk: link URL                 │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  API Lambda (serverless-radar-api)                       │
│    GET /api/items?source=news&year=2026&month=06&page=1  │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│  CloudFront → S3 (static site)                           │
│  Route 53 → serverless-radar.nadtakanfuthoem.com         │
└─────────────────────────────────────────────────────────┘
```

## DynamoDB Schema

| Field | Type | Description |
|-------|------|-------------|
| `pk` | String (Partition Key) | `{source}#{year}#{month}` e.g. `compute#2026#06` or `2026#06` for news |
| `sk` | String (Sort Key) | Link URL (unique identifier) |
| `title` | String | Announcement title |
| `pubDate` | String | Publication date |
| `description` | String | Cleaned description (max 300 chars) |
| `analysis` | Map | AI analysis (summary, whoBenefits, whyItMatters, impactScore, tags, thoughtQuestion) |
| `skillbuilderLinks` | List | Skill Builder URLs (training items only) |
| `savedAt` | String | ISO timestamp when saved |
| `ttl` | Number | Auto-expire after 1 year |

**Partition key patterns:**

```
AWS News:        pk = "2026#06"
Architecture:    pk = "architecture#2026#06"
Compute:         pk = "compute#2026#06"
Training:        pk = "training#2026#06"
```

## API

```
GET /api/items?source=news&year=2026&month=06&page=1&pageSize=12
```

| Param | Default | Options |
|-------|---------|---------|
| `source` | `news` | `news`, `architecture`, `compute`, `training` |
| `year` | current year | any year |
| `month` | current month | `01`–`12` |
| `page` | `1` | page number |
| `pageSize` | `12` | max `50` |

## 🤖 AI-Powered Analysis

Each new item is analyzed by Amazon Bedrock (Nova Lite) at ingestion time:

- **Summary** — 2-3 sentence plain-English explanation
- **Who benefits** — target audience
- **Why it matters** — relevance for serverless developers
- **Impact score** — 1-10 rating
- **Tags** — auto-categorized (compute, database, security, etc.)
- **Thought question** — a question to spark reflection on how this fits your work

Displayed as a popup modal on the frontend. Cost: ~$0.09/month.

## Requirements

- Node.js 18+
- AWS account with CDK bootstrapped
- Route 53 hosted zone (for custom domain)
- Amazon Bedrock model access enabled (Nova Lite)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/nadtakanfuthoem/serverless-radar.git
cd serverless-radar

# Run locally (fetches feed and prints to console)
npm start
```

## Deploy to AWS

```bash
# Copy and fill in your config
cp .env.example .env

# Install and deploy
cd cdk && npm install
cdk bootstrap --profile your-profile
cdk deploy --profile your-profile
```

## Environment Variables (.env)

```bash
AWS_PROFILE=your-profile
DOMAIN_NAME=yourdomain.com
SUBDOMAIN=serverless-radar.yourdomain.com
NOTIFICATION_EMAIL=you@example.com
```

## Filter Keywords

Items are included if they match any of these keywords in title or description:

```
serverless, lambda, fargate, aurora serverless, redshift serverless,
opensearch serverless, bedrock, step functions, dynamodb, kiro,
agentcore, api gateway, sqs, sns, cognito
```

Edit `src/handler.js` or `src/training-handler.js` to customize.

## Cost Estimate

| Service | Monthly Cost |
|---------|-------------|
| Lambda (2 functions × 2 runs/day) | Free tier |
| DynamoDB (on-demand) | ~$0.01 |
| Bedrock Nova Lite (~10 items/day) | ~$0.09 |
| CloudFront + S3 | ~$0.05 |
| SNS email | Free |
| **Total** | **~$0.15/month** |

## Documentation

- [ROADMAP.md](ROADMAP.md) — planned features and AI agent ideas
- [DECISIONS.md](DECISIONS.md) — architecture decision records
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guidelines

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © [Nadtakan Futhoem](https://github.com/nadtakanfuthoem)
