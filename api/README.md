# AI API security

`api/coach.js`, `api/analyse-homework.js`, and `api/generate-practice.js` share `api/security.js`. A request is accepted only when all of the following succeed:

1. `POST` with a Supabase user access token (`Authorization: Bearer <token>`).
2. Supabase Auth confirms that token (`GET /auth/v1/user`) and the user role is `authenticated`.
3. The JSON body matches that endpoint's schema and size limits.
4. Postgres quotas in `supabase/2026-ai-api-quotas.sql` allow another call for that user and IP. Homework analysis also takes a single in-flight lease per user.
5. The Anthropic call finishes before the upstream timeout (`AbortController`).

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

Set an Anthropic workspace spend limit and a Vercel spend alert before inviting more families. Those consoles are not changed by this code. The IP used for quotas is `x-real-ip`, then the first `x-forwarded-for` hop, then a shared `unknown` bucket.
