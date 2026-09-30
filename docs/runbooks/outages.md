# Outages

Owner: `<INCIDENT_COMMANDER>`
Escalate to: `<PLATFORM_OWNER>`, then that provider's support.

`node scripts/runbook.js outages` does not open a provider status page and does not change DNS.

The local planner keeps working from IndexedDB when a provider is down. Say that to families if you post a notice. Do not ask them to clear site data.

## Supabase

Signs: Family Sync errors, `/api/ready` may still be `{"ok":true}` (it does not call Supabase), AI and account routes return 503 or 401 because token checks fail.

1. Check Supabase status yourself. This repo cannot.
2. Leave the app deployed. Do not disable RLS and do not switch the client to the service-role key.
3. If the project is unavailable past the backup window you chose, `<BACKUP_OWNER>` follows [backup-restore.md](backup-restore.md). A restore target is a new project or staging, not an in-place guess on production, unless the incident commander has accepted that the production project is already lost.
4. When Supabase returns, `GET /api/public-config` on the right host must show that environment's URL again. A reload then allows sync. Data that never left the device is still there.

## Anthropic

Signs: AI routes return a generic 502 or 504. Sync and the static app still work. `/api/ready` stays ok and must not be used as a way to "ping" the model.

1. `<BILLING_ALERT_OWNER>` checks the workspace spend and status.
2. If spend is the cause, lower `AI_QUOTA_*` or remove `ANTHROPIC_API_KEY` so routes fail closed with 503.
3. Do not retry homework photos in a loop. Quotas already limit that.
4. Restore the key only after the spend alert is still in place.

## Vercel

Signs: the host does not answer. An already-open page can still edit IndexedDB. After a reload, `/api/public-config` cannot load, so Family Sync stays off until the host is back. That is deliberate: the service worker does not cache one environment's public config for later.

1. Check Vercel status. Promote the last known-good Production deployment if the outage is a bad release ([rollback.md](rollback.md)), not a platform outage.
2. Do not copy production variables into Preview to "bring up a spare URL".
3. When the host returns, confirm `/api/ready` and the environment name on `/api/public-config` before telling families to sync.

## During any of these

Log the start and end time, the role on point, and the request id if a family has one. Do not attach photos, emails, or tokens. Security-shaped symptoms go to `<SECURITY_ALERT_OWNER>` as well.
