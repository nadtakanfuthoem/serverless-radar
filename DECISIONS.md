# 📝 Architecture Decision Records

This document captures key technical decisions made during the development of Serverless Radar.

Format follows the [Architecture Decision Records (ADR)](https://adr.github.io/) pattern.

---

## ADR-001: Switch from S3 to DynamoDB for data storage

**Date:** 2026-06-15

**Status:** Accepted

**Context:**
Initially, filtered RSS results were stored as daily JSON files in S3 at `data/YYYY/MM/YYYY-MM-DD.json`. The frontend fetched these files directly. While simple, this approach had limitations:
- Overwriting the same file twice a day means the second run replaces the first run's data
- No built-in deduplication — the same announcement appears if the feed hasn't changed
- Querying across days or months requires fetching multiple files
- No TTL or lifecycle management built-in

**Decision:**
Store each announcement as an individual DynamoDB item, keyed by:
- `pk` (partition key): `YYYY#MM` — enables querying all items for a given month
- `sk` (sort key): announcement link URL — serves as a natural unique ID

**Consequences:**
- Deduplication is free — writing the same link URL is an idempotent overwrite or a conditional no-op
- Querying by month is a single DynamoDB Query
- TTL auto-cleans old data (set to 1 year)
- Pay-per-request billing means zero cost when idle
- Frontend will need an API (Lambda + API Gateway) to query DynamoDB instead of fetching static files

---

## ADR-002: Deduplication strategy — Pre-check vs Write-anyway

**Date:** 2026-06-15

**Status:** Accepted (write-anyway with conditional expression)

**Context:**
Since the Lambda runs twice daily, the same announcements will appear in both runs. We need to avoid storing duplicates and avoid sending duplicate email notifications.

Two approaches were evaluated:

### Option A: Pre-check then write
```
1. Query DynamoDB for all existing links in the current month
2. Compare filtered items against existing links
3. Only write truly new items
```

### Option B: Write anyway with conditional expression
```
1. PutItem with ConditionExpression: 'attribute_not_exists(sk)'
2. If the item already exists, DynamoDB rejects it (ConditionalCheckFailedException)
3. Catch the error and skip
```

### Cost comparison

DynamoDB on-demand pricing:
- Read: $0.25 per million RRUs
- Write: $1.25 per million WRUs
- Failed conditional write: still costs 1 WRU

Assuming 8 filtered items per run, 6 are duplicates, 2 are new:

| | Pre-check (A) | Write-anyway (B) |
|--|---------------|------------------|
| API calls | 1 Query + 2 Put | 8 Put (6 fail) |
| Cost per run | ~$0.000003 | ~$0.000010 |
| Cost per month (60 runs) | ~$0.00017 | ~$0.0006 |
| Code complexity | Higher (query + filter + write) | Lower (write + catch) |
| Race conditions | Possible (check-then-write gap) | Impossible (atomic condition) |

### Verdict

Both are effectively free at this scale (< $0.001/month). However:
- **Write-anyway (B) is simpler** — fewer lines of code, one DynamoDB call per item
- **Write-anyway (B) is race-safe** — the conditional expression is atomic, so two concurrent Lambda invocations can't create duplicates
- **Pre-check (A) has a TOCTOU gap** — between the query and the write, another invocation could insert the same item

**Decision:**
Use a hybrid approach for maximum clarity:
1. Pre-check with a Query (avoids unnecessary PutItem calls and reduces log noise)
2. Conditional write as a safety net (catches any race conditions)

This costs marginally more than pure write-anyway but provides cleaner logs and fewer unnecessary API calls.

---

## ADR-003: Email notifications only for new items

**Date:** 2026-06-15

**Status:** Accepted

**Context:**
The Lambda runs twice daily. Without deduplication awareness in the notification logic, users would receive the same announcements in both the morning and evening emails.

**Decision:**
Only send SNS email notifications for items that are genuinely new (not previously stored in DynamoDB). This is determined by the deduplication logic — only items that pass both the pre-check and the conditional write are considered "new."

**Consequences:**
- Morning run: notifies about all serverless items from overnight
- Evening run: only notifies about items published since the morning run
- If no new items are found, no email is sent
