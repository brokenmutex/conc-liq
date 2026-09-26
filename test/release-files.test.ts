import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
// The release tooling is intentionally plain Node, independent of tsx at runtime.
// @ts-expect-error Build tooling is a JavaScript module.
import { inventory, inventoryConcurrent, releaseId, verifyRelease, verifyReleaseConcurrent } from "../scripts/release-files.mjs";

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

it("concurrent launch verification matches the full synchronous inventory and rejects every content change", async () => {
 const root=mkdtempSync(join(tmpdir(),"conc-liq-release-concurrent-"));
 try {
  mkdirSync(join(root,"dist"));writeFileSync(join(root,"dist/app.js"),"export const value=1;\n");symlinkSync("app.js",join(root,"dist/app-link.js"));writeFileSync(join(root,"config.json"),"{}\n");
  const files=inventory(root);
  const manifest={format:1,sourceCommit:"fixture",nodeVersion:process.version,files,buildId:""};
  manifest.buildId=releaseId(manifest);writeFileSync(join(root,"release.json"),JSON.stringify(manifest));
  assert.deepEqual(await inventoryConcurrent(root),files);
  assert.equal((await verifyReleaseConcurrent(root)).buildId,manifest.buildId);
  writeFileSync(join(root,"release.json"),JSON.stringify({...manifest,buildId:"0".repeat(64)}));
  await assert.rejects(()=>verifyReleaseConcurrent(root),/contents differ/);
  writeFileSync(join(root,"release.json"),JSON.stringify(manifest));
  writeFileSync(join(root,"dist/app.js"),"export const value=2;\n");
  await assert.rejects(()=>verifyReleaseConcurrent(root),/contents differ/);
  writeFileSync(join(root,"dist/app.js"),"export const value=1;\n");
  writeFileSync(join(root,"injected.js"),"unexpected");await assert.rejects(()=>verifyReleaseConcurrent(root),/contents differ/);
  rmSync(join(root,"injected.js"));
  rmSync(join(root,"config.json"));await assert.rejects(()=>verifyReleaseConcurrent(root),/contents differ/);writeFileSync(join(root,"config.json"),"{}\n");
  symlinkSync(process.execPath,join(root,"external-node"));
  await assert.rejects(()=>verifyReleaseConcurrent(root),/symlink escapes/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
