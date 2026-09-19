import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { verifyRelease } from "../release-files.mjs";

const args = process.argv.slice(2);
const take = flag => {
  const values = [];
  for (let index = 0; index < args.length; index++) if (args[index] === flag) {
    assert(args[index + 1], `${flag} requires a value`);
    values.push(args[++index]);
  }
  return values;
};
const single = flag => {
  const values = take(flag);
  assert(values.length === 1, `${flag} must appear exactly once`);
  return values[0];
};

const releaseRoot = resolve(single("--release-root"));
const output = resolve(single("--output"));
const statePaths = take("--state").map(value => resolve(value));
const environmentPaths = take("--env").map(value => resolve(value));
assert(statePaths.length > 0, "At least one --state is required");
assert(environmentPaths.length > 0, "At least one --env is required");
const buildPattern = /[a-f0-9]{64}/g;
const exactBuild = /^[a-f0-9]{64}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
const references = [];
const stateFiles = [];

function collectIdentities(value, source, pointer = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectIdentities(item, source, `${pointer}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (exactBuild.test(value.buildId ?? "")) {
    references.push({
      buildId: value.buildId,
      kind: pointer.includes("/runtimeHistory/") ? "saved_state_migration_history" : "saved_state_runtime",
      source,
      pointer: pointer || "/",
      configHash: typeof value.configHash === "string" ? value.configHash : null,
      nodeVersion: typeof value.nodeVersion === "string" ? value.nodeVersion : null,
    });
  }
  for (const [key, item] of Object.entries(value)) collectIdentities(item, source, `${pointer}/${key}`);
}

for (const path of statePaths) {
  const raw = readFileSync(path, "utf8");
  const state = JSON.parse(raw);
  const embeddedConfigBytes = state.config === undefined ? null : `${JSON.stringify(state.config, null, 2)}\n`;
  const embeddedConfigHash = embeddedConfigBytes === null ? null : hash(embeddedConfigBytes);
  stateFiles.push({
    path,
    sha256: hash(raw),
    bytes: Buffer.byteLength(raw),
    embeddedStrategyConfigHash: embeddedConfigHash,
    recordedStrategyConfigHash: typeof state.configHash === "string" ? state.configHash : null,
    embeddedStrategyConfigVerified: embeddedConfigHash !== null && embeddedConfigHash === state.configHash,
  });
  collectIdentities(state, path);
}

const environments = environmentPaths.map(path => {
  const env = parseEnv(readFileSync(path, "utf8"));
  const normalized = JSON.stringify(Object.fromEntries(Object.entries(env).sort(([left], [right]) => left.localeCompare(right, "en"))));
  return { path, configHash: hash(normalized), exactBytesRetained: true, secretsExported: false };
});

let systemdAvailable = true;
try {
  const shown = execFileSync("systemctl", ["show", "conc-liq-*", "--property=Id", "--property=FragmentPath", "--property=ExecStart", "--no-pager"], { encoding: "utf8" });
  for (const block of shown.split(/\n\n+/)) {
    const unit = block.match(/^Id=(.+)$/m)?.[1];
    const fragment = block.match(/^FragmentPath=(.*)$/m)?.[1] || null;
    for (const buildId of block.match(buildPattern) ?? []) references.push({ buildId, kind: "installed_unit", source: unit ?? "unknown", fragment });
  }
} catch {
  systemdAvailable = false;
}

function walkScripts(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walkScripts(path);
    else if (/\.(?:mjs|js|ts|py)$/.test(name)) {
      const content = readFileSync(path, "utf8");
      for (const buildId of content.match(buildPattern) ?? []) {
        if (content.includes(`${releaseRoot}/${buildId}`)) references.push({ buildId, kind: "research_runner", source: relative(process.cwd(), path) });
      }
    }
  }
}
walkScripts(resolve("scripts"));

const byBuild = new Map();
for (const reference of references) {
  const list = byBuild.get(reference.buildId) ?? [];
  if (!list.some(item => JSON.stringify(item) === JSON.stringify(reference))) list.push(reference);
  byBuild.set(reference.buildId, list);
}

const builds = [];
for (const [buildId, refs] of [...byBuild.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
  const path = join(releaseRoot, buildId);
  let verified = false;
  let verificationError = null;
  let manifest = null;
  try {
    manifest = verifyRelease(path);
    verified = manifest.buildId === buildId;
  } catch (error) {
    verificationError = error instanceof Error ? error.message : String(error);
  }
  const configHashes = [...new Set(refs.map(item => item.configHash).filter(Boolean))];
  builds.push({
    buildId,
    path,
    exists: existsSync(path),
    verified,
    verificationError,
    sourceCommit: manifest?.sourceCommit ?? null,
    nodeVersion: manifest?.nodeVersion ?? null,
    references: refs,
    environmentConfig: configHashes.map(configHash => ({
      configHash,
      exactBytesPath: environments.find(item => item.configHash === configHash)?.path ?? null,
      retrievable: environments.some(item => item.configHash === configHash),
    })),
    recoveryRequired: refs.some(item => item.kind.startsWith("saved_state")),
    rollbackCompatibility: "not_assessed",
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  releaseRoot,
  preCleanupCommit: execFileSync("git", ["rev-parse", "pre-cleanup-2026-09-19^{}"], { encoding: "utf8" }).trim(),
  systemdAvailable,
  stateFiles,
  environments,
  builds,
  policy: {
    deletionAuthorized: false,
    note: "A verified historical release may be required for recovery or audit without being a rollback release compatible with the current database and state.",
  },
};

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, states: stateFiles.length, builds: builds.length, verifiedBuilds: builds.filter(item => item.verified).length }));
