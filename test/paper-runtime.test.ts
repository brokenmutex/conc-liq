import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { PoolClient } from "pg";
import { assertRuntimeMatches } from "../src/runtime/identity.js";
import { readPaperReferenceGate, evaluatePaperCurrentRisk, type PaperCurrentRiskRead } from "../src/paper/reference.js";
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

it("allows only bounded refresh overlap with a still-valid completed snapshot", async () => {
  const snapshot = JSON.parse(readFileSync(new URL("./fixtures/paper-risk-snapshot.json",import.meta.url),"utf8"));
  const cp = JSON.parse(readFileSync(new URL("./fixtures/paper-reference-preflight.json",import.meta.url),"utf8")).cp;
  const now = new Date(Date.parse(snapshot.observedAt)+1000).toISOString();
  const attempt = {id:'10',status:'succeeded',attemptedAt:snapshot.observedAt,completedAt:snapshot.observedAt,riskRunId:'10'};
  const valid: PaperCurrentRiskRead = {evaluatedAt:now,latest:attempt,inFlightStartedAt:null,
    selected:{...attempt,snapshot,canonical:true,validatedAt:snapshot.observedAt,blockNumber:snapshot.blockNumber,blockHash:snapshot.blockHash}};
  async function evaluate(read: PaperCurrentRiskRead) {
    const db = {query:async () => ({rows:[{...read,source:{snapshot,canonical:true}}]})} as unknown as Pick<PoolClient,"query">;
    return readPaperReferenceGate(db,cp,DEFAULT_PAPER_POLICY.referencePolicy!,now);
  }
  assert.equal((await evaluate(valid)).eligible,true);
  const refresh: PaperCurrentRiskRead = {...valid,latest:{...attempt,id:'11',status:'started',completedAt:null,riskRunId:null},inFlightStartedAt:attempt.attemptedAt};
  const allowed = await evaluate(refresh);
  assert.equal(allowed.eligible,true);assert.equal(allowed.evidence.current.usingPreviousCompleted,true);
  assert.equal(allowed.evidence.current.selected!.id,'10');
  assert.equal(allowed.evidence.current.latest!.status,'started');
  assert.equal(allowed.evidence.current.snapshotSha256?.length,64);
  const at=(delta:number)=>new Date(Date.parse(now)+delta).toISOString();
  for (const read of [
    {...valid,latest:null,selected:null}, {...valid,latest:{...attempt,status:'failed'},selected:{...valid.selected!,status:'failed'}},
    {...refresh,selected:null}, {...refresh,selected:{...valid.selected!,status:'failed'}},
    {...refresh,inFlightStartedAt:at(-10001)}, {...refresh,inFlightStartedAt:at(1)},
    {...refresh,latest:{...refresh.latest!,attemptedAt:at(1)}},
    {...refresh,selected:{...valid.selected!,snapshot:null}}, {...refresh,selected:{...valid.selected!,canonical:false}},
    {...refresh,selected:{...valid.selected!,validatedAt:null}},
    {...refresh,selected:{...valid.selected!,validatedAt:at(-30001)}}, {...refresh,selected:{...valid.selected!,validatedAt:at(1)}},
    {...refresh,selected:{...valid.selected!,completedAt:at(1)}},
    {...refresh,selected:{...valid.selected!,snapshot:{...snapshot,observedAt:at(-180001)}}},
    {...refresh,selected:{...valid.selected!,snapshot:{...snapshot,blockTimestamp:at(-180001)}}},
    {...refresh,selected:{...valid.selected!,snapshot:{...snapshot,observedAt:'invalid'}}},
    {...refresh,selected:{...valid.selected!,blockHash:'0xwrong'}},
  ]) {
    const decision=await evaluate(read);
    assert.equal(decision.eligible,false);
    assert(decision.reasons.includes("paper_current_risk_evidence_unavailable"));
    assert(decision.evidence.current.failedChecks.length>0);
  }
  assert.equal((await evaluate({...refresh,inFlightStartedAt:at(-10000)})).eligible,true);
  // A validation after the caller began, but before the SQL snapshot, is not future evidence.
  const evaluatedAt=at(50);
  const concurrent=await readPaperReferenceGate({query:async()=>({rows:[{...valid,evaluatedAt,
    selected:{...valid.selected!,validatedAt:at(25)},source:{snapshot,canonical:true}}]})} as unknown as Pick<PoolClient,'query'>,
    cp,DEFAULT_PAPER_POLICY.referencePolicy!,now);
  assert.equal(concurrent.eligible,true);assert.equal(concurrent.evidence.current.evaluatedAt,evaluatedAt);
  // Structural and true-price checks still evaluate the selected snapshot during refresh.
  for(const kind of ['pause','usdg_stale','price_band'] as const){
    const changed=structuredClone(snapshot);
    if(kind==='pause')changed.assets.find((a:any)=>a.registry.symbol==='NVDA').onchain.oraclePaused=true;
    if(kind==='usdg_stale')changed.quoteOracle.state.updatedAt='1';
    if(kind==='price_band')changed.assets.find((a:any)=>a.registry.symbol==='NVDA').oracle.state.answer='1';
    const result=evaluatePaperCurrentRisk({...refresh,selected:{...valid.selected!,snapshot:changed}},cp,DEFAULT_PAPER_POLICY.referencePolicy!);
    assert.equal(result.eligible,false,kind);assert.equal(result.evidence.failedChecks.length,0,kind);
  }
});
