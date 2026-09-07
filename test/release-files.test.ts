import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
// The release tooling is intentionally plain Node, independent of tsx at runtime.
// @ts-expect-error Build tooling is a JavaScript module.
import { inventory, releaseId, verifyRelease } from "../scripts/release-files.mjs";

it("release verification detects changed, added and external linked code", () => {
 const root=mkdtempSync(join(tmpdir(),"conc-liq-release-"));
 try {
  mkdirSync(join(root,"dist"));writeFileSync(join(root,"dist/app.js"),"export const value=1;\n");
  const manifest={format:1,sourceCommit:"fixture",nodeVersion:process.version,files:inventory(root),buildId:""};
  manifest.buildId=releaseId(manifest);writeFileSync(join(root,"release.json"),JSON.stringify(manifest));
  assert.equal(verifyRelease(root).buildId,manifest.buildId);
  writeFileSync(join(root,"dist/app.js"),"export const value=2;\n");
  assert.throws(()=>verifyRelease(root),/contents differ/);
  writeFileSync(join(root,"dist/app.js"),"export const value=1;\n");
  writeFileSync(join(root,"injected.js"),"unexpected");assert.throws(()=>verifyRelease(root),/contents differ/);rmSync(join(root,"injected.js"));
  symlinkSync(process.execPath,join(root,"external-node"));assert.throws(()=>verifyRelease(root),/symlink escapes/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
