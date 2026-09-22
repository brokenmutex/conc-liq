# Development profile registration and paper candidate preview

This is the W1/W2 development interface. It has not been migrated or enabled in
production. The active predecessor RangeKeeper campaign keeps its existing
execution owner. A registered profile permits a draft, not an open operation.

## Register a market profile in an isolated database

Apply migration 4 to the isolated database using the explicit migration tool.
The command server and registration command check schema readiness and do not
run migrations. The same database must contain an enabled `indexer_pools` row
for the stream key, pool, chain, fee, RWA token and target set.

Supply a JSON object with exactly `pool` and `referencePolicy`, using the
RangeKeeper pool and independent-reference schemas. The pool includes the
chain, canonical token order, fee, spacing, token decimals, approved factory,
router, position manager and quoter, their expected code hashes, token feed
identities, `nativeReference: "ETH/USD"` and `numeraire: "USD"`. Do not put a
wallet, signer, private key, RPC URL or allocation in this file.

```sh
DATABASE_URL="$ISOLATED_DATABASE_URL" \
ROBINHOOD_READ_HTTP_URL="$READ_ONLY_RPC_URL" \
INDEXER_STREAM_KEY="$INDEXER_STREAM_KEY" \
PATH=/root/conc-liq/.tools/node/bin:$PATH \
node --import tsx src/deployments-profile-register.ts profile.json
```

The verifier reads a confirmed block, checks the factory/pool/token/contract
relations and code hashes, and requires eligible independent references. The
registration transaction pins the source and reference proof with the current
indexer target set. It returns an ID and profile hash. Repeating the same
profile returns the same ID; a changed profile receives a new ID. If the
indexer target changes or is disabled, the catalog marks that profile
unavailable for new drafts.

## Inspect the development command surface

The separate loopback command service is `src/deployments.ts`. It requires the
isolated database URL, `ROBINHOOD_READ_HTTP_URL` and an operator password hash
in `DEPLOYMENT_OPERATOR_PASSWORD_HASH`. Its authenticated
`GET /api/market-profiles` shows registered profiles and draft availability.
`POST /api/deployments/drafts` creates a revision 1 draft. For a paper draft,
`POST /api/deployments/:id/previews` accepts only `{"kind":"open"}` and returns
a read-only indicative static/manual candidate from a fresh confirmed block.
It exposes explicit unavailable reasons when the source, independent references
or strategy confirmation are missing, or the pool price is outside the
independent-reference band. Its static/manual no-swap path can show provisional
open and retain-close gas when the database has a complete, fresh six-stage
`paper_static_manual_no_swap_v1` exact-call profile for this pool, size and
liquidity share. The profile requires zero-allowance stage evidence, an owned
fork Nitro estimate, a source hash and an observation no older than 24 hours.
The bound combines scoped gas-unit bounds with a 25% current gas-price margin;
it expires with the indicative source and must be refreshed before any future
execution path. It is a modeled expense and bound, not a paid cost or a
validated calibration claim. Missing, stale, rejected, ambiguous or cross-pool
profiles leave the cost unavailable. Swap, fee capture, delay and failure
expenses remain missing; net economics remain null. No profile is automatically inserted by this
command, and no live wallet is used for paper estimation.

For a verified paper draft in an isolated development database,
`src/deployments-paper-gas-sample.ts` can produce a new owned-fork exact-call
report. Set `ANVIL_BIN` to the local Anvil binary and provide the same read-only
RPC URL used for profile verification. Its arguments are the paper draft UUID
and a new output JSON path. It records evidence only; profile ingestion and
validation remain separate work. The first synthetic probe and its limits are
in `docs/research/paper-static-gas-calibration-2026-09-22.md`.

The candidate has no persisted preview ID and `actionAvailable: false`.

`POST /api/deployments/:id/operations` returns 503 until fresh cost preflight,
the paper execution adapter and reconciliation are complete. Live execution is
also unavailable. Do not use the command store's trusted preview/acceptance
methods to bypass that HTTP gate. A profile registration does not authorize
funding, service activation, signing or broadcast.
