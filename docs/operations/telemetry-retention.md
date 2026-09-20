# Telemetry retention

Collector telemetry, not the event store, is the larger half of database growth.
Measured on 2026-09-19, of roughly 465 MB/day: `v3_pool_events` contributed
156 MB, while the 20 s strategy checkpoint and 10 s risk snapshot contributed
about 205 MB between them.

Most of that telemetry is stored twice.

## The duplication

Each run writes one row-level blob and a set of per-child blobs holding the same
bytes:

| Child column | Identical element of |
| --- | --- |
| `v3_strategy_pool_checkpoints.checkpoint` | `v3_strategy_checkpoint_runs.snapshot->'pools'` |
| `asset_risk_snapshots.snapshot` | `risk_snapshot_runs.snapshot->'assets'` |

This was verified exhaustively on 2026-09-20: the documented recovery queries
below reproduced the stored child blob **exactly** on 299,532 of 299,532 pool
checkpoints and 212,979 of 212,979 asset snapshots, with zero differences.

The child blobs are the copy that can go. Nothing reads
`v3_strategy_pool_checkpoints.checkpoint` at all, and the only readers of
`asset_risk_snapshots.snapshot` — the dashboard asset panel and
`perp-basis/store.ts` — both select it from the latest run only
(`ORDER BY ... DESC LIMIT 1`).

The parent blobs are never pruned. `evaluatePaperReference` reads
`snapshot.assets` off `risk_snapshot_runs` over arbitrary historical windows via
`src/experiment/source.ts`, which is the research reproduction path.

## The policy

`scripts/maintenance/prune-telemetry.mjs`, installed as
`conc-liq-telemetry-retention.timer` and run daily at 04:20, replaces each child
blob older than `--retain-days` (default 7) with a marker:

```json
{"pruned":{"policy":"telemetry-retention-v1","at":"…","recoverable":true}}
```

A marker rather than `NULL` keeps the columns `NOT NULL`, so **no migration is
required** and no collector needs upgrading. A reader that lands on a pruned row
sees why the blob is empty instead of an ambiguous null.

Scalar columns are never touched. `tick`, `sqrt_price_x96`, `liquidity`, both
`fee_growth_global*_x128`, `pool_price_x18`, `oracle_price_x18`,
`deviation_ppm`, `status`, `reasons`, `execution_eligible` and the oracle round
ids all remain for the full life of the database, so the price, liquidity,
fee-growth and risk-decision time series stay complete indefinitely. Only the
verbose evidence copy is dropped, and only where it still exists in the parent.

## The safety property

No row is pruned unless the same statement proves it recoverable. The update's
predicate requires the identical element to still be present in the parent:

```sql
AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.snapshot->'pools') e
            WHERE e = c.checkpoint)
```

A child whose parent is missing, truncated or altered fails that test and is
left intact. The job reports such rows as `unrecoverableRowsLeftIntact` rather
than skipping them silently. It also refuses to run against any database whose
migration history is not exactly `1,2,3`, and verifies recovery on a sample of
genuinely pruned rows after each pass.

This makes the policy a deduplication, not a lossy retention: every pruned byte
is still in the database.

## Recovery

```sql
-- a pruned pool checkpoint
SELECT p FROM v3_strategy_pool_checkpoints c
JOIN v3_strategy_checkpoint_runs r ON r.id = c.checkpoint_run_id
CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'pools') p
WHERE c.checkpoint_run_id = $1 AND lower(c.pool_address) = lower($2)
  AND lower(p->>'poolAddress') = lower(c.pool_address);

-- a pruned asset snapshot
SELECT a FROM asset_risk_snapshots s
JOIN risk_snapshot_runs r ON r.id = s.run_id
CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'assets') a
WHERE s.run_id = $1 AND s.symbol = $2
  AND a->'registry'->>'symbol' = s.symbol;
```

A pruned row is identified by `NOT jsonb_exists(<column>, 'state')` for
checkpoints and `NOT jsonb_exists(<column>, 'registry')` for asset snapshots.

## First run

2026-09-20, `--retain-days 7`: 15,253 pool checkpoints and 103,492 asset
snapshots pruned, 172 MB of blob bytes released, zero unrecoverable rows. As
with any `UPDATE`, the space is released for reuse inside the tables rather than
returned to the filesystem, which is what caps growth; the table files do not
shrink. Steady state is about 100 MB/day no longer accumulating.

Both tables carry `autovacuum_vacuum_scale_factor=0.05` so the daily update
churn is collected promptly.

## Not covered by this policy

`rpc_health_samples` is a separate 7-day **deletion** policy, because it has no
duplicate parent. It was archived before its first prune; see
`research/archives/rpc-health-samples-2026-09-20-receipt.json`.
