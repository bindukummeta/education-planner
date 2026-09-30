# Education Planner

Offline-first planner for 11+ preparation. The app shell and a child's records live in IndexedDB on the device. Family Sync, cloud AI, and browser error reports are optional and stay off until this deployment's environment says otherwise.

## Architecture

| Piece | Role |
| --- | --- |
| Static files (`index.html`, `app.js`, `storage.js`, `sync.js`) | The installed app. Works with no account. |
| `sync-config.js` | Shipped empty. It is precached, so it must not contain a Supabase URL or anon key. |
| `GET /api/public-config` | Returns this host's public Supabase URL, anon key, environment name (`local`, `staging`, or `production`), and the client-report toggle. `Cache-Control: no-store`. The service worker does not cache `/api/*`. |
| `api/*.js` | Vercel functions. They read server environment variables. The service-role key and the Anthropic key never go to the browser. |
| Supabase | Auth, the `records` table, and the `blobs` bucket. One project per environment. |
| Anthropic | Coach, homework analysis, and practice generation. Called only by the functions, after sign-in and quotas. |

On boot the page loads the empty `sync-config.js`, then `public-config.js` asks this origin for `/api/public-config`. A network error, a non-200 response, or a refused binding clears any previous URL and key. The planner still opens from IndexedDB. Family Sync stays off until a later boot receives a valid config for this host.

Do not cache that JSON in the service worker, in `localStorage`, or in a file that is copied from one Vercel project to another. Preview and production are different hosts only when they are different projects with different variables. A single cached file would pin every host to one Supabase project.

## Local setup

Requirements: Node.js 18 or newer.

```sh
npm ci
cp .env.example .env.local
```

Fill `.env.local` from the **local** Supabase project and a local Anthropic key. Leave the file uncommitted. With the variables unset, the static app still runs and AI routes return 503.

```sh
npm test
npm run check:syntax
npm run test:browser
npm run test:load
```

`npm run test:load` is a local synthetic smoke. It does not call Anthropic. Heavier runs are in [docs/load-testing.md](docs/load-testing.md). The 5,000-user cost model is [docs/cost-model.md](docs/cost-model.md). Service levels are [docs/slo.md](docs/slo.md). An invited beta is not active in this repository; the checklist is [docs/beta-launch-checklist.md](docs/beta-launch-checklist.md).

`npm run test:browser` uses `test/smoke-server.js` on `127.0.0.1`. That server returns a fake local public config. It does not call Supabase or Anthropic.

To serve the functions against the local project, use the Vercel CLI (`vercel dev`) with `.env.local` and `APP_ENV=local`. This repository does not log into Vercel or create a project.

Check a filled shell without printing secrets:

```sh
ENFORCE_ENV=1 npm run check:env
```

CI runs the tests and the syntax check. It does not receive secrets, and it does not set `ENFORCE_ENV`.

## Environments

Local, staging, and production are three Vercel projects and three Supabase projects. Credentials are not reused. The production project's Preview environment has no Supabase, Anthropic, or pepper values. Details, including the preview allow switch, are in [docs/environments.md](docs/environments.md).

## Deploy and operate

Runbooks (read them, then perform the console steps as the owning role):

| Command | Document |
| --- | --- |
| `node scripts/runbook.js deploy` | [docs/runbooks/deployment.md](docs/runbooks/deployment.md) |
| `node scripts/runbook.js migrations` | [docs/runbooks/migrations.md](docs/runbooks/migrations.md) |
| `node scripts/runbook.js rollback` | [docs/runbooks/rollback.md](docs/runbooks/rollback.md) |
| `node scripts/runbook.js key-rotation` | [docs/runbooks/key-rotation.md](docs/runbooks/key-rotation.md) |
| `node scripts/runbook.js outages` | [docs/runbooks/outages.md](docs/runbooks/outages.md) |
| `node scripts/runbook.js account-deletion` | [docs/runbooks/account-deletion.md](docs/runbooks/account-deletion.md) |
| `node scripts/runbook.js backup-restore` | [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md) |
| `node scripts/runbook.js restore-drill` | [docs/runbooks/restore-drill.md](docs/runbooks/restore-drill.md) |
| `node scripts/runbook.js beta-admission` | [docs/runbooks/beta-admission.md](docs/runbooks/beta-admission.md) |

`node scripts/runbook.js <name> --apply` refuses. The script never calls Vercel, Supabase, or Anthropic.

The release gate is [docs/release-checklist.md](docs/release-checklist.md). Role names and escalation are [docs/operations-roles.md](docs/operations-roles.md). Database rollout for one project is [supabase/README.md](supabase/README.md). API variables are [api/README.md](api/README.md).

## Secrets

`.env`, `.env.local`, and filled restore-drill notes under `ops/evidence/filled/` are gitignored. `.env.example` has blanks only. Do not paste anon keys, service-role keys, or access tokens into issues or log tickets. The anon key is public in the browser once a deploy serves it; it is still bound to one project and is not committed.
