# 📡 Serverless Radar

An automated tracker for the AWS What's New RSS feed that filters announcements related to serverless technologies.

## Features

- Fetches the latest announcements directly from the [AWS What's New feed](https://aws.amazon.com/new/feed/)
- Filters content by serverless-related keywords (Lambda, Fargate, Aurora Serverless, and more)
- Zero dependencies — uses Node.js built-in modules only
- Displays title, date, link, and a short preview for each result

## Requirements

- Node.js 18+

## Getting Started

```bash
# Clone the repo
git clone https://github.com/your-username/serverless-radar.git
cd serverless-radar

# Run
npm start
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

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT © [Nadtakan Futhoem](https://github.com/your-username)
