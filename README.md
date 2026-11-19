[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/Lxq516008/make-lxq-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/Lxq516008/make-lxq-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar

A token launch radar: it ranks the protocols in a sealed DefiLlama snapshot that have no token on record, by an implied token value, and renders the ranking as a static dashboard with a concrete farm plan for each protocol.

Built by an AI agent for make.fun's “Build the best token launch radar” bounty, $1,325 in USDC.

[make.fun](https://make.fun/?ref=a0pz932n&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## What it does

- Reads `snapshot.json`: 758 protocols with TVL, 7-day change, listing date and token status, as of 2026-11-14, plus a 40-protocol watchlist (TVL ≥ $50M, no token).
- Ranks every launchable pre-token protocol: all 40 watchlist protocols plus 158 pre-token protocols below the floor — 198 rows in total. Wrapped, staked and bridged products, versioned copies and exchange products are not ranked, because their token already exists elsewhere.
- Writes `board.json` (the ranked board), `data.js` (the dashboard data), `dashboard/` (a static page: sortable and filterable table, per-protocol detail view with the model breakdown and farm plan, live-token list set aside) and `dossier.json` (the dashboard dossier).
- Sets aside the top 24 live-token protocols by market cap, shown with their market caps as facts, not models.

## The model (radar-2)

```
implied = round( TVL × category multiple × (1 + clamp(change_7d, -60, 120) / 100 × 0.5)
                 × (0.6 + min(age_days, 1095) / 1095 × 0.4) )
```

- **Category multiple**: the median market-cap / TVL ratio of the live-token protocols in the same category (at least 3 with both figures, else the global median 0.21× over the 128 live protocols that carry both), clamped to [0.05, 2.0]. A DEX's token trades at a different multiple of TVL than a lender's, and the snapshot says so — this is calibrated on the snapshot itself, not a flat constant. Protocols with a non-positive TVL or market cap are left out of the calibration: one live protocol in the snapshot carries a market cap of -1.
- **Growth**: 7-day TVL change, clamped to [-60%, +120%]; a missing change counts as 0.
- **Maturity**: days since first listing, the snapshot's only record of how long a protocol has run with no token; an unlisted age uses 365 days.

Each protocol also gets a six-step farm plan with a cost and a time per step, derived from its category, chains, TVL and age only. No protocol name is special-cased anywhere.

Implied value is a model, not a promise.

## Run it

Requires Node.js 22.18 or later. No dependencies, no network.

```sh
node main.ts --input input/snapshot.json --output out
```

`--input` is the snapshot file or the directory holding `snapshot.json` (default `/input`). `--output` is the directory to write to (default `$MAKEFUN_OUTPUT_DIR`, else `/output`). The run is deterministic: the same snapshot always writes the same bytes, and it runs twice with identical output.

The dashboard is static: open `out/dashboard/index.html` in a browser. The URL hash deep-links a view — `#p=<slug>` opens a protocol's detail, `#category=Dexs` filters by category, `#watchlist=1` shows the watchlist only, `#tab=live` shows the live-token list.

## Layout

```
main.ts            entrypoint: reads the snapshot, writes board.json, data.js,
                   dashboard/, screenshots/ and dossier.json
lib/model.ts       the value model, the farm plans and the board builder
dashboard/         the static page (index.html, app.css, app.js)
screenshots/      the three dashboard views: board, detail, filtered
vendor/            make.fun's dossier library (buildDossier), copied from the kit
```

## License

MIT — see [LICENSE](LICENSE).
