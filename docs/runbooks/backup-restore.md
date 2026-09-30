# Backup and restore

Owner: `<BACKUP_OWNER>`
Escalate to: `<BACKUP_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>`.

`node scripts/runbook.js backup-restore` does not enable backups and does not restore a database.

## Enablement checklist

Do this in the Supabase dashboard for each project. This repository cannot turn the switches on.

Production project:

1. Confirm the plan that includes daily backups. The free tier is not enough for the family project.
2. Enable Point in Time Recovery (PITR) on the production project. Record the retention window the dashboard shows (often 7 days on the Pro add-on; use whatever the project actually offers).
3. Confirm the backup list is non-empty after the first scheduled run.
4. Confirm storage: the `blobs` bucket is not covered by database PITR. Export or copy the bucket on the same cadence you accept for photos, or accept that a database PITR will not bring images back. Write that choice next to the roster, not in git.
5. Restrict who can restore. `<BACKUP_OWNER>` and `<INCIDENT_COMMANDER>` only.

Staging project:

1. Daily backups at minimum. PITR if the plan allows and you will use staging as a drill target.
2. Staging backups are not a copy of production. Do not restore a production backup into the staging project that the staging app writes to, except during a drill that uses a **new** project ([restore-drill.md](restore-drill.md)).

Local:

1. No PITR requirement. Local data is disposable. Do not point local `SUPABASE_URL` at production "so the backup is realistic".

## Restore (incident)

1. `<INCIDENT_COMMANDER>` names the environment and the time to recover.
2. Prefer a new Supabase project as the restore target. An in-place restore on production overwrites everything after the chosen time. Accept that in writing before you do it.
3. Database PITR or a daily backup restores Postgres, including `auth.users` and `public.records`, to that target. Re-link storage separately if you have a bucket copy.
4. Run [`../../supabase/verify-account-isolation.sql`](../../supabase/verify-account-isolation.sql) on the target. Any `ok = false` means you do not point the app at it.
5. Put the target's URL and new anon and service-role keys only in the Vercel environment that should use them. Run `ENFORCE_ENV=1 npm run check:env` there. Redeploy. `GET /api/public-config` must show the new host and must be `no-store`.
6. Do not reuse the production keys on the new project, and do not leave the production URL in a staging variable.

## Do not

- Store a database password, a backup file, or a service-role key in this repo.
- Restore production over staging to "see if the backup works". Use the drill.
