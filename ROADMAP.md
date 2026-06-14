# 🗺️ Roadmap

This document outlines ideas and planned features for Serverless Radar, including AI agent enhancements.

---

## ✅ Current Features

- Fetch latest announcements from the AWS What's New RSS feed
- Filter by serverless-related keywords
- Log results to CloudWatch via AWS Lambda
- Scheduled daily runs via EventBridge
- Deployed with AWS CDK

---

## 🤖 AI Agent Ideas

### 1. AI-Powered Summarization
Integrate Amazon Bedrock (Claude) to generate a concise daily digest from filtered RSS items. Instead of raw descriptions, produce a human-readable summary like:

> *"Today's top serverless highlights: Lambda adds managed instances in new regions, MWAA Serverless now supports EventBridge notifications, and ECS Fargate expands to 32 vCPU tasks."*

**Services:** Amazon Bedrock, Claude

---

### 2. Relevance Scoring
Ask an AI agent to score each announcement from 1–10 based on its impact for serverless developers. Only surface the most important items above a configurable threshold.

**Services:** Amazon Bedrock

---

### 3. Auto-Categorization & Tagging
Let the agent automatically tag each announcement by topic, e.g. `#compute`, `#database`, `#security`, `#pricing`, `#networking`. Enables filtering and grouping by category.

**Services:** Amazon Bedrock

---

### 4. Trend Detection
Feed the agent a week or month's worth of announcements and ask it to identify patterns and themes, e.g.:

> *"AWS is heavily investing in ECS Managed Instances and Bedrock AgentCore this month."*

**Services:** Amazon Bedrock, Amazon DynamoDB (for historical storage)

---

### 5. Slack / Email Digest
Use an AI agent to write a polished newsletter-style message from the filtered and summarized items, then deliver it automatically via Slack or email on a schedule.

**Services:** Amazon Bedrock, Amazon SES, Slack API

---

### 6. Q&A Over Announcements
Store filtered announcements in a vector store and let users ask natural language questions like:

> *"What Lambda features were released this month?"*
> *"Are there any new Aurora serverless updates?"*

**Services:** Amazon Bedrock Knowledge Bases, Amazon OpenSearch Serverless

---

## 🚀 Suggested Starting Point

The highest-value, lowest-complexity combination to implement first:

1. **Summarization** — Use Bedrock to summarize the daily filtered results
2. **Slack Digest** — Post the summary to a Slack channel automatically

This delivers immediate visible value with minimal infrastructure changes.

---

## 💡 Contributing

Have an idea not listed here? Open an issue or pull request — contributions are welcome!
See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
