# 📡 Serverless Radar

An automated tracker for the AWS What's New RSS feed that filters announcements related to serverless technologies.

## Features

- Fetches the latest announcements directly from the [AWS What's New feed](https://aws.amazon.com/new/feed/)
- Filters content by serverless-related keywords (Lambda, Fargate, Aurora Serverless, and more)
- Zero dependencies — uses Node.js built-in modules only
- Displays title, date, link, and a short preview for each result

## Requirements

- Node.js 18+
- AWS account with CDK bootstrapped
- Route 53 hosted zone (for custom domain)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/nadtakanfuthoem/serverless-radar.git
cd serverless-radar

# Run locally
npm start
```

## Deploy to AWS

```bash
# Copy and fill in your config
cp .env.example .env

# Set environment variables
export DOMAIN_NAME=yourdomain.com
export SUBDOMAIN=serverless-radar.yourdomain.com
export NOTIFICATION_EMAIL=you@example.com

# Deploy (add --profile your-profile if needed)
cd cdk && npm install
cdk bootstrap
cdk deploy --profile your-profile
```

## Example Output

```
Fetching AWS RSS feed...

Total items in feed: 100
Serverless-related items: 8

============================================================

1. Amazon MWAA Serverless now supports Amazon EventBridge notifications
   Date    : Thu, 11 Jun 2026 17:00:00 GMT
   Link    : https://aws.amazon.com/about-aws/whats-new/...
   Preview : Amazon Managed Workflows for Apache Airflow (MWAA) Serverless now supports workflow...
```

## Customization

Add or remove keywords in `index.js` to broaden or narrow the filter:

```js
const SERVERLESS_KEYWORDS = [
  'serverless',
  'lambda',
  'fargate',
  // add your own keywords here
];
```

## 🤖 AI-Powered Analysis

Each new announcement is automatically analyzed by Amazon Bedrock (Claude 3 Haiku) at ingestion time. The analysis includes:

- **Summary** — 2-3 sentence plain-English explanation
- **Who benefits** — target audience for the announcement
- **Why it matters** — relevance for serverless developers
- **Impact score** — 1-10 rating of significance
- **Tags** — auto-categorized (compute, database, security, etc.)

Analysis is stored in DynamoDB alongside each item and displayed as a collapsible section on the frontend. Cost is ~$0.09/month for ~10 items/day.

## 🤖 AI Agent Vision

Serverless Radar is being extended with AI agent capabilities powered by Amazon Bedrock, including:

- **Daily digest summarization** — LLM-generated summaries instead of raw descriptions
- **Relevance scoring** — surface only the most impactful announcements
- **Auto-tagging** — categorize items by topic (`#compute`, `#database`, etc.)
- **Trend detection** — identify patterns across weekly/monthly announcements
- **Slack / Email digest** — polished newsletter delivered on a schedule
- **Q&A over announcements** — ask natural language questions about recent AWS news

See [ROADMAP.md](ROADMAP.md) for the full list of planned features.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © [Nadtakan Futhoem](https://github.com/nadtakanfuthoem)
