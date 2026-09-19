import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

const connectionString = "postgresql://root@localhost/conc_liq?host=/var/run/postgresql";
const streamKey = "robinhood-v3-rwa-usdg-v1";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-dir");
const compressionIndex = args.indexOf("--compression-level");
assert(outputIndex >= 0 && args[outputIndex + 1],
  "Usage: archive-research-database.mjs --output-dir /absolute/path [--compression-level 1..19]");
const outputDirectory = resolve(args[outputIndex + 1]);
const compressionLevel = compressionIndex < 0 ? 19 : Number(args[compressionIndex + 1]);
assert(outputDirectory.startsWith("/"), "Archive output directory must be absolute");
assert(Number.isInteger(compressionLevel) && compressionLevel >= 1 && compressionLevel <= 19,
  "Compression level must be an integer from 1 through 19");
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const checkpointStart = "2026-09-07T19:30:00Z";
const checkpointEnd = "2026-09-18T13:01:51.157Z";
const universeFromBlock = "62046775";
const universeToBlock = "66244585";
const simulationBounds = [
  ["NVDA", "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", "57085047", "65424246"],
  ["AAPL", "0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d", "61805157", "65424236"],
  ["GOOGL", "0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7", "61805157", "65424236"],
  ["MSFT", "0xeb60bcd1d920ad6e102690ccfc6fb488899e1510", "62002374", "65424236"],
  ["GLD", "0x7a6a053eccf1446a2633e05aa6d40d09381997ec", "62002374", "65424236"]
];

const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const runs = `SELECT c.* FROM public.v3_strategy_checkpoint_runs c WHERE c.stream_key=${literal(streamKey)} ` +
  `AND c.block_timestamp BETWEEN ${literal(checkpointStart)}::timestamptz AND ${literal(checkpointEnd)}::timestamptz ORDER BY c.id`;
const riskIds = `SELECT c.risk_run_id FROM public.v3_strategy_checkpoint_runs c WHERE c.stream_key=${literal(streamKey)} ` +
  `AND c.block_timestamp BETWEEN ${literal(checkpointStart)}::timestamptz AND ${literal(checkpointEnd)}::timestamptz`;
const runIds = `SELECT c.id FROM public.v3_strategy_checkpoint_runs c WHERE c.stream_key=${literal(streamKey)} ` +
  `AND c.block_timestamp BETWEEN ${literal(checkpointStart)}::timestamptz AND ${literal(checkpointEnd)}::timestamptz`;
const simulationValues = simulationBounds.map(([, pool, first, last]) =>
  `(${literal(pool)},${first}::numeric,${last}::numeric)`).join(",");
const eventSelection = `WITH sim(pool,min_block,max_block) AS (VALUES ${simulationValues}) ` +
  `SELECT e.* FROM public.v3_pool_events e WHERE e.stream_key=${literal(streamKey)} AND (` +
  `EXISTS (SELECT 1 FROM sim s WHERE LOWER(e.pool_address)=s.pool AND (` +
  `(e.block_number>s.min_block AND e.block_number<=s.max_block) OR ` +
  `(e.block_number<=s.min_block AND e.event_name IN ('Mint','Burn','SetFeeProtocol')))) OR ` +
  `(e.event_name='Swap' AND e.block_number BETWEEN ${universeFromBlock} AND ${universeToBlock} AND EXISTS (` +
  `SELECT 1 FROM public.indexer_pools p WHERE p.stream_key=e.stream_key AND p.enabled AND LOWER(p.pool_address)=LOWER(e.pool_address)))) ` +
  `ORDER BY e.stream_key,e.block_number,e.transaction_index,e.log_index,e.transaction_hash`;

const exports = [
  { table: "indexer_pools", query: `SELECT * FROM public.indexer_pools WHERE stream_key=${literal(streamKey)} ORDER BY stream_key,pool_address` },
  { table: "indexer_cursors", query: `SELECT * FROM public.indexer_cursors WHERE stream_key=${literal(streamKey)} ORDER BY stream_key` },
  { table: "v3_replay_cursors", query: `SELECT * FROM public.v3_replay_cursors WHERE stream_key=${literal(streamKey)} ORDER BY stream_key` },
  { table: "risk_snapshot_runs", query: `SELECT r.* FROM public.risk_snapshot_runs r WHERE r.id IN (${riskIds}) ORDER BY r.id` },
  { table: "asset_risk_snapshots", query: `SELECT a.* FROM public.asset_risk_snapshots a WHERE a.run_id IN (${riskIds}) ORDER BY a.run_id,a.symbol` },
  { table: "risk_snapshot_canonicality", query: `SELECT v.* FROM public.risk_snapshot_canonicality v WHERE v.risk_run_id IN (${riskIds}) ORDER BY v.risk_run_id` },
  { table: "v3_strategy_checkpoint_runs", query: runs },
  { table: "v3_strategy_pool_checkpoints", query: `SELECT p.* FROM public.v3_strategy_pool_checkpoints p WHERE p.checkpoint_run_id IN (${runIds}) ORDER BY p.checkpoint_run_id,p.pool_address` },
  { table: "v3_pool_events", query: eventSelection }
];
const tables = exports.map(item => `public.${item.table}`);
const stagingDirectory = mkdtempSync(join(tmpdir(), "conc-liq-research-db-"));
const hashFile = path => {
  const result = spawnSync("sha256sum", [path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sha256sum failed for ${path}: ${String(result.stderr).trim()}`);
  const digest = result.stdout.split(/\s+/)[0];
  assert.match(digest, /^[a-f0-9]{64}$/, `Invalid SHA-256 output for ${path}`);
  return digest;
};
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
const canonical = value => JSON.stringify(canonicalize(value));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result;
}

function archiveDirectory(source, destination, level) {
  return new Promise((resolvePromise, reject) => {
    const tar = spawn("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-C", source, "-cf", "-", "."],
      { stdio: ["ignore", "pipe", "pipe"] });
    const zstd = spawn("zstd", [`-${level}`, "-T0", "-q", "-o", destination], { stdio: ["pipe", "ignore", "pipe"] });
    tar.stdout.pipe(zstd.stdin);
    let errors = "";
    tar.stderr.on("data", chunk => { errors += chunk; });
    zstd.stderr.on("data", chunk => { errors += chunk; });
    let tarStatus;
    let zstdStatus;
    const finish = () => {
      if (tarStatus === undefined || zstdStatus === undefined) return;
      if (tarStatus === 0 && zstdStatus === 0) resolvePromise();
      else {
        rmSync(destination, { force: true });
        reject(new Error(`archive pipeline failed: ${errors.trim()}`));
      }
    };
    tar.on("close", code => { tarStatus = code; finish(); });
    zstd.on("close", code => { zstdStatus = code; finish(); });
    tar.on("error", reject);
    zstd.on("error", reject);
  });
}

const client = new pg.Client({ connectionString });
let committed = false;
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
  assert.match(snapshot, /^[0-9A-Fa-f-]+$/, "Unexpected PostgreSQL snapshot identifier");
  const database = (await client.query("SELECT current_database() AS database, version() AS version, pg_database_size(current_database())::text AS bytes")).rows[0];

  const schemaPath = join(stagingDirectory, "schema.dump");
  const schemaFd = openSync(schemaPath, "w", 0o600);
  try {
    run("pg_dump", [connectionString, "--format=custom", "--schema-only", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`,
      ...tables.flatMap(table => ["--table", table])], { stdio: ["ignore", schemaFd, "pipe"] });
  } finally {
    closeSync(schemaFd);
  }

  const files = [{ name: "schema.dump", role: "schema", bytes: statSync(schemaPath).size, sha256: hashFile(schemaPath) }];
  for (const item of exports) {
    const name = `${item.table}.bin`;
    const destination = join(stagingDirectory, name);
    const script = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT ${literal(snapshot)};\n` +
      `\\copy (${item.query}) TO ${literal(destination)} WITH (FORMAT binary)\nCOMMIT;\n`;
    const result = run("psql", [connectionString, "-X", "-v", "ON_ERROR_STOP=1"], { input: script });
    const match = result.stdout.match(/COPY\s+(\d+)/);
    assert(match, `${item.table}: COPY row count missing`);
    files.push({ name, role: "table_data", table: item.table, rows: Number(match[1]),
      bytes: statSync(destination).size, sha256: hashFile(destination) });
    console.error(JSON.stringify({ table: item.table, rows: Number(match[1]), bytes: statSync(destination).size }));
  }
  await client.query("COMMIT");
  committed = true;

  const manifestBase = {
    schemaVersion: 1,
    studyId: "strategy-redesign-2026-09-18",
    createdAt: new Date().toISOString(),
    source: { database: database.database, databaseBytes: Number(database.bytes), postgresVersion: database.version,
      transactionIsolation: "repeatable read read only" },
    selection: { streamKey, checkpointStart, checkpointEnd, universeFromBlock, universeToBlock,
      simulationBounds: simulationBounds.map(([symbol, pool, firstBlock, lastBlock]) => ({ symbol, pool, firstBlock, lastBlock })) },
    exclusions: ["paper runtime state", "live-pilot custody and accounting", "transaction receipts", "environment files", "credentials", "signer material"],
    restoreOrder: exports.map(item => item.table),
    files
  };
  const contentId = createHash("sha256").update(canonical(manifestBase)).digest("hex");
  const manifest = { ...manifestBase, contentId };
  writeFileSync(join(stagingDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const archivePath = join(outputDirectory, `${contentId}.tar.zst`);
  assert(!existsSync(archivePath), `Archive already exists: ${archivePath}`);
  await archiveDirectory(stagingDirectory, archivePath, compressionLevel);
  console.log(JSON.stringify({ archivePath, contentId, archiveBytes: statSync(archivePath).size,
    archiveSha256: hashFile(archivePath), compressionLevel, files: files.length, tables: exports.length }));
} finally {
  if (!committed) {
    try { await client.query("ROLLBACK"); } catch {}
  }
  try { await client.end(); } catch {}
  rmSync(stagingDirectory, { recursive: true, force: true });
}
