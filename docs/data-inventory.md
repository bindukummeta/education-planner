# Data inventory

Canonical list: `privacy.js` (`EduPrivacy.INVENTORY` and `EduPrivacy.PROCESSORS`). This page is the reading copy for parents and operators. It has not been checked by a lawyer. It is not legal advice and it is not an official approval. Legal review is **OUTSTANDING LEGAL REVIEW**.

Retention that code enforces: API logs are allowlisted and are not written to the database; in-memory error-report buckets are pruned at 7 days; cloud rows, `uid/` blobs (including nested objects), the beta allowlist row, quota buckets for that account, and the auth user are removed by `POST /api/account-delete` in the order storage-objects, owner-records, analysis-leases, quota-counters, beta-admissions, auth-user. The auth user is deleted only after a fresh list of that `uid/` prefix is empty. A list that cannot be finished, or a prefix that still has objects, fails and leaves the sign-in in place. Cloud export is either complete (`complete: true`) or a 413 `export_too_large`. It does not return a partial file with omitted blobs. Host log retention of 7 days must be set in Vercel by an operator. This repository cannot set it.

Legal review of this inventory, and a security sign-off of the tier labels below, are **external**. This file is not that approval. **OUTSTANDING LEGAL REVIEW**. **OUTSTANDING SECURITY APPROVAL**.

MFA is an **external production blocker**. This app does not enroll a second factor and does not check Supabase AAL2. Do not describe Family Sync sign-in as multi-factor.

| Tier | NBCU meaning | Application decision |
| --- | --- | --- |
| 0 | Non-business information | Not used for application data. |
| 1 | Public information approved for release | Static public application assets only; no family or account data. |
| 2 | General Business information for internal use | Not assigned: the application data below contains personal information. |
| 3 | Confidential, need-to-know information | Not assigned independently; the more restrictive Tier 4 classification applies. |
| 4 | Sensitive Non-Public, including credentials and all direct or indirect personal information | Applies to every inventory entity below. Child education records, photos, names, email, postcode, account IDs, IP-derived hashes, sessions, logs, and sync metadata are personal information or are linked to it. Controls include owner isolation, encryption in transit and at rest through the hosting providers, complete-or-refused export, verified deletion, four-hour absolute and thirty-minute idle limits, and restricted logs. MFA/AAL2 and external security approval remain production blockers. |

Local export (`Export backup`) reads IndexedDB only and does not need a cloud account.

| id | tier | location | name | purpose | retention | processor | enforced |
| --- | --- | --- | --- | --- | --- | --- |
| idb-schools | 4 | indexeddb | schools | School names, postcodes, notes, and cut-offs a parent types. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-entries | 4 | indexeddb | entries | Daily practice scores and subjects. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-homework | 4 | indexeddb | homework | Homework tasks the parent records. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-reading | 4 | indexeddb | reading | Reading titles and minutes. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-mocks | 4 | indexeddb | mocks | Mock scores the parent records. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-events | 4 | indexeddb | events | Calendar events the parent adds. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-students | 4 | indexeddb | students | Child profile names and colours chosen by the parent. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-projects | 4 | indexeddb | projects | Project notes and reflections. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-curiosity | 4 | indexeddb | curiosity | Curiosity prompts and topics. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-analyses | 4 | indexeddb | analyses | Worksheet analysis a parent has chosen to keep. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-blobs | 4 | indexeddb | blobs | Worksheet photos kept on this device. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-meta | 4 | indexeddb | meta | Per-child mastery and the school year are synced and backed up. The active child, Enhanced AI consent, coach audience, geocode cache, and sync cursor stay on this device. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| idb-sync-queue | 4 | indexeddb | _dirty and _tombstones | Local queue of changes waiting to sync, including deletions. Import clears it and rebuilds it from the backup so an older delete is not pushed. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| local-settings | 4 | local-storage | eduplanner.settings.v1 | Home postcode and the last subject and difficulty used on this device. | On this device until you delete it, import a replacement backup, or clear this site's data in the browser. | This device | device |
| local-auth-session | 4 | local-storage | Supabase auth session | Sign-in token for Family Sync. It is not a copy of the child's work. This app does not check a second factor. | Cleared when you sign out, after 30 minutes without use, or 4 hours after sign-in, whichever comes first. Also removed from use when the cloud account is deleted. | This device and Supabase Auth | deletion-api |
| supabase-records | 4 | supabase-row | public.records | Cloud copy of synced rows, each stamped with the account owner. | Kept for the signed-in account until you permanently delete the cloud account from Settings. A retry of that deletion is safe if a step was already empty. | Supabase | deletion-api |
| supabase-blobs | 4 | supabase-blob | blobs bucket uid/ | Worksheet photos stored at uid/object for the signed-in account. | Kept for the signed-in account until you permanently delete the cloud account from Settings. A retry of that deletion is safe if a step was already empty. | Supabase | deletion-api |
| supabase-auth | 4 | supabase-row | auth.users | The family sign-in (email and account id). | Kept for the signed-in account until you permanently delete the cloud account from Settings. A retry of that deletion is safe if a step was already empty. | Supabase Auth | deletion-api |
| quota-counters | 4 | supabase-row | ai_quota_counters and ai_analysis_leases | Short-lived rate-limit buckets and homework leases. Buckets are hashed or keyed by account id, not by the child's work. | Minute and day buckets expire in about two days. Account deletion removes buckets that start with that account id, and any leases for that account. | Supabase | deletion-api |
| beta-admissions | 4 | supabase-row | beta_admissions | Invited-family allowlist of account ids. It does not store the child's work. | Removed when that cloud account is deleted. The list is capped at 200. | Supabase | deletion-api |
| ai-coach | 4 | ai-payload | Coach snapshot | A derived progress summary (scores, school status labels, reading totals, game counts). Photos, free-text notes, and the child's name are not the payload. | This app does not store the request after the reply is returned. What the AI company keeps is outside this app and is part of the outstanding legal review. | Anthropic | not-stored-here |
| ai-homework | 4 | ai-payload | Worksheet images | Photos the parent chooses to send for enhanced analysis, plus the subject label. | This app does not store the images on the server. What the AI company keeps is outside this app and is part of the outstanding legal review. | Anthropic | not-stored-here |
| ai-practice | 4 | ai-payload | Practice question text | Question text and expected answers used to generate similar practice. Photos and names are not sent. | This app does not store the request after the reply is returned. What the AI company keeps is outside this app and is part of the outstanding legal review. | Anthropic | not-stored-here |
| log-api | 4 | log | API outcome log | One JSON line per request: request id, endpoint, outcome, status, duration, and hashes. Prompts, images, tokens, names, emails, and schoolwork are dropped. | Not written to the database. Keep host logs for 7 days, then delete them. This repository cannot change the host's log setting. | Vercel | allowlist |
| log-client | 4 | log | Browser error report | Optional error type, file name, and line. Messages, stacks, and page data are rejected. | Off unless the operator and the app both turn it on. The server holds counts in memory only and drops them within 7 days (the rate window is one day). | Vercel | memory-prune |
| lookup-postcode | 4 | processor | postcodes.io | The home postcode is sent to look up a latitude and longitude for a straight-line distance. The child's name is not sent. | The coordinate is cached on this device. The lookup service's own retention is outside this app. | postcodes.io | device |

## Meta key classification

Backup format version matches the IndexedDB schema version. Current files are version 6. Versions 1–5 still import.

Synced and included in Export backup:

- `student.yearGroup`
- `vocabMastery.<studentId>`, `ninjaMastery.<studentId>`, `spellMastery.<studentId>`, `practiceMastery.<studentId>`

Device-only. Not synced and not written into a backup. Import leaves the copy already on this device in place. Enhanced AI consent stays device-only.

- `activeStudentId` — which child this device has open
- `analyzer.enhancedAi.enabled` — Enhanced AI consent
- `coach.audience` — parent or child coach view on this device
- `geo.<lookup>` — geocode cache
- `seedIntroducedNames` — preset-school watermark
- `lastPulledAt` — sync cursor. After a pull it is `{ updatedAt, store, id }`. A plain number from an older version is still read and means "start at that time"
- `importReconcileAt` — used once after import
- any key that is not in the synced list

The Family Sync sign-in is the Supabase session on this device. It is not a meta row and it is not in the backup.

Import replaces the records in the file. It clears `_dirty` and `_tombstones`, then rebuilds `_dirty` from the restored rows only. `lastPulledAt` is reset to 0. The next sync pulls before it pushes. A cloud row from before the backup that is not in the file is deleted in the cloud and is not copied back onto the device. That delete is stamped strictly later than the cloud row, so another device pulls it. A cloud delete from before the backup does not remove restored rows. A cloud change from after the backup merges by `updatedAt` (last write wins). Pull pages with `(updated_at, store, id)` and saves that cursor after each row it finishes, including when many rows share one timestamp. A photo that storage confirms is missing is marked deleted and sync continues. A download that fails for any other reason stops before later rows and is retried. A v1–v5 file has no mastery section, so mastery already on the device is kept.

## Processors

| name | purpose | data | contract |
| --- | --- | --- | --- |
| This device | Stores the app's IndexedDB and local settings. | Family education records the parent enters. | Not a company. Stays in the browser. |
| Supabase | Family Sync auth, the records table, and the blobs bucket. | Account email, synced rows, and photos under uid/. | Outstanding — no contract is signed in this repository. |
| Anthropic | Cloud AI replies for coach, worksheet analysis, and generated practice. | Only the payloads described in the inventory, and only after the parent ticks the box. | Outstanding — no contract is signed in this repository. |
| Vercel | Hosts the app and the API, and stores the short outcome logs. | Request metadata and allowlisted log fields. Not the child's work. | Outstanding — no contract is signed in this repository. |
| postcodes.io | Turns a postcode into a coordinate. | The postcode the parent types. | Outstanding — public lookup, no contract is signed in this repository. |
| jsDelivr | Delivers the Supabase browser library. | Connection data only. Family records are not sent there. | Outstanding — no contract is signed in this repository. |
| Google Fonts | Loads the heading font. | Connection data only. Family records are not sent there. | Outstanding — no contract is signed in this repository. |

Related: [DPIA](dpia.md), [subprocessors](subprocessors.md), [retention and deletion runbook](retention-deletion-runbook.md).
