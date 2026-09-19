import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { researchDatabaseUrl } from "../sim-source.mjs";

const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(args[index + 1] && !args[index + 1].startsWith("--"), `Missing value for ${name}`);
  return args[index + 1];
};
const allowed = new Set(["--output", "--samples", "--interval-ms", "--stream-key"]);
for (let index = 0; index < args.length; index += 2) {
  assert(allowed.has(args[index]) && args[index + 1],
    "Usage: capture-indexer-cursor-probe.mjs --output FILE [--samples 600] [--interval-ms 100] [--stream-key KEY]");
}

const outputValue = valueFor("--output");
assert(outputValue, "--output is required");
const output = resolve(outputValue);
const samples = Number(valueFor("--samples", "600"));
const intervalMs = Number(valueFor("--interval-ms", "100"));
const streamKey = valueFor("--stream-key", "robinhood-v3-rwa-usdg-v1");
assert(Number.isInteger(samples) && samples >= 1 && samples <= 10_000, "samples must be an integer from 1 through 10000");
assert(Number.isInteger(intervalMs) && intervalMs >= 10 && intervalMs <= 60_000,
  "interval-ms must be an integer from 10 through 60000");
assert(/^[a-z0-9][a-z0-9_-]+$/.test(streamKey), "stream-key is invalid");
assert(!existsSync(output), `Refusing to overwrite existing evidence: ${output}`);
assert(existsSync(dirname(output)) && statSync(dirname(output)).isDirectory(), "Output directory does not exist");

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const client = new pg.Client({
  connectionString: researchDatabaseUrl(),
  options: "-c default_transaction_read_only=on -c statement_timeout=5000"
});
const rows = [];
const startedAt = new Date().toISOString();
try {
  await client.connect();
  for (let sample = 1; sample <= samples; sample += 1) {
    const result = await client.query(`SELECT clock_timestamp() AS observed_at,
      next_block::text AS next_block, last_scanned_block::text AS last_scanned_block,
      covered_through_block::text AS covered_through_block, updated_at,
      txid_current_snapshot()::text AS transaction_snapshot
      FROM indexer_cursors WHERE stream_key=$1`, [streamKey]);
    assert.equal(result.rows.length, 1, `Cursor ${streamKey} is missing or duplicated`);
    rows.push({ sample, ...result.rows[0] });
    if (sample < samples) await sleep(intervalMs);
  }
} finally {
  await client.end().catch(() => {});
}

const report = {
  schemaVersion: 1,
  evidenceClass: "time_bounded_observation",
  startedAt,
  completedAt: new Date().toISOString(),
  streamKey,
  requestedSamples: samples,
  intervalMs,
  rows
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ output, samples: rows.length, startedAt, completedAt: report.completedAt }));
