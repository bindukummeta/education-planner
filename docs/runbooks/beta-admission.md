# Beta admission

Owner: `<BETA_OPERATOR>`
Escalate to: `<MIGRATION_OWNER>`, then `<INCIDENT_COMMANDER>`.

`node scripts/runbook.js beta-admission` prints this path. `--apply` and `--execute` refuse. This process does not connect to Supabase and does not set `BETA_MODE`.

The gate is version `2026-beta-admission`. It is not part of the normal isolation and quota order. Applying it on a project that already has families **denies their rows and photos** until each `auth.users` id is inserted, because the new mode is `beta` and the allowlist starts empty.

## Before

1. `<BACKUP_OWNER>` confirms a backup for this project.
2. Confirm [`../../supabase/2026-per-account-isolation.sql`](../../supabase/2026-per-account-isolation.sql) and [`../../supabase/verify-account-isolation.sql`](../../supabase/verify-account-isolation.sql) are already green on this project.
3. Decide the invited list outside git. The intended cohort is 50 to 200 families. The table rejects the 201st. Do not put emails or names in the SQL you save.

## Apply

1. In that project's SQL editor, run [`../../supabase/2026-beta-admission.sql`](../../supabase/2026-beta-admission.sql) unchanged.
2. Run [`../../supabase/verify-beta-admission.sql`](../../supabase/verify-beta-admission.sql). Any `ok = false` stops the procedure. `info_` rows are counts.
3. Admit each invited user, one id at a time, still in the SQL editor:

```sql
insert into public.beta_admissions (user_id)
values ('00000000-0000-0000-0000-000000000000');
```

Replace the nil id. The nil id is rejected. Re-running the migration does not delete these rows and does not flip `beta` back on if you later set `open`.

4. Set `BETA_MODE=on` on the same environment's server, then redeploy the API. Exact lowercase `on`, or leave it unset. Both still call `beta_access_allowed`. `off` is not a way to open the API; it returns 503. `BETA_MODE=open` is only for the expansion step below, and it still calls the database.
5. The browser has no allowlist. A family that is not invited receives 403 `not_admitted` from coach, practice, and homework analysis, and from account export and deletion, and their Supabase session cannot read or write `public.records` or the `blobs` bucket. Confirm with one invited account and one account that is not on the list. Do not use a child's worksheet for that check.

## Leave beta

Only after the weekly review records a go. Set `public.beta_config.mode` to `open` for id `1` and set `BETA_MODE=open` in the same change window. The API still calls `beta_access_allowed`, which returns true for an authenticated user only when that mode is `open`. Unset `BETA_MODE` does not by itself open the API. Expansion past 200 families is that pair of changes, not a longer list. This runbook does not perform it.

## Do not

- Treat this file, or a green verifier, as a launched beta.
- Admit a user who is not in `auth.users` for this project. The gate stores the id; it does not create the account.
- Rely on hiding a button in the page. The API and the row policies are the gate.
