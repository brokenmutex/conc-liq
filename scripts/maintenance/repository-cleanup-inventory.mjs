import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && args[1], "Usage: repository-cleanup-inventory.mjs --output FILE");
const output = args[1];
const prefixes = ["notes/", "scripts/", "config/", "ops/", "assets/", "docs/", "research/"];
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "buffer" })
  .toString("utf8").split("\0").filter(path => path && existsSync(path)).sort();
const candidates = listed.filter(path => prefixes.some(prefix => path.startsWith(prefix)) && path !== output);
const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean));
const text = new Map();
for (const path of listed) {
  const bytes = readFileSync(path);
  if (!bytes.includes(0)) text.set(path, bytes.toString("utf8"));
}

function proposedDisposition(path) {
  if (path.startsWith("assets/") || path.startsWith("docs/") || path.startsWith("research/manifests/")) return "retain";
  if (path.startsWith("notes/")) {
    if ([".mjs", ".js", ".py", ".sh", ".sql"].includes(extname(path))) return "move_or_retire";
    if (extname(path) === ".md") return "promote_or_archive";
    return "archive_or_purge_after_gate";
  }
  if (path.startsWith("config/")) return "verify_current_or_archive_exact_bytes";
  if (path.startsWith("ops/")) return "verify_installed_or_retire";
  if (path.startsWith("scripts/")) return "register_supported_workflow_or_retire";
  return "unclassified";
}

const files = candidates.map(path => {
  const bytes = readFileSync(path);
  const referencedBy = [...text.entries()].filter(([other, source]) => other !== path && source.includes(path)).map(([other]) => other);
  return {
    path,
    tracked: tracked.has(path),
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    literalPathReferenceCount: referencedBy.length,
    referencedBy,
    proposedDisposition: proposedDisposition(path),
  };
});

const ignoredDirectoryBytes = {};
for (const directory of ["data", ".tools", "node_modules", "dist"]) {
  if (!existsSync(directory)) {
    ignoredDirectoryBytes[directory] = null;
    continue;
  }
  try {
    const row = execFileSync("du", ["-sb", directory], { encoding: "utf8" }).trim();
    ignoredDirectoryBytes[directory] = Number(row.split(/\s+/)[0]);
  } catch {
    ignoredDirectoryBytes[directory] = null;
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  headCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeClean: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() === "",
  preCleanupTag: execFileSync("git", ["rev-parse", "pre-cleanup-2026-09-19^{}"], { encoding: "utf8" }).trim(),
  ignoredDirectoryBytes,
  totals: {
    files: files.length,
    tracked: files.filter(file => file.tracked).length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    notesBytes: files.filter(file => file.path.startsWith("notes/")).reduce((sum, file) => sum + file.bytes, 0),
  },
  files,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, ...report.totals }));
