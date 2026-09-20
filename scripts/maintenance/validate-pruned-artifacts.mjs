import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const manifestRoot = join(root, "research/manifests");
const hex = /^[a-f0-9]{64}$/;
const manifests = [];
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
};
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

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
  if (manifest.reproduction) {
    assert.equal(typeof manifest.reproduction.command, "string", `${label}: reproduction command missing`);
    assert(Array.isArray(manifest.reproduction.inputs), `${label}: reproduction inputs missing`);
    for (const input of manifest.reproduction.inputs) {
      assert.equal(typeof input.path, "string", `${label}: reproduction input path missing`);
      assert(!input.path.startsWith("/") && !input.path.split("/").includes(".."),
        `${label}: unsafe reproduction input path ${input.path}`);
      assert(Number.isSafeInteger(input.bytes) && input.bytes >= 0, `${input.path}: invalid input byte length`);
      assert.match(input.sha256, hex, `${input.path}: invalid input digest`);
      assert.equal(typeof input.class, "string", `${input.path}: input class missing`);
      const inputPath = join(root, input.path);
      assert(existsSync(inputPath) && statSync(inputPath).isFile(), `${input.path}: input is not retrievable`);
      const bytes = readFileSync(inputPath);
      assert.equal(bytes.length, input.bytes, `${input.path}: input byte length changed`);
      assert.equal(digest(bytes), input.sha256, `${input.path}: input digest changed`);
    }
    const result = manifest.reproduction.result;
    assert.equal(result?.matches, true, `${label}: replay result did not match`);
    assert(Number.isSafeInteger(result.bytes) && result.bytes >= 0, `${label}: replay byte length invalid`);
    assert.match(result.sha256, hex, `${label}: replay digest invalid`);
    assert.match(result.normalizedSha256, hex, `${label}: replay normalized digest invalid`);
  }
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
    assert.equal(digest(historical.stdout), artifact.sha256,
      `${artifact.path}: historical digest changed`);

    if (artifact.normalizedJson) {
      const normalized = artifact.normalizedJson;
      assert(Array.isArray(normalized.ignoredPaths), `${artifact.path}: ignored JSON paths missing`);
      assert.match(normalized.sha256, hex, `${artifact.path}: normalized digest invalid`);
      assert.equal(typeof normalized.rationale, "string", `${artifact.path}: normalization rationale missing`);
      const value = JSON.parse(historical.stdout.toString("utf8"));
      for (const ignoredPath of normalized.ignoredPaths) {
        assert(Array.isArray(ignoredPath) && ignoredPath.length > 0 && ignoredPath.every(Boolean),
          `${artifact.path}: invalid ignored JSON path`);
        let parent = value;
        for (const segment of ignoredPath.slice(0, -1)) {
          assert(parent && typeof parent === "object" && Object.hasOwn(parent, segment),
            `${artifact.path}: ignored JSON path is absent`);
          parent = parent[segment];
        }
        const key = ignoredPath.at(-1);
        assert(parent && typeof parent === "object" && Object.hasOwn(parent, key),
          `${artifact.path}: ignored JSON key is absent`);
        delete parent[key];
      }
      const normalizedDigest = digest(JSON.stringify(canonicalize(value)));
      assert.equal(normalizedDigest, normalized.sha256, `${artifact.path}: normalized historical digest changed`);
      if (manifest.reproduction) assert.equal(manifest.reproduction.result.normalizedSha256, normalizedDigest,
        `${artifact.path}: replay and historical normalized digests differ`);
    }

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
      assert.equal(digest(bytes), sibling.sha256,
        `${sibling.path}: digest changed`);
    }
  }
}

console.log(JSON.stringify({ manifests: manifests.map(path => relative(root, path)), verified: true }));
