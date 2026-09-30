# Subprocessors

Status: **OUTSTANDING LEGAL REVIEW**.

This list is an engineering record of companies the app contacts. No contract in this repository appoints them. No lawyer has approved the list. It is not an official approval.

The machine-readable copy is `privacy.js` (`EduPrivacy.PROCESSORS`). The data each one sees is also in [data-inventory.md](data-inventory.md).

| Name | Purpose | Data | Contract status |
| --- | --- | --- | --- |
| Supabase | Family Sync sign-in, `public.records`, and the private `blobs` bucket. | Account email, synced rows owned by that account, photos at `uid/<id>`. | Outstanding — not signed in this repository. |
| Anthropic | Coach, enhanced worksheet analysis, and generated practice, only after Enhanced AI is on and the parent ticks the box for that use. | Derived progress summary, chosen worksheet images, or question text and answers. This app does not store the request after the reply. | Outstanding — not signed in this repository. Provider retention is not controlled here. |
| Vercel | Hosts the site and the API. Stores allowlisted outcome logs. | Request metadata and the log fields in [observability.md](observability.md). Not the child's work. Intended retention 7 days, set by an operator. | Outstanding — not signed in this repository. |
| postcodes.io | Postcode to coordinate, for distance to a school. | The postcode the parent types. Not the child's name. | Outstanding — not signed in this repository. |
| jsDelivr | Delivers the Supabase browser library. | Connection data. Family records are not part of that request. | Outstanding — not signed in this repository. |
| Google Fonts | Heading font. | Connection data. Family records are not part of that request. | Outstanding — not signed in this repository. |

This device (the browser) stores IndexedDB and `localStorage`. It is not a company. On-device export does not add a processor.

The app does not sell family information and does not use an advertising network.

If a processor is added, update `privacy.js`, this page, and the data inventory together, and leave the legal-review status outstanding until a lawyer has actually reviewed the change.
