import test from "node:test";
import assert from "node:assert/strict";
import { hasCoverageColumn, sourceSqlForFee } from "../src/paper/store.js";

test("sourceSqlForFee reads the monotone coverage cursor by default", () => {
  const sql = sourceSqlForFee(500);
  assert.match(sql, /COALESCE\(i\.covered_through_block,i\.last_scanned_block\)>=c\.block_number/);
});

test("sourceSqlForFee keeps the pre-migration predicate when the column is absent", () => {
  const sql = sourceSqlForFee(3000, { coverageColumn: false });
  assert.doesNotMatch(sql, /covered_through_block/);
  assert.match(sql, /i\.last_scanned_block>=c\.block_number/);
  assert.match(sql, /t\.fee=3000/);
  assert.equal(sourceSqlForFee(500, { coverageColumn: true }), sourceSqlForFee(500));
});

test("hasCoverageColumn asks information_schema on the current search path", async () => {
  const seen: string[] = [];
  const present = { async query(text: string) { seen.push(text); return { rowCount: 1 }; } };
  const absent = { async query() { return { rowCount: 0 }; } };
  const unknown = { async query() { return { rowCount: null }; } };
  assert.equal(await hasCoverageColumn(present), true);
  assert.equal(await hasCoverageColumn(absent), false);
  assert.equal(await hasCoverageColumn(unknown), false);
  assert.match(seen[0]!, /information_schema\.columns/);
  assert.match(seen[0]!, /current_schemas\(false\)/);
  assert.match(seen[0]!, /covered_through_block/);
});
