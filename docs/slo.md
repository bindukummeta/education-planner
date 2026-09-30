# Initial service levels

Status: **definition only**. These targets are the first error budgets for a beta. They are not a measurement of a live launch. `node scripts/slo.js` prints each target, its p95, and the 28-day error budget in minutes. It does not query a provider.

Source: [`ops/slo.json`](../ops/slo.json).

| Surface | Success | p95 | 28-day error budget |
| --- | --- | --- | --- |
| Static shell | 99.5% | 800 ms | 201.6 minutes |
| Readiness | 99.9% | 500 ms | 40.32 minutes |
| Coach | 99% | 8 s | 403.2 minutes |
| Practice | 99% | 20 s | 403.2 minutes |
| Homework analysis | 99% | 120 s | 403.2 minutes |
| Sync | 99% | 3 s | 403.2 minutes |

Success for the API routes is `outcome = ok` divided by the budget outcomes `ok`, `timeout`, `upstream_error`, `internal`, `quota_unavailable`, and `not_configured`. Sign-in failures, bad bodies, quota denials, and `not_admitted` are outside the budget. The static shell is `GET /` with HTTP 200 and the title `Education Planner`. Sync is authenticated owner-scoped records and blob calls with status below 500. The queries in the JSON file are what an operator runs in Vercel or Supabase. Do not include prompts, images, or row bodies.

The page alerts in [`ops/alerts.json`](../ops/alerts.json) are faster signals. They do not replace the 28-day budget.
