# Environments

Three deployments. Three Supabase projects. No shared keys.

| | Local | Staging | Production |
| --- | --- | --- | --- |
| `APP_ENV` | `local` | `staging` | `production` |
| Vercel project | A personal or team dev project, or `vercel dev` on a laptop. Not the production project. | Its own project. The primary deployment is staging. | Its own project. The primary deployment is production. |
| Vercel Preview | Unused, or empty. | May serve public config only when `APP_ENV=staging` and `ALLOW_PREVIEW_PUBLIC_CONFIG=staging`, using the **staging** Supabase project. | Environment variables for Preview stay empty. No `SUPABASE_URL`, anon key, service-role key, pepper, or Anthropic key. No `ALLOW_PREVIEW_PUBLIC_CONFIG`. |
| `VERCEL_ENV` on the primary URL | Unset, or `development` under `vercel dev`. | `production` (Vercel's name for that project's primary deployment). `APP_ENV` is still `staging`. | `production`, and `APP_ENV` is `production`. |
| Supabase | A dev project, or none. | A project that is not the production ref. | The project families use. |
| Anthropic | A dev key with a low spend cap, or unset. | A separate key and spend cap. | The production key and spend cap. |
| `CLIENT_ERROR_REPORTS` | Empty unless you are testing reports. | `on` only while someone is watching the logs. | `on` only after [docs/observability.md](observability.md) is applied. |
| Git | `.env.local` only. | Vercel env, not git. | Vercel env, not git. |

`GET /api/public-config` reads the process environment of the deployment that received the request. It returns 503 with empty URL and key when:

- `APP_ENV` is missing or not `local`, `staging`, or `production`
- `VERCEL_ENV=preview` and `APP_ENV=production`
- `VERCEL_ENV=preview` and `ALLOW_PREVIEW_PUBLIC_CONFIG` is not exactly the same as `APP_ENV`
- `VERCEL_ENV=production` and `APP_ENV=local`
- `VERCEL_ENV=development` and `APP_ENV` is not `local`
- the Supabase URL is not an `https` origin
- the anon key is missing, shorter than 20 characters, a placeholder, or equal to the service-role key
- the service-role key is missing (it is checked so it is not shipped as the anon key; it is not returned)

A staging project's primary deployment uses `VERCEL_ENV=production` together with `APP_ENV=staging`. That pairing is allowed. It is how Vercel labels the main URL of the staging project. It is not permission to put production secrets in that project.

## Production secrets in preview

Preview must not hold production secrets.

Do not enable "apply to Preview" when you save a production variable. Do not duplicate the production Supabase project into the staging project. Do not point a preview URL at the production database "just for a quick look".

The function refuses `APP_ENV=production` on `VERCEL_ENV=preview` even if every production variable was copied. That refusal is the backstop. The real control is an empty Preview environment on the production project.

## What is not done from this repo

Creating the Vercel projects, creating the Supabase projects, enabling backups, and saving environment variables all happen in those consoles. This repo has no credential for them. `ENFORCE_ENV=1 npm run check:env` only reads the shell you point it at, and it prints names, not values.
