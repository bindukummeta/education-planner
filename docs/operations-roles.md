# Operational roles

Names below are roles. Fill the angle brackets in your own roster. This document does not name a person.

| Role | Owns | Escalates to |
| --- | --- | --- |
| `<INCIDENT_COMMANDER>` | An active incident: outage, suspected cross-account access, or a bad deploy. Decides rollback versus fix-forward. | `<PLATFORM_OWNER>` |
| `<SECURITY_ALERT_OWNER>` | Security-shaped alerts: auth failures, isolation check failures, unexpected service-role use. | `<SECURITY_ALERT_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>` |
| `<BILLING_ALERT_OWNER>` | Anthropic spend, Vercel spend, and Supabase plan alerts. | `<BILLING_ALERT_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>` |
| `<MIGRATION_OWNER>` | SQL order in [release-checklist.md](release-checklist.md), applied to one environment at a time. | `<MIGRATION_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>` |
| `<BACKUP_OWNER>` | Backup/PITR enablement and the restore drill. | `<BACKUP_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>` |
| `<PRIVACY_OWNER>` | Account export and deletion failures. See [runbooks/account-deletion.md](runbooks/account-deletion.md). | `<PRIVACY_OWNER_DEPUTY>`, then `<INCIDENT_COMMANDER>` |
| `<PLATFORM_OWNER>` | Last escalation when a provider console is unreachable or a role is vacant. | Provider support for Vercel, Supabase, or Anthropic |
| `<BETA_OPERATOR>` | The invited-beta allowlist and the weekly review. Does not launch a beta by editing this file. | `<MIGRATION_OWNER>`, then `<INCIDENT_COMMANDER>` |

## Rules

- One person may hold two roles. Write that in the roster. Do not leave a production alert without a role.
- Deputies are `<ROLE_DEPUTY>` for the same role. If the deputy is also vacant, go to `<INCIDENT_COMMANDER>`.
- Do not put email addresses or legal names in this repository.
- A role does not share the service-role key or the Anthropic key in chat. Rotation steps are in [runbooks/key-rotation.md](runbooks/key-rotation.md).
- Staging incidents stay on the staging project. Do not "compare with production" by copying production data into staging.

## Roster (fill outside git)

| Role | Holder | Deputy | How to reach |
| --- | --- | --- | --- |
| `<INCIDENT_COMMANDER>` | | | |
| `<SECURITY_ALERT_OWNER>` | | | |
| `<BILLING_ALERT_OWNER>` | | | |
| `<MIGRATION_OWNER>` | | | |
| `<BACKUP_OWNER>` | | | |
| `<PRIVACY_OWNER>` | | | |
| `<PLATFORM_OWNER>` | | | |
| `<BETA_OPERATOR>` | | | |

Store the filled roster where your team already keeps contacts. Do not commit it.
