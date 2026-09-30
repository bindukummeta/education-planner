# Retention and deletion runbook

Status: **OUTSTANDING LEGAL REVIEW**. This runbook is how the software behaves. It is not a legal approval and it has not been checked by a lawyer.

This repository does not delete a live Supabase project. Tests call a fake `fetch`. The synthetic probe refuses `/api/account-export` and `/api/account-delete`. Do not point that probe at a server you do not mean to leave untouched, and do not run deletion from CI.

## What is kept, and for how long

| Data | Retention | Who enforces it |
| --- | --- | --- |
| IndexedDB and on-device settings | Until the parent deletes it, imports a backup, or clears site data. | The device. Export backup still works with no account. |
| Supabase rows, `uid/` blobs, and the auth user | Until the parent deletes the cloud account. | `POST /api/account-delete`. |
| Quota counters | About two days, then the quota function deletes expired rows. Account deletion also deletes buckets whose key starts with `u:<uid>:`. | SQL in `supabase/2026-ai-api-quotas.sql`, and the delete route. |
| AI request bodies | Not stored by this app after the reply. | The handlers do not write them. The AI company's copy is outside this repo. |
| API logs | 7 days, then delete. Content is allowlisted. | Code drops anything off the allowlist and does not write logs to Postgres. An operator must set Vercel log retention to 7 days. This repo cannot do that. |
| Browser error reports | Off by default. In-memory only, pruned within 7 days (the rate window is one day). | `api/client-report.js` calls `privacy.pruneTimestamps`. |

## On-device import and the cloud copy

Import replaces local records with the backup. It does not merge them with whatever was already on the device. The sync queue (`_dirty` and `_tombstones`) is cleared and rebuilt from the restored rows, and the pull cursor is reset, so an old queued delete cannot be pushed after the restore.

The next Family Sync pulls first. Cloud rows from before the backup that are not in the file are removed from the cloud. They are not copied back onto the device. The delete written for that row is strictly newer than the cloud copy, so another signed-in device picks it up. Cloud deletes from before the backup do not remove restored rows. Cloud edits from after the backup still merge by last write wins. Enhanced AI consent, the active child, the geocode cache, and the sign-in stay on the device. The pull cursor is `(updated_at, store, id)`, saved after each applied row. A number saved by an older version is still accepted.

## Cloud deletion

A signed-in parent opens Settings, chooses Delete cloud account, types `DELETE MY CLOUD ACCOUNT`, and ticks the box. The app sends that phrase and the user's access token to `POST /api/account-delete`. It does not send the service-role key.

The server:

1. Checks the bearer token with Supabase Auth (`GET /auth/v1/user`) using the anon key. The role must be `authenticated` and the id must be a UUID. The service-role key is rejected as a bearer token.
2. Rejects any body that is not exactly the confirmation. Nothing is deleted.
3. Lists every object under `uid/`, including nested folders, and deletes those paths only. Names outside that prefix are ignored. It repeats the list-and-delete a few times, then lists the prefix again.
4. If that confirming list is not empty, or the list cannot be finished, the request fails. The auth user is not deleted.
5. Deletes `public.records` where `owner` is that id.
6. Deletes `ai_analysis_leases` for that id. A missing table (HTTP 404) does not stop the rest.
7. Deletes `ai_quota_counters` whose bucket starts with `u:<uid>:`. A missing table does not stop the rest.
8. Deletes `beta_admissions` for that id. A missing table does not stop the rest. Removal from the beta list does not block this deletion.
9. Deletes the auth user last (`DELETE /auth/v1/admin/users/<id>`) with the service role, only after the `uid/` prefix listed empty.

Steps 3–9 use the service role. If a step fails, the auth user is left in place so the parent can retry with the same sign-in. Deleting an object or user that is already gone is success. Success does not mean a capped list was skipped. The client then signs out. Data that exists only on the device is not removed.

The success body is `{ "deleted": true }`. Errors are generic (`error` and `code` only). Logs contain a request id, hashes, and counts. They do not contain the confirmation phrase, row bodies, image bytes, tokens, names, or emails.

Export is `POST /api/account-export` with `{}`. A 200 body has `complete: true` and that account's rows and `uid/` blobs, including nested objects. Other accounts' rows are dropped even if a query returned them. If the account is over the row, object, or byte cap, the response is 413 `export_too_large` and not a partial file. Export also requires `beta_access_allowed`. Deletion does not, so a family removed from the beta can still erase the cloud copy.

## Operator steps this repo will not do

- Set Vercel log retention to 7 days. Do that in the Vercel project. Confirm it by reading the setting back.
- Apply `supabase/2026-per-account-isolation.sql` and `supabase/2026-ai-api-quotas.sql` before relying on deletion. Back up the database and the blobs bucket first.
- Sign processor contracts. See [subprocessors.md](subprocessors.md).
- Run a live deletion to "try it". Use the unit tests and the browser smoke test, which mock the network.
- Tell families the notice or this DPIA has been legally approved. It has not. See [dpia.md](dpia.md).

## If deletion fails

Follow [runbooks/account-deletion.md](runbooks/account-deletion.md). The screen says the cloud account could not be deleted. Ask the parent to stay signed in and try again. Look up `x-request-id` in Vercel logs. You should see `endpoint` `account-delete` and an allowlisted `outcome`. If records were not deleted, the auth user should still exist. Do not delete `auth.users` by hand until the `uid/` objects and `owner` rows for that id are gone, or a later retry cannot see them under that token.

Do not paste log lines that you have edited to include emails, photos, or tokens into a ticket.
