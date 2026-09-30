# Restore drill evidence

Copy this file out of git before you fill it in (`ops/evidence/filled/` is ignored). Do not write passwords, anon keys, service-role keys, or emails here.

| Field | Value |
| --- | --- |
| Drill id | |
| Date (UTC) | |
| Role who ran it | `<BACKUP_OWNER>` |
| Role who witnessed | `<INCIDENT_COMMANDER>` |
| Source project | name or ref only |
| Backup id or PITR timestamp | |
| Restore target | must not be the production project |
| Production URL unchanged | yes/no |
| `verify-account-isolation.sql` | list `ok` true/false only |
| Result | pass/fail |
| Notes | no secrets |

A pass requires a target that is not production, isolation SQL with no `ok = false`, and the production app still on the production project.
