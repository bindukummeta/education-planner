# Restore drill

Owner: `<BACKUP_OWNER>`
Witness: `<INCIDENT_COMMANDER>`
Escalate to: `<BACKUP_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>`.

Status: **EXTERNAL**. A live drill has not been run from this repository. There is no Supabase credential here, and `node scripts/runbook.js restore-drill --apply` refuses so a script cannot start one.

## Procedure

1. Copy [../../ops/evidence/restore-drill-template.md](../../ops/evidence/restore-drill-template.md) to `ops/evidence/filled/` (gitignored) or to the team's private notes. Do not commit the copy.
2. Choose a backup id or a PITR timestamp from the **production** project. The restore target must not be the production project. Create a new empty Supabase project, or use a drill project that no family app points at.
3. Restore into that target from the Supabase dashboard. Do not run a restore against production.
4. On the target, run [`../../supabase/verify-account-isolation.sql`](../../supabase/verify-account-isolation.sql). Record each `ok` value in the evidence file. Do not paste row contents.
5. Confirm the production Vercel project was not changed: production `SUPABASE_URL` is still the production host. You can check `GET /api/public-config` on the production origin and compare the host only. Do not record the anon key.
6. Discard the drill project's keys when you are finished, or keep them only in the drill project's own Vercel settings if you maintain one. They are not production keys and they do not go in Preview.
7. Write pass or fail, the UTC time, and the two roles. A fail stays a fail if isolation SQL is red, even if the restore "completed" in the dashboard.

## Done when

The evidence file exists outside git, the production app still points at the production project, and the drill project is not linked from the production environment.

## This repo will not

- Call the Supabase management API.
- Download a backup.
- Create the drill project.
