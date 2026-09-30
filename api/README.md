# AI API security

`api/coach.js`, `api/analyse-homework.js`, and `api/generate-practice.js` share `api/security.js`. A request is accepted only when all of the following succeed:

1. `POST` with a Supabase user access token (`Authorization: Bearer <token>`).
2. Supabase Auth confirms that token (`GET /auth/v1/user`) and the user role is `authenticated`.
3. The JSON body matches that endpoint's schema and size limits.
4. Postgres quotas in `supabase/2026-ai-api-quotas.sql` allow another call for that user and IP. Homework analysis also takes a single in-flight lease per user.
5. Postgres `beta_access_allowed` returns true for that user. Production always calls it. Unset `BETA_MODE` does not turn the gate off. `BETA_MODE=on` or `BETA_MODE=open` are the only set values; anything else, including `off`, is 503. The database mode still decides: `open` allows an authenticated user, `beta` allows only an admitted id, and a missing or unknown mode denies. Account export uses the same check. Account deletion does not, so a removed family can still delete. Row access is gated again by `sync_access_allowed` in `supabase/2026-beta-admission.sql`, which calls `beta_access_allowed`. The browser cannot admit itself.
6. The Anthropic call finishes before the upstream timeout (`AbortController`).

The production handler does not skip these checks. Tests pass `createHandler({ env, fetch })` or `createHandler({ env, verifyAccessToken, consumeQuota, releaseConcurrency, fetch })`. Supplying only some of those three functions fails closed. There is no environment flag that allows anonymous calls.

If a required variable is missing, too short, or the anon key and service-role key are the same, the route returns a generic 503 and does not call Anthropic. Apply the SQL migration before deploying the handlers. This repo does not deploy it for you.

Provider failures return a generic 502, 504, or 500. Diagnostic logs are one JSON object per outcome with a request id, endpoint, status, duration, hashed user, hashed IP, and provider status or type. They do not include tokens, worksheet images, prompts, or provider error text.

## Required environment variables

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | `https` origin of the Supabase project, no path or credentials |
| `SUPABASE_ANON_KEY` | Public anon key, sent only as `apikey` when verifying the user token |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used to call the quota RPCs. Must differ from the anon key. Never ship this to the browser |
| `API_QUOTA_PEPPER` | At least 16 characters. Mixed into the IP hash stored in quota buckets |
| `ANTHROPIC_API_KEY` | At least 20 characters. Sent only to Anthropic |
| `BETA_MODE` | Optional label. Exact `on` or `open`, or unset. Unset does not disable admission. `off` and any other value return 503. Production still calls `beta_access_allowed` |

Optional model settings already used by the handlers: `ANTHROPIC_COACH_MODEL`, `ANTHROPIC_VISION_MODEL`, `ANTHROPIC_PRACTICE_MODEL`, `ANTHROPIC_MAX_OUTPUT_TOKENS`, `ANTHROPIC_EFFORT`.

Quota and timeout overrides (integers; out-of-range values keep the default):

| Variable | Default |
| --- | --- |
| `AI_QUOTA_COACH_USER_PER_MINUTE` | 10 |
| `AI_QUOTA_COACH_USER_PER_DAY` | 40 |
| `AI_QUOTA_COACH_IP_PER_MINUTE` | 20 |
| `AI_QUOTA_COACH_IP_PER_DAY` | 80 |
| `AI_TIMEOUT_COACH_MS` | 8000 |
| `AI_QUOTA_GENERATE_PRACTICE_USER_PER_MINUTE` | 6 |
| `AI_QUOTA_GENERATE_PRACTICE_USER_PER_DAY` | 30 |
| `AI_QUOTA_GENERATE_PRACTICE_IP_PER_MINUTE` | 12 |
| `AI_QUOTA_GENERATE_PRACTICE_IP_PER_DAY` | 60 |
| `AI_TIMEOUT_GENERATE_PRACTICE_MS` | 25000 |
| `AI_QUOTA_ANALYSE_HOMEWORK_USER_PER_MINUTE` | 3 |
| `AI_QUOTA_ANALYSE_HOMEWORK_USER_PER_DAY` | 12 |
| `AI_QUOTA_ANALYSE_HOMEWORK_IP_PER_MINUTE` | 6 |
| `AI_QUOTA_ANALYSE_HOMEWORK_IP_PER_DAY` | 24 |
| `AI_QUOTA_ANALYSE_HOMEWORK_CONCURRENCY` | 1 |
| `AI_TIMEOUT_ANALYSE_HOMEWORK_MS` | 290000 |

Windows are the clock minute and the UTC day, shared across instances. A burst at the end of one minute and the start of the next can use both windows. Homework leases last 330 seconds and are deleted on completion. Per-user and per-IP limits are both consumed for every accepted call.

Body limits (not env-configurable):

| Endpoint | Limit |
| --- | --- |
| Coach | Snapshot JSON ≤ 24000 characters, depth ≤ 8, strings ≤ 800, arrays ≤ 80. Keys: `snapshot`, `audience` |
| Practice | ≤ 6 samples, question ≤ 2000, answer ≤ 400, labels ≤ 80, count 1–8. Keys: `subject`, `topic`, `errorType`, `samples`, `count` |
| Homework | ≤ 8 images, JPEG or PNG, ≤ 3 MiB decoded in total. Keys: `subject`, `images` or legacy `image` |

## Operator steps outside this repo

Set an Anthropic workspace spend limit and a Vercel spend alert before inviting more families. Those consoles are not changed by this code. The IP used for quotas is the rightmost valid address in `x-vercel-forwarded-for`, then a valid `x-real-ip`, then the rightmost valid `x-forwarded-for` address. The first forwarding hop is not trusted. An address that does not parse is the shared `unknown` bucket. Client-error IP hashes require `API_QUOTA_PEPPER` and have no static fallback. Alert definitions and the readiness probe are in [`docs/observability.md`](../docs/observability.md).

Family Sync sign-in is not multi-factor. Checking Supabase AAL2, or enrolling a second factor, is an external production blocker. This API does not claim MFA.

## Observability routes

`GET /api/ready` checks the same configuration shape as the AI routes (https Supabase origin, distinct anon and service-role keys, pepper length, Anthropic key length). It returns `{"ok":true}` or `{"ok":false}` with `x-request-id` and `cache-control: no-store`. It does not return variable names or secret values, and it does not call Anthropic or Supabase.

`GET /api/public-config` returns this deployment's public Supabase URL, anon key, `APP_ENV` name, and client-report toggle. It does not return the service-role key, the pepper, or the Anthropic key. Preview with `APP_ENV=production` is refused. Responses use `cache-control: no-store`. The shipped `sync-config.js` is empty so a precached file cannot pin every host to one project.

`POST /api/client-report` accepts a browser error report only when `CLIENT_ERROR_REPORTS` is exactly `on`. The body may contain only `kind`, `name`, `source`, `line`, and `column`. Anything else is rejected. Logs keep an allowlisted error name, file, and line. They do not keep messages, stacks, prompts, images, tokens, names, emails, or school data. The browser sender stays off until public config says `clientReports: true`. The static `observability-config.js` file stays false. Limits are 5 reports per minute and 20 per day per hashed IP, and 30 per minute per server instance.

Every AI and observability route writes one JSON object through `security.writeLog` and returns `x-request-id`. Logged fields are request id, endpoint, outcome, status, duration, hashes, provider status/type, stop reason, missing configuration names, error name, and client-report file/line. Account export and deletion add only `recordCount` and `blobCount`. Values that are not on that allowlist are dropped.

## Account export and deletion

`POST /api/account-export` and `POST /api/account-delete` verify the same Supabase bearer token as the AI routes, then call Supabase with the service role. They do not call Anthropic, and they do not require `ANTHROPIC_API_KEY`. A missing or identical anon and service-role pair still fails closed with a generic 503.

Export accepts only `{}` and requires admission. A 200 response is `{ "complete": true, ... }` with the caller's `public.records` rows and blob objects under `uid/`, including nested names. Rows or objects for any other account are dropped. If the row count, object count, or bytes would exceed the cap, the response is 413 `export_too_large`. It is never a 200 with omitted blobs.

Delete accepts only `{ "confirm": "DELETE MY CLOUD ACCOUNT" }`. Any other body is a generic 400 and deletes nothing. Deletion stays available when `beta_access_allowed` is false. The order is every blob object under that uid (retried until a confirming list is empty), owner rows, analysis leases, quota buckets prefixed with that uid, `beta_admissions`, then the auth user. If objects remain, the auth user is not deleted. Empty or already-missing blobs and an already-missing auth user are success, so a retry is safe. The response is `{ "deleted": true }` or a generic error. Tests use a fake fetch. This repository does not delete a live project.
