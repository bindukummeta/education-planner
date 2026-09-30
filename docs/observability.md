# Observability

Production signals for the static app, the serverless routes, Supabase, and Anthropic. Logs are one JSON object per outcome. They are safe to retain only because the allowlist drops everything else.

## External activation gate

Status: **blocked**. This repository cannot create Vercel, Supabase, or Anthropic dashboards, and it cannot set the GitHub Actions secret. `ops/alerts.json` is the definition to apply by hand. A scheduled Synthetic run stays red until `SYNTHETIC_BASE_URL` exists. Do not treat either artifact as live monitoring.

Activation, in order:

1. Apply every signal in [`ops/alerts.json`](../ops/alerts.json). Each object has the provider, window, comparator, threshold, query, and the console steps.
2. Create the GitHub repository secret `SYNTHETIC_BASE_URL` as the production `https` origin, with no path credentials, query, or hash.
3. Run the Synthetic workflow once from the Actions tab. It must print `{"ok":true,...}` and it must not call Anthropic.

Until those steps are done, the only checked behavior is the local test suite.

## Logs and request ids

`api/security.js` `writeLog` is the only logger. `coach`, `generate-practice`, `analyse-homework`, `ready`, `client-report`, `account-export`, and `account-delete` use it. Each response sets `x-request-id` (16 hex characters). A log line looks like:

```json
{"ts":"2026-09-30T12:00:00.000Z","requestId":"0123456789abcdef","endpoint":"ready","outcome":"ok","httpStatus":200,"durationMs":4}
```

Kept fields: `ts`, `requestId`, `endpoint`, `outcome`, `httpStatus`, `durationMs`, `userHash`, `ipHash`, `providerStatus`, `providerType`, `stopReason`, `missing`, `errorName`, `releaseFailed`, `source`, `kind`, `line`, `column`, `recordCount`, `blobCount`. Account export and deletion may include the two counts. They do not include row bodies, image bytes, or the confirmation phrase. Host logs are safe to keep for 7 days. This repository cannot set that retention in Vercel; see [`docs/retention-deletion-runbook.md`](retention-deletion-runbook.md).

Never kept, even if a caller passes them: prompts, images, tokens, names, emails, school data, provider message text, stacks, and request bodies. `missing` is a list of configuration names such as `ANTHROPIC_API_KEY`, never the value. `userHash` and `ipHash` are 32 hex characters. `errorName` is a fixed JavaScript or database error name. `providerType` and `stopReason` are short codes such as `api_error` and `max_tokens`.

Search Vercel Logs by `requestId` from the response header.

## Readiness

`GET /api/ready` checks configuration shape only: https Supabase origin, distinct anon and service-role keys, pepper length, and Anthropic key length. `200` body is `{"ok":true}`. `503` body is `{"ok":false}`. The body does not name the failing variable. The route does not call Anthropic or Supabase. `HEAD` returns the same status and no body. `cache-control` is `no-store`.

## Browser reports

Both switches are required. `observability-config.js` ships with `clientReports: false`. At boot the page requests `GET /api/public-config` and turns reports on only when that body says `clientReports: true`. The host variable `CLIENT_ERROR_REPORTS` must be exactly `on` for the body to say true. The response is `no-store`, and the service worker does not cache `/api/*`.

The browser listens for `error` and `unhandledrejection` and posts only `kind`, `name`, `source`, `line`, and `column` to `POST /api/client-report`. The page sends at most 5 reports and suppresses the same signature for 60 seconds. The server allowlist replaces unknown names with `Error`, unknown files with `other`, and rejects any other JSON key. Per instance, one hashed IP may send 5 reports a minute and 20 a day, and the instance accepts 30 a minute in total. A disabled endpoint returns `{"ok":true}` and logs `outcome` `disabled` without the body.

## Synthetic check

Workflow: `.github/workflows/synthetic.yml` (daily 07:30 UTC, and manual). Command:

```sh
SYNTHETIC_BASE_URL="https://your-production-origin" node scripts/synthetic-check.js
```

The script requests `GET /` and `GET /api/ready` only, with redirects left unfollowed. `/` must be 200 and contain `Education Planner`. `/api/ready` must be 200 and exactly `{"ok":true}`. It refuses `anthropic.com` and the AI routes `/api/coach`, `/api/analyse-homework`, and `/api/generate-practice`. It also refuses `/api/client-report`, `/api/account-export`, and `/api/account-delete`. A missing secret exits 2 with `EXTERNAL ACTIVATION GATE`. Pull-request CI does not run this workflow and does not receive the secret. The synthetic probe does not delete an account.

`http` is accepted only for `127.0.0.1` and `localhost`, so a local fake can exercise the script. Do not point it at a server that calls Anthropic.

## Dashboards

Apply [`ops/alerts.json`](../ops/alerts.json). Coverage:

| id | Where | What to watch |
| --- | --- | --- |
| `request_volume` | Vercel Logs | Count of structured logs in 5 minutes |
| `http_4xx` | Vercel Logs | `httpStatus` 400–499 in 15 minutes |
| `http_5xx` | Vercel Logs | `httpStatus` 500–599 in 5 minutes |
| `latency_p95` | Vercel Observability, or p95 of `durationMs` | Per-endpoint p95 in 15 minutes |
| `timeouts` | Vercel Logs | `outcome` `timeout` or status 504 in 15 minutes |
| `quota_denials` | Vercel Logs | `rate_limited` or `concurrency_limited` in 15 minutes |
| `anthropic_spend` | Anthropic workspace usage | Month-to-date spend against the limit |
| `supabase_storage_growth` | Supabase database and storage usage | Size growth over 7 days, using the size query only |

Suggested thresholds are in the JSON. Change `anthropic_spend` to the real budget before a wider beta. Confirm each alert by reading it back in the provider console; this repo has no credential that can do that.

## Service levels

The 28-day targets, error budgets, and measurement queries are in [`docs/slo.md`](slo.md) and [`ops/slo.json`](../ops/slo.json). `not_admitted` is an admission denial, not an error-budget burn. `node scripts/slo.js` prints the budgets. It does not open a provider console. The alerts above stay the short-window signals.

## Verify locally

```sh
npm test
npm run check:syntax
npm run test:browser
npm run test:load
```

`npm run test:load` is the synthetic smoke in [`docs/load-testing.md`](load-testing.md). It does not call Anthropic.

`test/observability.test.js` checks the log allowlist, readiness, client reports, and `ops/alerts.json`. `test/synthetic-check.test.js` checks the probe without a network call.
