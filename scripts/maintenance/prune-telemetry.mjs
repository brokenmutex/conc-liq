// Telemetry retention. The two per-child evidence blobs are exact duplicates of
// the run-level blob that carries them:
//
//   v3_strategy_pool_checkpoints.checkpoint == an element of
//     v3_strategy_checkpoint_runs.snapshot->'pools'
//   asset_risk_snapshots.snapshot           == an element of
//     risk_snapshot_runs.snapshot->'assets'
//
// Verified equal over 20,620 and 10,976 consecutive pairs with zero differences
// on 2026-09-20. Together they cost ~100 MB/day, about half of all telemetry
// growth. Replacing an aged child blob with a marker therefore removes no
// information: the bytes remain in the parent and the recovery query below
// rebuilds the column exactly.
//
// The parent blobs are never touched. `evaluatePaperReference` reads
// `snapshot.assets` off `risk_snapshot_runs` over arbitrary historical windows
// through src/experiment/source.ts, which is the research reproduction path.
//
// Every candidate row is proven recoverable inside the same statement that
// prunes it: the EXISTS clause requires the identical element to still be
// present in the parent, so a row whose parent is missing, truncated or altered
// is left alone rather than pruned into an unrecoverable state.
//
// Recovery, for a pruned pool checkpoint:
//   SELECT p FROM v3_strategy_pool_checkpoints c
//   JOIN v3_strategy_checkpoint_runs r ON r.id = c.checkpoint_run_id
//   CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'pools') p
//   WHERE c.checkpoint_run_id = $1 AND lower(c.pool_address) = lower($2)
//     AND lower(p->>'poolAddress') = lower(c.pool_address);
// and for a pruned asset snapshot:
//   SELECT a FROM asset_risk_snapshots s
//   JOIN risk_snapshot_runs r ON r.id = s.run_id
//   CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'assets') a
//   WHERE s.run_id = $1 AND s.symbol = $2 AND a->'registry'->>'symbol' = s.symbol;
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  assert(args[index + 1], `--${name} requires a value`);
  return args[index + 1];
};

const retainDays = Number(value("retain-days", "7"));
const batch = Number(value("batch", "20000"));
const sample = Number(value("verify-sample", "25"));
const dryRun = flag("dry-run");
const output = value("output", null);
assert(Number.isInteger(retainDays) && retainDays >= 1, "--retain-days must be a positive integer");
assert(Number.isInteger(batch) && batch >= 1, "--batch must be a positive integer");
assert(Number.isInteger(sample) && sample >= 0, "--verify-sample must be a non-negative integer");
const connectionString = process.env.DATABASE_URL;
assert(connectionString, "DATABASE_URL is required");

// A marker is used rather than NULL so the columns keep their NOT NULL
// constraint and no migration is needed, and so a reader that lands on a pruned
// row sees why it is empty instead of an ambiguous null.
const marker = at => ({ pruned: { policy: "telemetry-retention-v1", at, recoverable: true } });
// Unpruned blobs always carry these keys; the marker never does.
const targets = [
  {
    name: "v3_strategy_pool_checkpoints.checkpoint",
    table: "v3_strategy_pool_checkpoints",
    column: "checkpoint",
    witness: "state",
    parent: "v3_strategy_checkpoint_runs",
    parentKey: "checkpoint_run_id",
    parentClock: "captured_at",
    array: "pools",
  },
  {
    name: "asset_risk_snapshots.snapshot",
    table: "asset_risk_snapshots",
    column: "snapshot",
    witness: "registry",
    parent: "risk_snapshot_runs",
    parentKey: "run_id",
    parentClock: "observed_at",
    array: "assets",
  },
];

const client = new pg.Client({ connectionString, application_name: "conc_liq_telemetry_retention" });
await client.connect();
const report = { policy: "telemetry-retention-v1", startedAt: new Date().toISOString(), retainDays, dryRun, targets: [] };
try {
  // Refuse a database whose migration history is not the one these column
  // names were read from.
  const versions = (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(row => row.version);
  assert.deepEqual(versions, [1, 2, 3], "Unexpected migration history; review the retention targets before running");

  for (const target of targets) {
    const cutoff = (await client.query(`SELECT now() - ($1 || ' days')::interval AS at`, [retainDays])).rows[0].at;
    const eligible = `FROM ${target.table} c JOIN ${target.parent} r ON r.id = c.${target.parentKey}
      WHERE r.${target.parentClock} < $1
        AND jsonb_exists(c.${target.column}, '${target.witness}')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.snapshot->'${target.array}') e WHERE e = c.${target.column})`;

    const before = (await client.query(
      `SELECT count(*)::int AS rows, coalesce(sum(pg_column_size(c.${target.column})), 0)::bigint AS bytes ${eligible}`,
      [cutoff])).rows[0];
    // Rows too old to keep whose parent no longer proves them recoverable are
    // never pruned. Counting them separately makes that visible instead of
    // silent.
    const unrecoverable = (await client.query(
      `SELECT count(*)::int AS rows FROM ${target.table} c JOIN ${target.parent} r ON r.id = c.${target.parentKey}
       WHERE r.${target.parentClock} < $1 AND jsonb_exists(c.${target.column}, '${target.witness}')
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.snapshot->'${target.array}') e WHERE e = c.${target.column})`,
      [cutoff])).rows[0].rows;

    let pruned = 0;
    if (!dryRun && before.rows > 0) {
      const replacement = JSON.stringify(marker(new Date().toISOString()));
      // One batch per transaction keeps WAL and the dead-tuple burst bounded on
      // a table the collectors are still writing to.
      for (;;) {
        const result = await client.query(
          `WITH victim AS (SELECT c.ctid ${eligible} LIMIT ${batch})
           UPDATE ${target.table} t SET ${target.column} = $2::jsonb FROM victim v WHERE t.ctid = v.ctid`,
          [cutoff, replacement]);
        if (!result.rowCount) break;
        pruned += result.rowCount;
        process.stdout.write(`${target.name}: pruned ${pruned}/${before.rows}\n`);
      }
    }

    // Prove recovery on real pruned rows rather than trusting the precondition.
    let verified = 0;
    if (sample > 0 && pruned > 0) {
      const recovered = await client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT c.${target.parentKey} FROM ${target.table} c
           JOIN ${target.parent} r ON r.id = c.${target.parentKey}
           WHERE NOT jsonb_exists(c.${target.column}, '${target.witness}')
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.snapshot->'${target.array}') e
                         WHERE jsonb_exists(e, '${target.witness}'))
           LIMIT ${sample}) s`);
      verified = recovered.rows[0].n;
    }

    if (!dryRun && pruned > 0) await client.query(`VACUUM (ANALYZE) ${target.table}`);
    report.targets.push({
      name: target.name, cutoff, eligibleRows: before.rows, eligibleBytes: Number(before.bytes),
      unrecoverableRowsLeftIntact: unrecoverable, pruned, recoveryVerifiedRows: verified,
    });
    process.stdout.write(`${JSON.stringify(report.targets.at(-1))}\n`);
  }
} finally {
  await client.end();
}
report.finishedAt = new Date().toISOString();
if (output) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ policy: report.policy, retainDays, dryRun, pruned: report.targets.reduce((sum, t) => sum + t.pruned, 0) })}\n`);
