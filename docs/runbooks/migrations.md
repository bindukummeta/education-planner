# Migrations

Owner: `<MIGRATION_OWNER>`
Escalate to: `<MIGRATION_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>`.

`node scripts/runbook.js migrations` does not connect to a database.

Apply scripts to **one** Supabase project. Run staging, verify, then production. Do not paste the production database password into the staging SQL editor.

## Order

Follow [../release-checklist.md](../release-checklist.md) section 1. In short, for each project:

1. `<BACKUP_OWNER>` confirms a backup exists for this project ([backup-restore.md](backup-restore.md)).
2. Keep Family Sync limited to operators.
3. Run [`../../supabase/2026-per-account-isolation.sql`](../../supabase/2026-per-account-isolation.sql) unchanged in that project's SQL editor. Leave both legacy variables empty unless the single-family claim in [../../supabase/README.md](../../supabase/README.md) is intentional for **this** project only.
4. Deploy the matching `sync.js` ([deployment.md](deployment.md)). Bump `CACHE` in the same deploy if it is not already this release's name.
5. Run [`../../supabase/verify-account-isolation.sql`](../../supabase/verify-account-isolation.sql). Any `ok = false` stops the release.
6. Do the two-account check in the Supabase readme with two users in **this** project.
7. Run [`../../supabase/2026-ai-api-quotas.sql`](../../supabase/2026-ai-api-quotas.sql) before the AI routes are relied on. Re-running it replaces functions and does not delete counters.

Do not add [`../../supabase/2026-beta-admission.sql`](../../supabase/2026-beta-admission.sql) to this list. That script is only for the invited beta and it fail-closes row access. See [beta-admission.md](beta-admission.md).

## Do not

- Run the production script while connected to staging, or the reverse. Check the project ref in the dashboard header before executing.
- Drop `public.records` or policies to "start clean" on production.
- Claim unowned rows for one user on production unless that claim was already true and backed up.
- Run `2026-beta-admission.sql` while following the steps above. It is a separate procedure.
