import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { researchOutputDigest } from "./compare-research-output.mjs";
import { verifyRelease } from "../release-files.mjs";

const workspace = process.cwd();
const reportPath = join(workspace, "research/reproduction/strategy-redesign-2026-09-18.json");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1], `Missing ${name}`);
  return args[index + 1];
};
const databaseUrl = option("--database-url");
const outputDirectory = resolve(option("--output-dir"));
const archiveContentId = option("--archive-content-id");
const resume = args.includes("--resume");
const concurrencyIndex = args.indexOf("--concurrency");
const concurrency = concurrencyIndex < 0 ? 1 : Number(args[concurrencyIndex + 1]);
assert(outputDirectory.startsWith("/"), "Replay output directory must be absolute");
assert.match(archiveContentId, /^[a-f0-9]{64}$/, "Archive content ID is invalid");
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 3,
  "Replay concurrency must be 1, 2, or 3");
assert(resume || !existsSync(outputDirectory), `Replay output directory already exists: ${outputDirectory}`);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result;
};
const replaceOne = (source, current, original, path) => {
  assert.equal(source.split(current).length, 2, `${path}: expected exactly one database-adapter fragment`);
  return source.replace(current, original);
};
const restoreOriginalRunner = (path, source) => {
  if (path === "scripts/live-fee-calibration.mjs") {
    source = replaceOne(source,
      "// Usage: [RESEARCH_DATABASE_URL=...] <release>/bin/node scripts/research/live-fee-calibration.mjs OUT.json",
      "// Usage: <release>/bin/node scripts/live-fee-calibration.mjs OUT.json", path);
    source = replaceOne(source, "const {researchDatabaseUrl}=await import('../sim-source.mjs');\n", "", path);
  } else if (path === "scripts/pool-universe-screen.mjs") {
    source = replaceOne(source,
      "// Read-only. Usage: [RESEARCH_DATABASE_URL=...] <release>/bin/node scripts/research/pool-universe-screen.mjs OUT.json",
      "// Read-only. Usage: <release>/bin/node scripts/pool-universe-screen.mjs OUT.json", path);
    source = replaceOne(source, "const {researchDatabaseUrl}=await import('../sim-source.mjs');\n", "", path);
  } else if (path === "scripts/adaptive-exit-rule-sim.mjs") {
    source = replaceOne(source,
      "// Usage: SIM_START=... SIM_END=... [RESEARCH_DATABASE_URL=...] <release>/bin/node scripts/research/adaptive-exit-rule-sim.mjs OUT.json [--arms FILE]",
      "// Usage: SIM_START=... SIM_END=... <release>/bin/node scripts/adaptive-exit-rule-sim.mjs OUT.json [--arms FILE]", path);
    source = replaceOne(source, "const {readSourceRows,researchDatabaseUrl}=await import('../sim-source.mjs');",
      "const {readSourceRows}=await import('./sim-source.mjs');", path);
  } else if (path === "scripts/adaptive-residual-range-sim.mjs" || path === "scripts/adaptive-forecast-sweep.mjs") {
    source = replaceOne(source,
      "// Set RESEARCH_DATABASE_URL only when replaying against an isolated archive restore.\n", "", path);
    source = replaceOne(source, "const {readSourceRows,researchDatabaseUrl}=await import('../sim-source.mjs');",
      "const {readSourceRows}=await import('./sim-source.mjs');", path);
    if (path === "scripts/adaptive-residual-range-sim.mjs") {
      source = replaceOne(source, "//          scripts/research/adaptive-residual-range-sim.mjs OUT.json [--arms FILE]",
        "//          scripts/adaptive-residual-range-sim.mjs OUT.json [--arms FILE]", path);
    } else {
      source = replaceOne(source,
        "//   SIM_START=... SIM_END=... <release>/bin/node scripts/research/adaptive-forecast-sweep.mjs OUT.json [--intersect] [--marks] [--arms FILE]",
        "//   SIM_START=... SIM_END=... <release>/bin/node scripts/adaptive-forecast-sweep.mjs OUT.json [--intersect] [--marks] [--arms FILE]", path);
    }
  } else {
    assert.fail(`Unsupported database-adapted runner: ${path}`);
  }
  return replaceOne(source, "connectionString:researchDatabaseUrl()",
    "connectionString:'postgresql://root@localhost/conc_liq?host=/var/run/postgresql'", path);
};
const restoreOriginalSourceHelper = source => replaceOne(source,
  "const DEFAULT_RESEARCH_DATABASE_URL='postgresql://root@localhost/conc_liq?host=/var/run/postgresql';\n\n" +
  "/** Select an explicit database for offline research replay without reusing the\n" +
  " * runtime DATABASE_URL. The dedicated name prevents a service environment\n" +
  " * from silently retargeting historical research. */\n" +
  "export function researchDatabaseUrl(environment=process.env){\n" +
  "  const value=environment.RESEARCH_DATABASE_URL??DEFAULT_RESEARCH_DATABASE_URL;\n" +
  "  const parsed=new URL(value);\n" +
  "  assert(['postgres:','postgresql:'].includes(parsed.protocol),'RESEARCH_DATABASE_URL must be PostgreSQL');\n" +
  "  assert(parsed.pathname.length>1,'RESEARCH_DATABASE_URL must name a database');\n" +
  "  return value;\n" +
  "}\n\n", "\n", "scripts/sim-source.mjs");
const expand = (value, replacements) => Object.entries(replacements)
  .reduce((result, [token, replacement]) => result.replaceAll(token, replacement), value);
const runReplay = (command, commandArgs, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, commandArgs, { ...options, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.pipe(process.stderr);
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
  });
});

const scratch = mkdtempSync(join(tmpdir(), "conc-liq-restored-replay-"));
try {
  const originalCheckout = join(scratch, "original");
  mkdirSync(originalCheckout);
  const sourceArchive = join(scratch, "original.tar");
  run("git", ["archive", "--format=tar", `--output=${sourceArchive}`, report.originalCheckoutCommit], { cwd: workspace });
  run("tar", ["-xf", sourceArchive, "-C", originalCheckout]);
  symlinkSync(join(workspace, "node_modules"), join(originalCheckout, "node_modules"), "dir");
  run(process.execPath, [join(workspace, "node_modules/typescript/bin/tsc"), "-p", join(originalCheckout, "tsconfig.json"),
    "--outDir", join(originalCheckout, "dist")], { cwd: originalCheckout });

  const requiredRelease = join("/root/conc-liq-releases", report.requiredRelease.buildId);
  assert(existsSync(requiredRelease), `Required release is unavailable: ${requiredRelease}`);
  verifyRelease(requiredRelease);
  const release = JSON.parse(readFileSync(join(requiredRelease, "release.json"), "utf8"));
  assert.equal(release.buildId, report.requiredRelease.buildId, "Required release build ID changed");
  assert.equal(release.sourceCommit, report.requiredRelease.sourceCommit, "Required release source commit changed");
  assert.equal(release.nodeVersion, report.requiredRelease.nodeVersion, "Required release Node version changed");
  assert.equal(process.version, report.requiredRelease.nodeVersion, "Replay Node version differs from the recorded release");

  const originalRunnerPaths = [...new Set(report.deterministicUnits.map(unit => unit.command.arguments[0])
    .map(value => basename(value)).map(name => `scripts/${name}`))];
  const adapters = [];
  for (const originalPath of originalRunnerPaths) {
    const currentPath = `scripts/research/${basename(originalPath)}`;
    const current = readFileSync(join(workspace, currentPath), "utf8");
    const original = readFileSync(join(originalCheckout, originalPath), "utf8");
    if (restoreOriginalRunner(originalPath, current) !== original) {
      throw new Error(`${currentPath}: restored-database adapter changes more than its declared database and layout plumbing`);
    }
    adapters.push({ path: currentPath, originalPath, originalSha256: sha256(original), adapterSha256: sha256(current),
      equivalentExceptDatabaseOverride: true });
  }
  const helperPath = "scripts/sim-source.mjs";
  const currentHelper = readFileSync(join(workspace, helperPath), "utf8");
  const originalHelper = readFileSync(join(originalCheckout, helperPath), "utf8");
  if (restoreOriginalSourceHelper(currentHelper) !== originalHelper) {
    throw new Error("sim-source database adapter changes more than its declared helper");
  }
  adapters.push({ path: helperPath, originalSha256: sha256(originalHelper), adapterSha256: sha256(currentHelper),
    equivalentExceptDatabaseOverride: true });

  const replacements = {
    "{requiredRelease}": requiredRelease,
    "{originalCheckout}": originalCheckout,
    "{node}": process.execPath
  };
  const units = new Array(report.deterministicUnits.length);
  const executeUnit = async (unit, index) => {
    const output = join(outputDirectory, `${unit.id}.json`);
    if (resume && existsSync(output)) {
      const actualDigest = researchOutputDigest(output, unit.normalization.ignoredTopLevel,
        unit.normalization.ignoredKeys, unit.normalization.ignoredUnder);
      assert.equal(actualDigest, unit.normalizedSha256, `${unit.id}: resumable output differs`);
      const unitResult = { id: unit.id, runner: unit.runner, normalizedSha256: actualDigest,
        matches: true, reusedVerifiedOutput: true };
      units[index] = unitResult;
      console.error(JSON.stringify(unitResult));
      return;
    }
    const executable = expand(unit.command.executable, replacements);
    const commandArgs = unit.command.arguments.map(value => expand(value, { ...replacements, "{output}": output }));
    if (unit.runner === "original_checkout") {
      const originalScriptPath = `scripts/${basename(commandArgs[0])}`;
      assert(originalRunnerPaths.includes(originalScriptPath), `${unit.id}: original runner has no verified database adapter`);
      commandArgs[0] = join(workspace, "scripts/research", basename(commandArgs[0]));
    }
    const environment = Object.fromEntries(Object.entries(unit.command.environment)
      .map(([key, value]) => [key, expand(value, replacements)]));
    await runReplay(executable, commandArgs, {
      cwd: workspace,
      env: { ...process.env, ...environment, RESEARCH_DATABASE_URL: databaseUrl }
    });
    const actualDigest = researchOutputDigest(output, unit.normalization.ignoredTopLevel,
      unit.normalization.ignoredKeys, unit.normalization.ignoredUnder);
    assert.equal(actualDigest, unit.normalizedSha256, `${unit.id}: restored-input output differs`);
    const unitResult = { id: unit.id, runner: unit.runner, normalizedSha256: actualDigest, matches: true };
    units[index] = unitResult;
    console.error(JSON.stringify(unitResult));
  };
  let failure;
  const runIndexes = async indexes => {
    for (const index of indexes) {
      if (failure) return;
      try {
        await executeUnit(report.deterministicUnits[index], index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };
  const worker = async state => {
    while (!failure) {
      const index = state.next++;
      if (index >= report.deterministicUnits.length) return;
      try {
        await executeUnit(report.deterministicUnits[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  if (concurrency === 3) {
    const lanes = [
      [0, 1, 5, 10],
      [2, 4, 7, 8],
      [3, 6, 9]
    ];
    assert.deepEqual(lanes.flat().sort((a, b) => a - b),
      report.deterministicUnits.map((_, index) => index), "Three-lane replay schedule is incomplete");
    await Promise.all(lanes.map(runIndexes));
  } else {
    const state = { next: 0 };
    await Promise.all(Array.from({ length: concurrency }, () => worker(state)));
  }
  if (failure) throw failure;

  console.log(JSON.stringify({ schemaVersion: 1, studyId: report.studyId, verifiedAt: new Date().toISOString(),
    archiveContentId, databaseInput: "isolated_archive_restore", requiredRelease: report.requiredRelease,
    originalCheckoutCommit: report.originalCheckoutCommit, concurrency,
    reusedVerifiedOutputs: units.filter(unit => unit.reusedVerifiedOutput).length,
    adapters, units, allMatched: true }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
