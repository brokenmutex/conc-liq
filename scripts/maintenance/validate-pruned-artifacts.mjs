import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestRoot = join(root, "research/manifests");
const hex = /^[a-f0-9]{64}$/;
const manifests = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/^pruned-[a-z0-9-]+\.json$/.test(entry.name)) manifests.push(path);
  }
}

walk(manifestRoot);
assert(manifests.length > 0, "At least one pruned-artifact manifest is required");

for (const manifestPath of manifests.sort()) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const label = relative(root, manifestPath);
  assert.equal(manifest.schemaVersion, 1, `${label}: unsupported schema`);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/, `${label}: invalid source commit`);
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, `${label}: artifacts missing`);
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    assert.equal(typeof artifact.path, "string", `${label}: artifact path missing`);
    assert(!artifact.path.startsWith("/") && !artifact.path.split("/").includes(".."),
      `${label}: unsafe artifact path ${artifact.path}`);
    assert(!paths.has(artifact.path), `${label}: duplicate artifact ${artifact.path}`);
    paths.add(artifact.path);
    assert(!existsSync(join(root, artifact.path)), `${label}: pruned artifact still exists: ${artifact.path}`);
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, `${artifact.path}: invalid byte length`);
    assert.match(artifact.sha256, hex, `${artifact.path}: invalid digest`);
    assert.equal(typeof artifact.class, "string", `${artifact.path}: class missing`);
    assert(artifact.replacement || artifact.retainedSibling, `${artifact.path}: replacement evidence missing`);

    const historical = spawnSync("git", ["show", `${manifest.sourceCommit}:${artifact.path}`],
      { encoding: null, maxBuffer: 2 ** 26 });
    assert.equal(historical.status, 0, `${artifact.path}: historical blob is not retrievable from Git`);
    assert.equal(historical.stdout.length, artifact.bytes, `${artifact.path}: historical byte length changed`);
    assert.equal(createHash("sha256").update(historical.stdout).digest("hex"), artifact.sha256,
      `${artifact.path}: historical digest changed`);

    if (artifact.retainedSibling) {
      const sibling = artifact.retainedSibling;
      assert.equal(typeof sibling.path, "string", `${artifact.path}: retained sibling path missing`);
      assert(!sibling.path.startsWith("/") && !sibling.path.split("/").includes(".."),
        `${artifact.path}: unsafe retained sibling path ${sibling.path}`);
      assert(Number.isSafeInteger(sibling.bytes) && sibling.bytes >= 0,
        `${artifact.path}: retained sibling byte length invalid`);
      assert.match(sibling.sha256, hex, `${artifact.path}: retained sibling digest invalid`);
      const siblingPath = join(root, sibling.path);
      assert(existsSync(siblingPath) && statSync(siblingPath).isFile(),
        `${artifact.path}: retained sibling is not retrievable`);
      const bytes = readFileSync(siblingPath);
      assert.equal(bytes.length, sibling.bytes, `${sibling.path}: byte length changed`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sibling.sha256,
        `${sibling.path}: digest changed`);
    }
  }
}

console.log(JSON.stringify({ manifests: manifests.map(path => relative(root, path)), verified: true }));
