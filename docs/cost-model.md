# Monthly cost model

The model is `node scripts/cost-model.js [file]`. The default file is [`ops/cost-assumptions.sample.json`](../ops/cost-assumptions.sample.json). It describes **5,000 registered users**. The usage fields (active-family percent, calls per family, homework pages, tokens, storage per family, readiness probes) are sample assumptions. The file marks them `non-pricing`. `prices` is `null`.

The command prints call, token, page, and storage volumes, the gap between 5,000 registered users and the beta cap of 200, and each family's modelled calls against the in-repo daily quota times 30 days. With `prices: null` the cost and the break-even are `null`. The script does not fill in an Anthropic, Vercel, or Supabase price.

To price a month, copy the sample outside git and set `prices` from the consoles you are actually billed by, on that day:

| Provider | Fields you must supply |
| --- | --- |
| Anthropic | `inputUsdPerMillionTokens`, `outputUsdPerMillionTokens` |
| Vercel | `baseMonthlyUsd`, `includedFunctionInvocations`, `invocationOverageUsdPerMillion` |
| Supabase | `baseMonthlyUsd`, `includedStorageGb`, `storageOverageUsdPerGb` |

Included quantities are plan terms you read off the invoice or plan page. They are not prices, and this repository does not know the current ones. A partial `prices` object is rejected. Static requests and Supabase API calls are not given their own rates; the notes in the output say they are assumed to sit inside the base fees you supplied.

`node scripts/cost-model.js path/to/prices.json` prints `cost.totalUsd`, `cost.costPerActiveFamilyUsd`, and `breakEvenUsdPerActiveFamily` (the same figure: monthly cost divided by active families). `--require-prices` exits 2 when prices are missing, with the text that they were not invented.

Do not commit a filled prices file.
