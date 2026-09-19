import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const registry = JSON.parse(readFileSync("scripts/workflows.json", "utf8"));
assert.equal(registry.schemaVersion, 1, "Unsupported script registry schema");
assert.equal(typeof registry.layoutPolicy, "string", "Script layout policy missing");
const actual = readdirSync("scripts").filter(name => /\.(?:mjs|py)$/.test(name) && statSync(join("scripts", name)).isFile())
  .map(name => `scripts/${name}`).sort();
const recorded = registry.entries.map(entry => entry.path).sort();
assert.deepEqual(recorded, actual, "Top-level script set changed; classify it in scripts/workflows.json");
const categories = new Set(["operations", "recovery", "research", "validation"]);
const lifecycles = new Set(["supported_operations", "frozen_reproduction", "review_for_retirement"]);
for (const entry of registry.entries) {
  assert(categories.has(entry.category), `${entry.path}: invalid category`);
  assert(lifecycles.has(entry.lifecycle), `${entry.path}: invalid lifecycle`);
  const bytes = readFileSync(entry.path);
  assert.equal(bytes.length, entry.bytes, `${entry.path}: byte length changed; update provenance deliberately`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256,
    `${entry.path}: content changed; update provenance deliberately`);
}
console.log(JSON.stringify({ scripts: recorded.length, registryVerified: true }));
