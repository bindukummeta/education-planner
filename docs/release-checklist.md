# Release checklist

Run this before a production deploy. Continuous integration (`.github/workflows/ci.yml`) must already be green on the commit you are shipping. CI installs from `package-lock.json` and does not receive Supabase, Anthropic, or other secrets.

## 1. Migration order

Apply database changes before the app version that depends on them. Do not invite additional families between these steps.

1. Back up the Supabase database and the `blobs` bucket.
2. Apply [`supabase/2026-per-account-isolation.sql`](../supabase/2026-per-account-isolation.sql) in the Dashboard SQL Editor, unchanged, unless you are doing the documented single-family claim. Leave both legacy variables empty unless that claim is intentional.
3. Deploy the matching owner-scoped client (`sync.js`) in the same release. Installed copies precache `sync.js`, so bump `CACHE` in `service-worker.js` in that same deploy.
4. Run [`supabase/verify-account-isolation.sql`](../supabase/verify-account-isolation.sql). Any `ok = false` row blocks the release. Then do the two-account check in [`supabase/README.md`](../supabase/README.md).
5. Apply [`supabase/2026-ai-api-quotas.sql`](../supabase/2026-ai-api-quotas.sql) before the API routes that call `consume_ai_quota` and `release_ai_concurrency` are relied on. Re-running it replaces the functions and does not delete counters.
6. Deploy the static app and the API routes together, after the steps above that they depend on.

Keep Family Sync limited to operators until steps 2–4 pass. The quota script does not replace the isolation script; run isolation first.

## 2. Environment validation

Set these in the hosting project's environment, not in git. The handlers fail closed with a generic 503 when validation fails, and they do not call Anthropic.

| Variable | Check |
| --- | --- |
| `SUPABASE_URL` | `https` origin only. No path, query, user, or password |
| `SUPABASE_ANON_KEY` | At least 20 characters, no `<` placeholder |
| `SUPABASE_SERVICE_ROLE_KEY` | At least 20 characters, and different from the anon key. Server only |
| `API_QUOTA_PEPPER` | At least 16 characters |
| `ANTHROPIC_API_KEY` | At least 20 characters. Server only |

There is no anonymous bypass. `AI_ALLOW_ANONYMOUS` is ignored. Optional quota and model overrides are listed in [`api/README.md`](../api/README.md); out-of-range integers keep the built-in defaults.

Confirm Anthropic and host spend alerts exist before widening access. Those consoles are outside this repo. Apply the definitions in [`docs/observability.md`](observability.md). After deploy, `GET /api/ready` must return `{"ok":true}` and must not call Anthropic.

`sync-config.js` stays empty in git. The browser loads Supabase's public URL, anon key, environment name, and client-report toggle from `GET /api/public-config` on that host. The response is `cache-control: no-store`, and the service worker does not cache `/api/*`. Browser error reports stay off until `CLIENT_ERROR_REPORTS=on`, which is the only value that makes `clientReports` true in that response. The static `observability-config.js` file stays false.

In a shell that contains only the target environment, run:

```sh
ENFORCE_ENV=1 npm run check:env
```

The command prints failing names, not values. It must pass for local, staging, and production shells. It must fail when `VERCEL_ENV=preview` and `APP_ENV=production`. Staging Preview is allowed only with `ALLOW_PREVIEW_PUBLIC_CONFIG=staging` and the staging project. See [`docs/environments.md`](environments.md).

After deploy, `GET /api/public-config` shows this host's `environment` and a Supabase host for that environment. Do not paste the body into a ticket. Do not add the route to the synthetic probe.

## 3. Service-worker cache

`service-worker.js` precaches the app shell under the `CACHE` name (currently `eduplanner-v64`). `activate` deletes every other cache. The cache still does not contain a live Supabase binding. v64 adds `sw-boot.js` so the update banner is an external script.

- If this release changes a precached file (`index.html`, `app.js`, `sync.js`, `storage.js`, `report-policy.js`, `privacy.js`, `observability-config.js`, `public-config.js`, `client-report.js`, `sw-boot.js`, `sync-config.js`, styles, icons, manifest, or the worker itself), increment `CACHE` in the same commit.
- `vercel.json` sends `Cache-Control: public, max-age=0, must-revalidate` for `/service-worker.js` and `/index.html`. Keep that so browsers can see the new worker.
- The worker does not call `skipWaiting` on install. After deploy, confirm an existing client can show the update banner and load the new shell.
- Localhost and `127.0.0.1` unregister the worker on purpose. Check the cache on a non-local host.

## 4. Smoke tests

On the release commit:

- `npm ci`
- `npm test` (unit and API, including `test/analyse-homework-api.test.js`)
- `npm run check:syntax`
- `npm run test:browser` (Playwright against the local smoke server; no live Supabase or Anthropic)

These are the same commands CI runs. Do not point the browser suite at production, and do not send real worksheet photos.

After deploy, with a non-production family account:

- The app shell loads and a reload keeps a local record.
- Family Sync signs in and a sync completes for that account only.
- One AI request from a signed-in session returns a normal answer or a controlled quota/error page, not a provider body.

## 5. Rollback

Prefer a fail-closed rollback over restoring wider access.

- App: promote the previous hosting deployment of the same commit pair (static files and API routes).
- Service worker: clients keep the cache named in the bad worker until a different `CACHE` name activates. Ship the rollback with its own cache name (the previous name, or a newer rollback name) so `activate` drops the bad cache. Confirm `service-worker.js` is not stuck behind a long cache lifetime.
- Database: do not drop `public.records`, `records_legacy_unowned`, quota counters, or leases to undo an app bug. Do not restore permissive row policies while any client still upserts without `owner`.
- Client/database pair: roll the owner-scoped client back only together with a database you know that client can use. A new client against old permissive policies can leak rows. An old unscoped client against owner-only policies should fail sync rather than write shared rows; treat sync errors as the safe outcome and fix forward.
- AI spend: remove or rotate `ANTHROPIC_API_KEY`, or deploy the previous functions, so routes return 503/502 instead of calling the model. Quotas can be lowered with the `AI_QUOTA_*` variables without a schema change.
- Tell operators Family Sync and homework analysis are paused until the checklist passes again.

## 6. Operations

Roles and escalation: [`docs/operations-roles.md`](operations-roles.md). Use the placeholders. Do not invent a person's name in the repo.

Runbooks, listed by `node scripts/runbook.js` (read-only; `--apply` refuses):

- [`docs/runbooks/deployment.md`](runbooks/deployment.md)
- [`docs/runbooks/migrations.md`](runbooks/migrations.md)
- [`docs/runbooks/rollback.md`](runbooks/rollback.md)
- [`docs/runbooks/key-rotation.md`](runbooks/key-rotation.md)
- [`docs/runbooks/outages.md`](runbooks/outages.md)
- [`docs/runbooks/account-deletion.md`](runbooks/account-deletion.md)
- [`docs/runbooks/backup-restore.md`](runbooks/backup-restore.md)
- [`docs/runbooks/restore-drill.md`](runbooks/restore-drill.md)

`<BACKUP_OWNER>` completes the PITR checklist in the backup runbook for the production project and files a restore drill from [`ops/evidence/restore-drill-template.md`](../ops/evidence/restore-drill-template.md). A drill has not been executed by this repository. Do not mark the checklist done on the strength of the template alone.

## 7. Service levels, cost, and load

- Initial budgets and the measurement queries are in [`docs/slo.md`](slo.md). `node scripts/slo.js` prints them. It does not query a provider.
- The 5,000-user model is [`docs/cost-model.md`](cost-model.md). Run `node scripts/cost-model.js` on the sample. A dollar total requires prices you copy from Anthropic, Vercel, and Supabase. The sample does not contain those prices.
- CI runs `npm run test:load` (smoke). Heavier and soak commands are in [`docs/load-testing.md`](load-testing.md). Do not point them at production.

## 8. Invited beta

Do not apply [`supabase/2026-beta-admission.sql`](../supabase/2026-beta-admission.sql) as part of the migration order in section 1. It fail-closes data access until invited ids are inserted.

The procedure is [`docs/runbooks/beta-admission.md`](runbooks/beta-admission.md). The launch list is [`docs/beta-launch-checklist.md`](beta-launch-checklist.md). Weekly notes use [`ops/evidence/beta-weekly-review-template.md`](../ops/evidence/beta-weekly-review-template.md) and [`ops/evidence/beta-launch-evidence-template.md`](../ops/evidence/beta-launch-evidence-template.md).

This repository has not launched a beta. External credentials, invited families, and a person to apply the SQL are still required. Do not mark section 8 done from the templates alone.
