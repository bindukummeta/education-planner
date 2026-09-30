# Weekly beta review

Copy this file to `ops/evidence/filled/` before you write numbers. That directory is gitignored. Do not record emails, child names, prompts, photos, or prices beyond the aggregate you computed. Filling this template does not launch or expand the beta.

| Field | Value |
| --- | --- |
| Week (UTC, Monday start) | |
| Role | `<BETA_OPERATOR>` |
| Witness | `<BILLING_ALERT_OWNER>` |
| Environment | staging or production name only |
| Admitted families | count from `info_admitted_families` |
| Active families this week | count only |
| 5xx count | Vercel logs, 7 days |
| Timeout count | outcome `timeout` |
| Support contacts | count only, no message text |
| Database size | Supabase usage figure |
| Blobs bucket size | Supabase usage figure |
| Cost this month (user-supplied prices) | from `node scripts/cost-model.js` outside git |
| Cost per active family | `costPerActiveFamilyUsd` |
| SLO breaches | list objective ids, or none |
| Go / no-go for expansion | no-go unless every row above is filled and the launch checklist blockers are done |

## Expansion

A go means `<INCIDENT_COMMANDER>` accepts leaving `beta` mode: set `public.beta_config.mode` to `open` and `BETA_MODE=open` together, using [`docs/runbooks/beta-admission.md`](../../docs/runbooks/beta-admission.md). The API keeps calling `beta_access_allowed`. The admission table cannot grow past 200. A no-go leaves the database in beta. `BETA_MODE=off` does not open it.

This template is not evidence that a go happened.
