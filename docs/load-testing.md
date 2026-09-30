# Load and soak

The harness is local and synthetic. It serves `index.html` on `127.0.0.1`, calls the readiness handler in process, runs `sync.js` against an in-memory owner-scoped client, and calls the coach, practice, and homework handlers with injected auth, quota, and beta admission. The model fetch returns canned JSON and is not `api.anthropic.com` over the network. `globalThis.fetch` is replaced so a stray call fails the run. There are no child names, worksheet photos, or live project keys.

Each scenario prints `count`, `errors`, `p50`, `p95`, and `p99`. Thresholds in [`ops/load-thresholds.json`](../ops/load-thresholds.json) are tighter than the 28-day SLO tails because the provider is fake. Any error fails the run.

## CI smoke

```sh
npm run test:load
```

That is `--profile smoke`. Continuous integration runs this and refuses `--profile heavy` and `--profile soak`.

## Heavier local runs

These are not CI and they are not pointed at production.

```sh
npm run test:load:heavy
node scripts/load-harness.js --profile soak --seconds 60
```

Soak repeats the small batch until the seconds elapse (maximum 600) and then applies the same thresholds to the combined samples. Do not direct either command at a deployed origin.
