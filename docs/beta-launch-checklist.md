# Beta launch checklist

**Status: not launched.** This repository cannot create Supabase users, set `BETA_MODE` on a host, apply SQL, or invite families. Checking a box in a copy of this file is not a launch. Do not mark the production beta as started from this tree.

Intended cohort: 50 to 200 invited families. The server and the database enforce the cap of 200. The page is not the gate.

## External blockers

- [ ] `<BETA_OPERATOR>` has a Supabase project and has applied `supabase/2026-beta-admission.sql` there
- [ ] `supabase/verify-beta-admission.sql` has no `ok = false` on that project
- [ ] Invited `auth.users` ids (between 1 and 200, target 50 or more before calling the cohort full) are inserted out of band
- [ ] The matching Vercel project has `BETA_MODE=on` and the API was redeployed
- [ ] `<BILLING_ALERT_OWNER>` has set Anthropic, Vercel, and Supabase spend alerts from [`docs/observability.md`](observability.md)
- [ ] A prices file for [`docs/cost-model.md`](cost-model.md) exists outside git, filled from those consoles
- [ ] `SYNTHETIC_BASE_URL` exists and the synthetic workflow has printed `{"ok":true}` without calling Anthropic
- [ ] One invited account and one non-invited account were checked by a person, with no child worksheet

Until those are true, production stays off the invited beta. `npm test`, `npm run check:syntax`, `npm run test:browser`, and `npm run test:load` do not satisfy this list.

## Release gate inside the repo

- [ ] CI is green, including the load smoke
- [ ] [`docs/slo.md`](slo.md) is the budget you will review
- [ ] [`docs/runbooks/beta-admission.md`](runbooks/beta-admission.md) was followed, including the backup
- [ ] Family Sync and AI stay limited to the admitted ids

## Not in this checklist

Do not send real homework, do not point the load harness at production, and do not commit admission ids or prices.
