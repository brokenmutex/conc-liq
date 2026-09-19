import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const archiveIndex = args.indexOf("--archive");
const sudoAdmin = args.includes("--admin-via-sudo-postgres");
assert(archiveIndex >= 0 && args[archiveIndex + 1],
  "Usage: verify-research-database-archive.mjs --archive /absolute/object.tar.zst [--admin-via-sudo-postgres]");
const archivePath = resolve(args[archiveIndex + 1]);
assert(archivePath.startsWith("/") && existsSync(archivePath) && statSync(archivePath).isFile(),
  "Archive must be an existing absolute file");
const restoreDatabase = `conc_liq_research_restore_${process.pid}`;
assert.match(restoreDatabase, /^conc_liq_research_restore_[0-9]+$/, "Unsafe restore database name");
const restoreConnection = `postgresql://root@localhost/${restoreDatabase}?host=/var/run/postgresql`;
const extractionDirectory = mkdtempSync(join(tmpdir(), "conc-liq-research-restore-"));
let databaseCreated = false;

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
const canonical = value => JSON.stringify(canonicalize(value));
const hashFile = path => {
  const result = spawnSync("sha256sum", [path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sha256sum failed for ${path}: ${String(result.stderr).trim()}`);
  const digest = result.stdout.split(/\s+/)[0];
  assert.match(digest, /^[a-f0-9]{64}$/, `Invalid SHA-256 output for ${path}`);
  return digest;
};
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
  return result;
}
function createRestoreDatabase() {
  if (sudoAdmin) {
    run("sudo", ["-n", "-u", "postgres", "createdb", "--owner=root", restoreDatabase]);
    return "sudo-postgres";
  }
  run("createdb", ["-h", "/var/run/postgresql", "-U", "root", restoreDatabase]);
  return "root";
}
function dropRestoreDatabase() {
  if (sudoAdmin) {
    run("sudo", ["-n", "-u", "postgres", "dropdb", "--if-exists", restoreDatabase]);
    return;
  }
  run("dropdb", ["-h", "/var/run/postgresql", "-U", "root", restoreDatabase]);
}
function extractArchive(source, destination) {
  return new Promise((resolvePromise, reject) => {
    const zstd = spawn("zstd", ["-d", "-c", source], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-C", destination, "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"] });
    zstd.stdout.pipe(tar.stdin);
    let errors = "";
    zstd.stderr.on("data", chunk => { errors += chunk; });
    tar.stderr.on("data", chunk => { errors += chunk; });
    let zstdStatus;
    let tarStatus;
    const finish = () => {
      if (zstdStatus === undefined || tarStatus === undefined) return;
      if (zstdStatus === 0 && tarStatus === 0) resolvePromise();
      else reject(new Error(`archive extraction failed: ${errors.trim()}`));
    };
    zstd.on("close", code => { zstdStatus = code; finish(); });
    tar.on("close", code => { tarStatus = code; finish(); });
    zstd.on("error", reject);
    tar.on("error", reject);
  });
}

try {
  const members = run("tar", ["--use-compress-program=unzstd", "-tf", archivePath]).stdout
    .split("\n").filter(Boolean);
  assert.equal(members[0], "./", "Archive root entry is invalid");
  assert.equal(new Set(members).size, members.length, "Archive contains duplicate entries");
  for (const member of members.slice(1)) {
    assert.match(member, /^\.\/(?:manifest\.json|schema\.dump|[a-z0-9_]+\.bin)$/,
      `Archive contains an unsafe or unexpected entry: ${member}`);
  }
  await extractArchive(archivePath, extractionDirectory);
  const manifestPath = join(extractionDirectory, "manifest.json");
  assert(lstatSync(manifestPath).isFile(), "Archive manifest is not a regular file");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported database archive schema");
  assert.equal(manifest.studyId, "strategy-redesign-2026-09-18", "Unexpected archive study");
  const { contentId, ...manifestBase } = manifest;
  const expectedContentId = createHash("sha256").update(canonical(manifestBase)).digest("hex");
  assert.equal(contentId, expectedContentId, "Archive manifest content ID is invalid");
  assert.equal(basename(archivePath), `${contentId}.tar.zst`, "Archive filename does not match its content ID");
  const expectedMembers = ["./", "./manifest.json", ...manifest.files.map(file => `./${file.name}`)].sort();
  assert.deepEqual([...members].sort(), expectedMembers, "Archive members do not exactly match the manifest");
  for (const file of manifest.files) {
    const path = join(extractionDirectory, file.name);
    assert(existsSync(path) && lstatSync(path).isFile(), `Archive file missing or not regular: ${file.name}`);
    assert.equal(statSync(path).size, file.bytes, `${file.name}: byte length changed`);
    assert.equal(hashFile(path), file.sha256, `${file.name}: digest changed`);
  }
  run("pg_restore", ["--list", join(extractionDirectory, "schema.dump")]);

  const exists = run("psql", ["postgresql://root@localhost/postgres?host=/var/run/postgresql", "-X", "-At", "-c",
    `SELECT 1 FROM pg_database WHERE datname='${restoreDatabase}'`]).stdout.trim();
  assert.equal(exists, "", `Restore database already exists: ${restoreDatabase}`);
  const databaseCreator = createRestoreDatabase();
  databaseCreated = true;
  run("pg_restore", ["--section=pre-data", "--no-owner", "--no-privileges", "-d", restoreConnection,
    join(extractionDirectory, "schema.dump")]);
  for (const table of manifest.restoreOrder) {
    const file = manifest.files.find(item => item.table === table);
    assert(file, `Restore file missing for ${table}`);
    const copy = `\\copy public.${table} FROM '${join(extractionDirectory, file.name).replaceAll("'", "''")}' WITH (FORMAT binary)\n`;
    const result = run("psql", [restoreConnection, "-X", "-v", "ON_ERROR_STOP=1"], { input: copy });
    const match = result.stdout.match(/COPY\s+(\d+)/);
    assert(match, `${table}: restored row count missing`);
    assert.equal(Number(match[1]), file.rows, `${table}: restored row count differs`);
  }
  run("pg_restore", ["--section=post-data", "--no-owner", "--no-privileges", "-d", restoreConnection,
    join(extractionDirectory, "schema.dump")]);

  for (const file of manifest.files.filter(item => item.table)) {
    const rows = Number(run("psql", [restoreConnection, "-X", "-At", "-c", `SELECT count(*) FROM public.${file.table}`]).stdout.trim());
    assert.equal(rows, file.rows, `${file.table}: verified row count differs`);
  }
  const contract = JSON.parse(run("psql", [restoreConnection, "-X", "-At", "-c", `SELECT json_build_object(
    'checkpointRuns',(SELECT count(*) FROM v3_strategy_checkpoint_runs),
    'poolCheckpoints',(SELECT count(*) FROM v3_strategy_pool_checkpoints),
    'events',(SELECT count(*) FROM v3_pool_events),
    'canonicalRuns',(SELECT count(*) FROM risk_snapshot_canonicality WHERE canonical),
    'cursorCoveredThrough',(SELECT covered_through_block::text FROM indexer_cursors WHERE stream_key='robinhood-v3-rwa-usdg-v1'),
    'replayCompleteThrough',(SELECT complete_through_block::text FROM v3_replay_cursors WHERE stream_key='robinhood-v3-rwa-usdg-v1'))`]).stdout.trim());
  console.log(JSON.stringify({ archivePath, archiveBytes: statSync(archivePath).size, archiveSha256: hashFile(archivePath),
    contentId, databaseCreator, restoredDatabase: restoreDatabase, restored: true, contract }));
} finally {
  if (databaseCreated) {
    try { dropRestoreDatabase(); } catch (error) {
      console.error(String(error));
    }
  }
  rmSync(extractionDirectory, { recursive: true, force: true });
}
