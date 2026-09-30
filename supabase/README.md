# Account-isolated Family Sync

Ship the database change and the matching `sync.js` together. The client stamps `owner`, upserts with `onConflict: "owner,store,id"`, and stores image bytes at `<uid>/<blobId>`. A session with no user id does not push or pull.

## Coordinated rollout

1. Back up the Supabase database and the `blobs` bucket.
2. Leave Family Sync limited to operators until the checks below pass. Do not invite another family onto a build that still upserts without `owner`.
3. In the Dashboard SQL Editor, run [`2026-per-account-isolation.sql`](2026-per-account-isolation.sql) unchanged. Both legacy variables stay empty, so unowned rows are moved to `public.records_legacy_unowned` and are not given to one account.
4. Deploy this client. `sync.js` is precached, so the service-worker `CACHE` name has to change in the same release or installed copies keep the old engine.
5. Run [`verify-account-isolation.sql`](verify-account-isolation.sql). Treat any `ok = false` as a blocker. `info_*` rows are counts, not a pass by themselves. The SQL editor bypasses RLS.
6. Do the two-account check below with real user sessions.
7. Only then allow further Family Sync sign-in.

To keep a single private-beta family's existing cloud data, take the backup first, confirm no other family used the project, set `legacy_owner_text` to that user's UID and `legacy_claim_confirmed` to `single-family`, then run the migration. Any other confirmation value, a nil UUID, or an id that is not in `auth.users` aborts the script. The migration deliberately does not rename rows in `storage.objects`, because changing Storage metadata does not move the underlying object. Copy root-level objects to `<uid>/<object>` through the Storage API, or let an existing device re-upload its local images on the next sync.

Rows already stored with an owner are not rewritten. Running the default script again does not restore the quarantine table into `public.records`.

## Two-account verification

Use two browsers (or profiles) and two different emails.

1. Sign in as account A, create a log entry and a worksheet photo, and sync.
2. Sign in as account B and sync. B's library must not show A's entry or photo.
3. In the Table Editor, confirm A's row `owner` is A's user id and the photo object name starts with A's id.
4. From B's session, confirm a pull does not return A's row and a download of A's `<uid>/<blobId>` path fails.
5. Swap the accounts and repeat.

A passing `verify-account-isolation.sql` report plus this client check is the gate. Dashboard queries run as a privileged role and can still see every row.
