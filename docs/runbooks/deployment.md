# Deployment

Owner: `<MIGRATION_OWNER>` for the database steps, then `<INCIDENT_COMMANDER>` for the go or no-go.
Escalate to: `<MIGRATION_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>`.

`node scripts/runbook.js deploy` prints this path and does not call a provider. `--apply` exits with an external blocker.

Do this once per environment. Finish staging before production. Use that environment's Vercel project and Supabase project only.

## Before

1. CI is green on the commit (`npm test`, `npm run check:syntax`, `npm run test:browser`, `npm run test:load`). The load step is the smoke profile only.
2. In a shell that has **that** environment's variables and no others, run `ENFORCE_ENV=1 npm run check:env`. A preview shell with `APP_ENV=production` must fail. The command prints names, not values.
3. Confirm the production Vercel project's Preview environment is empty. Confirm staging Preview, if it has variables, is the staging project and `ALLOW_PREVIEW_PUBLIC_CONFIG=staging`.
4. Read [migrations.md](migrations.md) and apply SQL to this environment's database before the app version that needs it.

## Ship

1. Deploy this commit to the target Vercel project. Do not promote a preview deployment of the production project onto the production URL.
2. `GET /api/ready` returns `{"ok":true}` and does not call Anthropic.
3. `GET /api/public-config` returns `environment` equal to `staging` or `production` for that host, `cache-control` containing `no-store`, and a Supabase host that belongs to that environment. Do not paste the body into a ticket; it contains the anon key.
4. Confirm the response does not include `SUPABASE_SERVICE_ROLE_KEY` or `ANTHROPIC_API_KEY` as field names or values.
5. Open the app, reload, and confirm a local record remains. Sign in with a non-production family only when the target is staging. On production, use the account you already reserved for the smoke check in [../release-checklist.md](../release-checklist.md).

## After

Installed copies keep the previous service-worker cache until the update banner runs. This release's cache name is `eduplanner-v64`. It still does not precache a live project binding in `sync-config.js`. Confirm one existing client can show the banner and load the new shell.

## Do not

- Commit `.env.local` or a filled public-config response.
- Point the synthetic probe at `/api/public-config`. The probe would store the anon key in workflow logs.
- Run this against two environments in one shell. Unset the variables between checks.
