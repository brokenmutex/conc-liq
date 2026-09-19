import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const scannedExtensions = new Set([".ts", ".js", ".mjs", ".cjs"]);
const files = [];

function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) walk(join(path, name));
    return;
  }
  if (scannedExtensions.has(extname(path))) files.push(path);
}

for (const path of ["src", "test"]) walk(join(root, path));
for (const path of ["scripts/build-release.mjs", "scripts/release-files.mjs", "scripts/run-release.mjs"])
  files.push(join(root, path));

const violations = [];
const forbiddenPathLiteral = /["'`](?:\.\.\/)*(?:notes|docs)\//g;
for (const path of files) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(forbiddenPathLiteral)) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(root, path)}:${line}:${match[0].slice(1)}`);
  }
}

assert.deepEqual(violations, [],
  `Production, tests, and release tooling must not read repository documentation:\n${violations.join("\n")}`);
console.log(JSON.stringify({ checkedFiles: files.length, forbiddenDocumentationPathLiterals: 0 }));
