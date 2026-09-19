import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function canonicalize(value, ignoredTopLevel, ignoredKeys, ignoredUnder, path = []) {
  if (Array.isArray(value)) return value.map((item, index) =>
    canonicalize(item, ignoredTopLevel, ignoredKeys, ignoredUnder, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  const parent = path.at(-1);
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !ignoredKeys.has(key) && (path.length !== 0 || !ignoredTopLevel.has(key)) &&
      !ignoredUnder.get(parent)?.has(key))
    .map(key => [key, canonicalize(value[key], ignoredTopLevel, ignoredKeys, ignoredUnder, [...path, key])]));
}

export function normalizedResearchOutput(path, ignoredTopLevel = [], ignoredKeys = [], ignoredUnderEntries = []) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const ignoredUnder = new Map();
  for (const [parent, key] of ignoredUnderEntries) {
    const keys = ignoredUnder.get(parent) ?? new Set();
    keys.add(key);
    ignoredUnder.set(parent, keys);
  }
  return JSON.stringify(canonicalize(parsed, new Set(ignoredTopLevel), new Set(ignoredKeys), ignoredUnder));
}

export function researchOutputDigest(path, ignoredTopLevel = [], ignoredKeys = [], ignoredUnderEntries = []) {
  return createHash("sha256").update(normalizedResearchOutput(path, ignoredTopLevel, ignoredKeys, ignoredUnderEntries))
    .digest("hex");
}

function option(args, name) {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1], `Missing ${name}`);
  return args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const expected = option(args, "--expected");
  const actual = option(args, "--actual");
  const ignored = args.flatMap((arg, index) => arg === "--ignore-top-level" ? [args[index + 1]] : [])
    .filter(Boolean);
  const ignoredKeys = args.flatMap((arg, index) => arg === "--ignore-key" ? [args[index + 1]] : [])
    .filter(Boolean);
  const ignoredUnder = args.flatMap((arg, index) => arg === "--ignore-under" ? [args[index + 1]] : [])
    .filter(Boolean).map(value => {
      const parts = value.split(":");
      assert(parts.length === 2 && parts.every(Boolean), `Invalid --ignore-under ${value}; expected PARENT:KEY`);
      return parts;
    });
  const expectedDigest = researchOutputDigest(expected, ignored, ignoredKeys, ignoredUnder);
  const actualDigest = researchOutputDigest(actual, ignored, ignoredKeys, ignoredUnder);
  assert.equal(actualDigest, expectedDigest, `${actual}: normalized research output differs from ${expected}`);
  console.log(JSON.stringify({ expected, actual, ignoredTopLevel: ignored, ignoredKeys, ignoredUnder,
    normalizedSha256: expectedDigest, matches: true }));
}
