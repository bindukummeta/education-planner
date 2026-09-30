# Rollback

Owner: `<INCIDENT_COMMANDER>`
Escalate to: `<PLATFORM_OWNER>` if the host console will not promote the previous deployment.

`node scripts/runbook.js rollback` does not change a deployment.

Prefer a fail-closed rollback. Wider access is not a recovery step.

## App

1. In the **same** Vercel project, promote the previous deployment of the static files and the API routes together.
2. Do not promote a preview deployment that was built with production variables. If Preview was empty, it has no production binding to leak; it also may not be a usable rollback of the primary URL. Use the previous Production deployment.
3. `GET /api/ready` and `GET /api/public-config` must match that older release's environment. `cache-control` on public config stays `no-store`.

## Service worker

Clients keep the cache named in the bad worker until a different `CACHE` name activates. Ship the rollback with its own cache name (the previous name, or a newer rollback name) so `activate` drops the bad cache. `service-worker.js` must stay `Cache-Control: public, max-age=0, must-revalidate` ([../../vercel.json](../../vercel.json)).

`eduplanner-v64` still exists so clients do not keep a precached `sync-config.js` that contained a live Supabase binding. A rollback that restores that file reintroduces the binding. Do not roll back to a commit that puts a URL or anon key in `sync-config.js`. Fix forward instead: empty file, config from `/api/public-config`.

## Database

Do not drop `public.records`, `records_legacy_unowned`, quota counters, or leases to undo an app bug. Do not restore permissive row policies while any client still upserts without `owner`.

Roll an owner-scoped client back only together with a database that client can use. A new client against old permissive policies can leak rows. An old unscoped client against owner-only policies should fail sync. Treat sync errors as the safe outcome.

## AI spend

Remove or rotate `ANTHROPIC_API_KEY` for this project, or deploy the previous functions, so routes return 503 or 502 instead of calling the model. Quotas can be lowered with `AI_QUOTA_*` without a schema change. Tell `<BILLING_ALERT_OWNER>`.

## Tell operators

Family Sync and homework analysis stay paused until [../release-checklist.md](../release-checklist.md) passes again.
