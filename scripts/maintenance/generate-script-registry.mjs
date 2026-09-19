import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && args[1], "Usage: generate-script-registry.mjs --output FILE");
const output = args[1];
const directory = "scripts";
const operational = new Set([
  "activate-paper-release.mjs",
  "build-release.mjs",
  "check-dashboard-position-accounting.mjs",
  "check-dashboard-positions.mjs",
  "check-dashboard-preview.mjs",
  "check-dashboard-release.mjs",
  "live-pilot.mjs",
  "release-files.mjs",
  "render-experiment-unit.mjs",
  "render-release-units.mjs",
  "run-release.mjs"
]);
const recovery = new Set([
  "paper-boundary-recovery.mjs",
  "paper-session-update.mjs"
]);
const reviewForRetirement = new Set([
  "audit-lp-fees-and-swaps.mjs",
  "audit-lp-gas-estimates.mjs",
  "lp-experiment-reconcile.mjs",
  "lp-gas-regime-sensitivity.mjs",
  "lp-weekend-reference.mjs",
  "observe-paper-holding.mjs",
  "paper-recenter-fork-check.mjs",
  "render-agile-lp.py",
  "verify-inventory-study.py"
]);
const files = readdirSync(directory).filter(name => /\.(?:mjs|py)$/.test(name) && statSync(join(directory, name)).isFile()).sort();
const entries = files.map(name => {
  const path = join(directory, name);
  const bytes = readFileSync(path);
  const category = operational.has(name) ? "operations" : recovery.has(name) ? "recovery" :
    /^(?:audit|certify|check|diagnose|verify)-/.test(name) ? "validation" : "research";
  return {
    path,
    category,
    lifecycle: reviewForRetirement.has(name) ? "review_for_retirement" :
      operational.has(name) || recovery.has(name) ? "supported_operations" : "frozen_reproduction",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length
  };
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  layoutBaselineCommit: "a09bda7fffe2d20fade20b980ac4a01e7d6102d4",
  layoutPolicy: "Existing top-level scripts remain at their recorded paths until their studies pass post-layout reproduction. New recurring tooling belongs in an owned subdirectory.",
  entries
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, scripts: entries.length, retirementReview: entries.filter(entry => entry.lifecycle === "review_for_retirement").length }));
