# Account deletion failures

Owner: `<PRIVACY_OWNER>`
Escalate to: `<PRIVACY_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>`. If rows for another account may have been touched, also `<SECURITY_ALERT_OWNER>`.

`node scripts/runbook.js account-deletion` does not delete a user. The synthetic probe must not call `/api/account-delete`.

Behavior of a healthy delete is in [../retention-deletion-runbook.md](../retention-deletion-runbook.md). This page is the failure path.

## What the parent sees

Settings says the cloud account could not be deleted. Data on the device is still there. Ask them to stay signed in and try once. Do not ask them to send the confirmation phrase or a screenshot of their library.

## What you check

1. Find `x-request-id` in that environment's Vercel logs. You want `endpoint` `account-delete` and an allowlisted `outcome`.
2. If the auth user still exists, a retry can continue. The route lists and deletes every `uid/` object, confirms that prefix is empty, then deletes `owner` rows, leases, quota buckets, and `beta_admissions`, then the auth user last. A failure before the last step leaves the user so the same token can retry. A successful response is not sent when objects were left behind.
3. Do not delete `auth.users` by hand until the `uid/` objects and `owner` rows for that id are gone. A later retry cannot see them under that token if the user is already gone and the rows remain.
4. If the log shows `not_configured` or `/api/ready` is not ok, fix that environment's variables ([../environments.md](../environments.md)). Do not borrow production keys to delete a staging user.
5. If a delete on staging was aimed at a production user id, stop and tell `<INCIDENT_COMMANDER>`. Do not run a second delete to "match" them.

## If the retry still fails

`<PRIVACY_OWNER>` records the request id, the environment name, and the outcome code. A credentialed operator deletes the remaining `uid/` objects and `owner` rows in that project, then the auth user. Record the time in the incident notes. Do not copy row bodies into the ticket.

On-device data is removed only by the parent (clear site data or a new backup import). Cloud deletion does not do that.

## Done when

The auth user is gone, `public.records` has no row with that `owner`, and storage has no object under that `uid/`. The parent still has their device copy unless they removed it themselves.
