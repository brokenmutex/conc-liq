import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const directory = join(root, "research/manifests");
const hex = /^[a-f0-9]{64}$/;
const manifests = readdirSync(directory).filter(name => name.endsWith(".json")).sort();
assert(manifests.length > 0, "At least one research manifest is required");

for (const name of manifests) {
  const path = join(directory, name);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.schemaVersion, 1, `${name}: unsupported schema`);
  assert.match(manifest.id, /^[a-z0-9][a-z0-9-]+$/, `${name}: invalid id`);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/, `${name}: invalid source commit`);
  assert.equal(manifest.executionEligible, false, `${name}: research evidence cannot authorize execution`);
  assert(["original_checkout", "migrated_runner"].includes(manifest.reproduction?.mode), `${name}: reproduction mode missing`);
  assert.equal(typeof manifest.reproduction?.postLayoutVerified, "boolean", `${name}: final-layout verification state missing`);
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, `${name}: files missing`);
  for (const file of manifest.files) {
    assert.equal(typeof file.path, "string", `${name}: file path missing`);
    assert.match(file.sha256, hex, `${name}: ${file.path} has invalid digest`);
    assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `${name}: ${file.path} has invalid byte length`);
    assert(["config", "conclusion", "code", "manifest", "compact_evidence"].includes(file.role), `${name}: ${file.path} has invalid role`);
    const absolute = join(root, file.path);
    assert(existsSync(absolute) && statSync(absolute).isFile(), `${name}: ${file.path} is not retrievable`);
    const bytes = readFileSync(absolute);
    assert.equal(bytes.length, file.bytes, `${name}: ${file.path} byte length changed`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${name}: ${file.path} digest changed`);
  }
}

console.log(JSON.stringify({ manifests: manifests.map(name => relative(root, join(directory, name))), verified: true }));
