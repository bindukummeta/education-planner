# DPIA — UK GDPR and the Age Appropriate Design Code

Status: **OUTSTANDING LEGAL REVIEW**.

This is an engineering assessment written with the product. No lawyer has reviewed it. No external legal approval is claimed. It is not a completed data protection impact assessment under UK GDPR Article 35, and it is not an ICO consultation. Do not describe this file as approved, certified, or legally signed off.

The Age Appropriate Design Code (Children's Code) applies because the app is built for a family and is used with children. The product decisions below are what the code does today. Whether they meet the legal duty is for a lawyer.

## Decisions already made in the product

| Topic | Decision |
| --- | --- |
| Default | Enhanced AI is off. Family Sync does nothing until a parent signs in. Error reports ship off. |
| Who consents | A parent uses Settings and ticks a box on each cloud AI use. The tick is not stored. |
| Coach | The AI coach uses the same Enhanced AI switch and the same per-use tick as worksheet analysis and generated practice. On-device coach cards do not call the network. |
| Minimisation | Coach sends derived totals. It does not send photos, free-text notes, or the child's name as the payload. Practice sends question text. Worksheet analysis sends only the photos the parent chose. |
| Children | The child view of the coach is encouraging and blocks deficit wording in the prompt. It is not an exam decision. |
| High-stakes automation | Suggestions are labelled as suggestions. The parent approves worksheet analysis before it is kept. |
| Geolocation | A postcode can be looked up for a straight-line distance. The app does not take GPS. |
| Sale and ads | Family records are not sold and the app does not show ads. |
| Access and erasure | On-device export works without an account. Cloud export and permanent deletion are in Settings. Deletion order is blobs under `uid/`, owner rows, short-lived quota rows, then the auth user. |
| Logs | Outcome logs are allowlisted. They are not stored in Postgres. The intended host retention is 7 days. |
| Transparency | Settings shows a privacy notice and an AI disclosure. Both say they have not been checked by a lawyer. |

## Children's Code standards

| Standard | What the product does | Gap |
| --- | --- | --- |
| Best interests | Parent-led planning, positive child copy, no scoring sold to a third party. | A lawyer has not assessed best interests. OUTSTANDING LEGAL REVIEW. |
| DPIA | This document records decisions, risks, and mitigations. | It is not a formal DPIA and it has not been reviewed. OUTSTANDING LEGAL REVIEW. |
| Age-appropriate application | Parent accounts. Child surfaces are games and short encouragement. | Age of each child and parental responsibility are not verified. OUTSTANDING LEGAL REVIEW. |
| Transparency | Plain-language notice and AI disclosure in Settings. | Legal wording, identity of the controller, and contact details are not settled. OUTSTANDING LEGAL REVIEW. |
| Detrimental use of data | No automated school decision. AI output is advice. | A lawyer should confirm this is not a decision with legal or similar effect. OUTSTANDING LEGAL REVIEW. |
| Policies | Subprocessor list and deletion runbook exist in the repo. | Privacy policy as a published legal document is not approved. OUTSTANDING LEGAL REVIEW. |
| Default settings | AI off, reports off, sync inert until sign-in. | None in code. Operator must not turn reports on for a wider beta without the legal review. |
| Data minimisation | Derived coach snapshot; local-first storage. | Worksheet photos are still sensitive when the parent opts in. |
| Data sharing | Processors are listed. No sale. | Contracts with Supabase, Anthropic, Vercel, and the others are not signed in this repository. OUTSTANDING LEGAL REVIEW. |
| Geolocation | Postcode lookup only, cached on device. | The lookup provider's retention is outside this app. |
| Parental controls | Master switch, per-use tick, export, cloud deletion, on-device backup. | The switch is on the device. It is not a server-side guarantee if a modified client calls the API. The API still requires the parent's sign-in. |
| Profiling | Progress summaries are for study advice the parent asked for. | Whether this is profiling under UK GDPR, and the lawful basis, is not decided. OUTSTANDING LEGAL REVIEW. |
| Nudge | AI is off by default. Deletion says it cannot be undone. The consent box starts unticked. | A lawyer should review the screens. OUTSTANDING LEGAL REVIEW. |
| Connected toys / online tools | Not used. | None. |

## Risks and mitigations

| Risk | Mitigation in this repo | Left open |
| --- | --- | --- |
| Worksheet photo sent to an AI company | Off by default; per-use tick; server does not store the image. | Anthropic retention and a contract. OUTSTANDING LEGAL REVIEW. |
| Cloud account left behind after a family stops using the app | Settings deletion removes owner rows, `uid/` objects, quota rows for that id, and the auth user. Retry is safe. | Operator must have applied the Supabase migrations. This repo does not run deletion against a live project. |
| Logs identify a child | Allowlist drops names, emails, prompts, images, and tokens. User id is hashed. | Vercel retention must be set to 7 days by an operator. |
| Another family reads synced data | Owner column and `uid/` blob paths. | Isolation SQL and the two-account check are operator steps, documented in `supabase/README.md`. |
| Child uses cloud AI without a parent | The tick and the master switch are in the parent UI. Child games work offline without them. | The app cannot prove who is holding the device. OUTSTANDING LEGAL REVIEW. |
| Local data remains after cloud deletion | The notice says so. On-device export still works. | Clearing the browser is the parent's step for the device copy. |
| Service-role key misuse | Key stays on the server. Export and delete verify the user token first and only then use the service role for that user id. | Hosting project must keep the key out of the client. |

## Outstanding legal review

The following are not done. Nothing in this repository completes them.

- External legal review of this DPIA, the privacy notice, and the AI disclosure.
- Naming the controller and any processors' contracts (Supabase, Anthropic, Vercel, postcodes.io, jsDelivr, Google Fonts).
- Lawful basis, children's age, and parental-responsibility check.
- ICO consultation, if a lawyer says Article 35 requires it.
- Anthropic (and other) retention terms accepted by the operator.
- A published privacy policy and a contact route for people to exercise rights outside the in-app buttons.

Until those are done, keep Family Sync and Enhanced AI limited to people who understand this is an unreviewed prototype.
