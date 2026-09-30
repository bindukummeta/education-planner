# Beta launch evidence

Copy this file to `ops/evidence/filled/` before you write it. Do not commit the copy.

**Launch status in this repository: not launched.** A completed copy is still only a note. It does not create users or set host variables.

| Field | Value |
| --- | --- |
| Date (UTC) | |
| Role | `<BETA_OPERATOR>` |
| Witness | `<INCIDENT_COMMANDER>` |
| Project name or ref | no URL with a key |
| `verify-beta-admission.sql` | list `ok` true/false only |
| Admitted count | integer, 0 to 200 |
| `BETA_MODE` | on or off, not the other variables |
| Non-invited check | 403 and no rows, yes/no |
| Invited check | sync and one AI call, yes/no |
| Result | not-launched / pass / fail |

`not-launched` is the only honest result until the external blockers in [`docs/beta-launch-checklist.md`](../../docs/beta-launch-checklist.md) are done by a person with credentials.
