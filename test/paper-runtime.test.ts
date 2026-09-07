import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { PoolClient } from "pg";
import { assertRuntimeMatches } from "../src/runtime/identity.js";
import { readPaperReferenceGate } from "../src/paper/reference.js";
import { DEFAULT_PAPER_POLICY } from "../src/paper/engine.js";

it("rejects missing or changed build, config and Node identity", () => {
  const id = {buildId:"a".repeat(64),configHash:"b".repeat(64),nodeVersion:process.version};
  assertRuntimeMatches(id, {...id});
  assert.throws(() => assertRuntimeMatches(null, id), /runtime differs/);
  assert.throws(() => assertRuntimeMatches(id), /runtime differs/);
  for (const key of ["buildId","configHash","nodeVersion"] as const) {
    assert.throws(() => assertRuntimeMatches(id,{...id,[key]:"changed"}), /runtime differs/);
  }
});

it("characterizes temporary and stale current-risk rejection without changing the policy", async () => {
  const snapshot = JSON.parse(readFileSync(new URL("./fixtures/paper-risk-snapshot.json",import.meta.url),"utf8"));
  const cp = JSON.parse(readFileSync(new URL("./fixtures/paper-reference-preflight.json",import.meta.url),"utf8")).cp;
  const now = new Date(Date.parse(snapshot.observedAt)+1000).toISOString();
  const valid = {status:"succeeded",snapshot,canonical:true,validated_at:new Date(snapshot.observedAt)};
  async function evaluate(latest: unknown) {
    let calls=0;
    const db = {query:async () => ({rows:++calls === 1 ? [{snapshot,canonical:true}] : latest ? [latest] : []})} as unknown as Pick<PoolClient,"query">;
    return readPaperReferenceGate(db,cp,DEFAULT_PAPER_POLICY.referencePolicy!,now);
  }
  assert.equal((await evaluate(valid)).eligible,true);
  for (const latest of [null, {...valid,status:"started"}, {...valid,status:"failed"}, {...valid,snapshot:null},
    {...valid,canonical:false}, {...valid,validated_at:null}, {...valid,validated_at:new Date(Date.parse(now)-31000)},
    {...valid,snapshot:{...snapshot,observedAt:new Date(Date.parse(now)-181000).toISOString()}}]) {
    const decision=await evaluate(latest);
    assert.equal(decision.eligible,false);
    assert(decision.reasons.includes("paper_current_risk_evidence_unavailable"));
  }
});
