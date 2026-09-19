import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { researchOutputDigest } from "./compare-research-output.mjs";

const path = "research/reproduction/strategy-redesign-2026-09-18.json";
const report = JSON.parse(readFileSync(path, "utf8"));
const hex = /^[a-f0-9]{64}$/;
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
const canonical = value => JSON.stringify(canonicalize(value));

assert.equal(report.schemaVersion, 1, "Unsupported reproduction schema");
assert.equal(report.studyId, "strategy-redesign-2026-09-18", "Unexpected reproduction study");
assert.match(report.originalCheckoutCommit, /^[a-f0-9]{40}$/, "Invalid original checkout commit");
assert.match(report.requiredRelease?.buildId, hex, "Invalid required release");
assert.equal(typeof report.postLayoutVerified, "boolean", "postLayoutVerified must be explicit");
assert(Array.isArray(report.blockers), "Reproduction blockers must be an array");
if (report.postLayoutVerified) assert.equal(report.blockers.length, 0,
  "A verified final layout cannot retain unresolved blockers");
else assert(report.blockers.length > 0, "Unresolved reproduction blockers must be explicit");

const ids = new Set();
for (const unit of report.deterministicUnits) {
  assert.match(unit.id, /^[a-z0-9][a-z0-9-]+$/, "Invalid deterministic unit id");
  assert(!ids.has(unit.id), `Duplicate reproduction unit ${unit.id}`);
  ids.add(unit.id);
  assert(["required_release", "original_checkout"].includes(unit.runner), `${unit.id}: invalid runner`);
  assert.equal(unit.status, "verified", `${unit.id}: deterministic replay is not verified`);
  assert(Array.isArray(unit.command?.arguments) && unit.command.arguments.includes("{output}"),
    `${unit.id}: command must declare its output placeholder`);
  assert.equal(typeof unit.command?.executable, "string", `${unit.id}: executable missing`);
  assert(existsSync(unit.expectedOutput) && statSync(unit.expectedOutput).isFile(),
    `${unit.id}: expected output is not retrievable`);
  const normalization = unit.normalization;
  assert(Array.isArray(normalization?.ignoredTopLevel), `${unit.id}: ignoredTopLevel missing`);
  assert(Array.isArray(normalization?.ignoredKeys), `${unit.id}: ignoredKeys missing`);
  assert(Array.isArray(normalization?.ignoredUnder), `${unit.id}: ignoredUnder missing`);
  assert.equal(typeof normalization?.rationale, "string", `${unit.id}: normalization rationale missing`);
  assert.match(unit.normalizedSha256, hex, `${unit.id}: invalid normalized digest`);
  assert.equal(researchOutputDigest(unit.expectedOutput, normalization.ignoredTopLevel,
    normalization.ignoredKeys, normalization.ignoredUnder), unit.normalizedSha256,
  `${unit.id}: retained output no longer matches its normalized digest`);
}

for (const input of report.inputFiles) {
  assert(["tracked", "ignored_unique_input"].includes(input.class), `${input.path}: invalid input class`);
  assert.match(input.sha256, hex, `${input.path}: invalid digest`);
  assert(Number.isSafeInteger(input.bytes) && input.bytes >= 0, `${input.path}: invalid byte length`);
  assert(existsSync(input.path) && statSync(input.path).isFile(), `${input.path}: input is not retrievable`);
  const bytes = readFileSync(input.path);
  assert.equal(bytes.length, input.bytes, `${input.path}: byte length changed`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), input.sha256, `${input.path}: digest changed`);
}

const databaseArchive = report.databaseArchive;
assert.equal(databaseArchive.status, "verified_local_staging", "Database archive status is not recognized");
assert.equal(databaseArchive.restoreVerified, true, "Database archive restore is not verified");
assert.equal(databaseArchive.durable, false, "Local staging must not be represented as durable storage");
for (const archivePath of [databaseArchive.manifest, databaseArchive.receipt]) {
  assert(existsSync(archivePath) && statSync(archivePath).isFile(), `Database archive evidence missing: ${archivePath}`);
}
const archiveManifest = JSON.parse(readFileSync(databaseArchive.manifest, "utf8"));
const { contentId: manifestContentId, ...archiveManifestBase } = archiveManifest;
assert.match(manifestContentId, hex, "Database archive content ID is invalid");
assert.equal(createHash("sha256").update(canonical(archiveManifestBase)).digest("hex"), manifestContentId,
  "Database archive manifest content ID changed");
assert.equal(databaseArchive.contentId, manifestContentId, "Reproduction archive content ID differs from manifest");
const archiveFileNames = new Set();
for (const file of archiveManifest.files) {
  assert.match(file.name, /^(?:schema\.dump|[a-z0-9_]+\.bin)$/, `Unsafe archive member ${file.name}`);
  assert(!archiveFileNames.has(file.name), `Duplicate archive member ${file.name}`);
  archiveFileNames.add(file.name);
  assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `${file.name}: invalid archive byte length`);
  assert.match(file.sha256, hex, `${file.name}: invalid archive digest`);
  if (file.table) assert(Number.isSafeInteger(file.rows) && file.rows >= 0, `${file.name}: invalid archive row count`);
}
const archiveReceipt = JSON.parse(readFileSync(databaseArchive.receipt, "utf8"));
assert.equal(archiveReceipt.archive.contentId, manifestContentId, "Archive receipt content ID differs");
assert.equal(archiveReceipt.archive.trackedManifest, databaseArchive.manifest, "Archive receipt manifest path differs");
assert.equal(archiveReceipt.archive.durable, false, "Archive receipt must identify same-host staging as non-durable");
assert.equal(archiveReceipt.archive.independentlyStored, false, "Archive receipt cannot claim independent storage");
assert.equal(archiveReceipt.restoreVerification.restored, true, "Archive receipt lacks a successful restore");
assert.equal(archiveReceipt.restoreVerification.droppedAfterVerification, true,
  "Archive receipt does not confirm temporary database cleanup");
assert.equal(archiveReceipt.pruningAuthorized, false, "Local archive receipt cannot authorize pruning");
assert.match(archiveReceipt.archive.sha256, hex, "Archive object digest is invalid");
assert.match(archiveReceipt.export.scriptSha256, hex, "Archive export script digest is invalid");
assert.match(archiveReceipt.restoreVerification.scriptSha256, hex, "Archive verifier script digest is invalid");
if (existsSync(archiveReceipt.archive.stagingPath)) {
  assert.equal(statSync(archiveReceipt.archive.stagingPath).size, archiveReceipt.archive.bytes,
    "Local staging archive byte length changed");
}

const nonDeterministicStatuses = new Set([
  "retained_non_replayable", "verified_test_assertion", "blocked_external_input", "observed_not_reproduction"
]);
for (const unit of report.nonDeterministicUnits) {
  assert(!ids.has(unit.id), `Duplicate reproduction unit ${unit.id}`);
  ids.add(unit.id);
  assert(nonDeterministicStatuses.has(unit.status), `${unit.id}: invalid non-deterministic status`);
  for (const evidence of unit.evidence ?? []) {
    assert(existsSync(evidence) && statSync(evidence).isFile(), `${unit.id}: evidence ${evidence} is not retrievable`);
  }
  if (unit.status !== "verified_test_assertion") {
    assert.equal(typeof unit.limitation, "string", `${unit.id}: limitation missing`);
  }
}

console.log(JSON.stringify({ path, deterministicVerified: report.deterministicUnits.length,
  nonDeterministicUnits: report.nonDeterministicUnits.length, postLayoutVerified: report.postLayoutVerified }));
