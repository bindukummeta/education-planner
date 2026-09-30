# Key rotation

Owner: `<SECURITY_ALERT_OWNER>` for Supabase keys, `<BILLING_ALERT_OWNER>` for `ANTHROPIC_API_KEY`.
Escalate to: the deputy for that role, then `<INCIDENT_COMMANDER>`.

`node scripts/runbook.js key-rotation` does not rotate anything. Do one environment at a time. Never put the new value in git or in the production Preview environment.

A previous revision of `sync-config.js` contained a live project URL and anon key. Treat that anon key as published. Rotate it in the Supabase project it belonged to, then store the new anon key only as `SUPABASE_ANON_KEY` on the matching Vercel environment. This procedure does not repeat the old key.

## Anon key (`SUPABASE_ANON_KEY`)

1. In that environment's Supabase project, create a new anon key and revoke the old one after the deploy below is serving traffic.
2. Set `SUPABASE_ANON_KEY` on that Vercel environment only. Production Preview stays empty. Staging Preview, if used, gets the staging anon key only.
3. Redeploy. `GET /api/public-config` is `no-store`, and the service worker does not cache `/api/*`, so a reload picks up the new key. Installed copies do not keep the old key inside `sync-config.js` once `eduplanner-v64` is active.
4. Confirm Family Sync sign-in on a test account. Then revoke the old anon key if you have not already.

## Service-role key (`SUPABASE_SERVICE_ROLE_KEY`)

1. Create a new service-role key in that Supabase project. It must differ from the anon key.
2. Update the Vercel variable for that environment. Do not add it to Preview on the production project.
3. Redeploy the functions. Quota, export, and delete routes use it on the server. `/api/public-config` must still omit it.
4. Revoke the old service-role key. `ENFORCE_ENV=1 npm run check:env` in that shell must pass without printing the value.

## Pepper (`API_QUOTA_PEPPER`)

Changing `API_QUOTA_PEPPER` changes IP hashes. Old per-IP buckets stop matching and new ones start empty, so a noisy network can burst again until the daily window fills. Plan the change at a quiet time. The pepper stays server-only.

## Anthropic key (`ANTHROPIC_API_KEY`)

1. Create a new key in the Anthropic workspace for **this** environment. Lower or keep the spend limit before you attach it.
2. Update the Vercel variable and redeploy. `/api/ready` stays `{"ok":true}` and still must not call the model.
3. Disable the old key. Tell `<BILLING_ALERT_OWNER>` so the spend alert still points at the right workspace.

## Do not

- Rotate production and staging in one dashboard session without checking the project ref.
- Write any of these values into `sync-config.js`.
- Send the new key to a chat log to "confirm it looks right".
