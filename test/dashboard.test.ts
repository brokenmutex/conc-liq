import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { loadDashboardConfig } from "../src/dashboard/config.js";
import { summarizeRehearsal } from "../src/dashboard/focus.js";

describe("dashboard config", () => {
  it("binds to loopback and loads bounded defaults", () => {
    const config = loadDashboardConfig({ DATABASE_URL: "postgresql://test/db" });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 4_173);
    assert.equal(config.activityBucketBlocks, 500);
    assert.equal(config.activityWindowBlocks, 20_000);
    assert.equal(config.riskGateMaxSnapshotAgeSeconds, 180);
    assert.equal(config.riskGateMaxCanonicalityAgeSeconds, 30);
    assert.equal(config.fullAccountingEnabled, false);
    assert.equal(config.canaryMaxCheckpointAgeSeconds, 180);
  });

  it("rejects unauthenticated remote binding", () => {
    assert.throws(
      () => loadDashboardConfig({
        DASHBOARD_HOST: "0.0.0.0",
        DATABASE_URL: "postgresql://test/db",
      }),
      /DASHBOARD_HOST|Invalid option/i,
    );
  });

  it("reports the configured history source and parses false without coercing it to true", () => {
    const config = loadDashboardConfig({ DATABASE_URL: "postgresql://test/db", HISTORY_SOURCE: "hypersync", ACCOUNTING_FULL_SNAPSHOT_ENABLED: "false" });
    assert.equal(config.historySource, "hypersync");
    assert.equal(config.fullAccountingEnabled, false);
  });
});

describe("dashboard evidence semantics", () => {
  const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  const ui = runInNewContext(source.replace(/^(?:refresh|refreshLivePilot)\(\);\s*$/gm, "") +
    "\n({ cursorSummary, booleanStatus, focusRiskReasons, fresh });") as {
      cursorSummary(value: unknown): string;
      booleanStatus(value: boolean | null, yes: string, no: string): string;
      focusRiskReasons(value: unknown, now: string): string[];
      fresh(value: string, now: string, maxAge: number): boolean;
    };
  const now = "2026-09-06T15:00:00.000Z";

  it("does not present two stopped but matching cursors as fresh data", () => {
    const input = { serverTime: now, sync: { blockLag: "0", hashesMatch: true }, indexer: { updatedAt: "2026-09-06T14:00:00Z" }, replay: { updatedAt: "2026-09-06T14:00:00Z" } };
    assert.equal(ui.cursorSummary(input), "Stale or missing");
    assert.equal(ui.cursorSummary({ ...input, indexer: { updatedAt: now }, replay: { updatedAt: now } }), "Cursors aligned");
    assert.equal(ui.fresh("2026-09-06T15:01:00Z", now, 180), false);
  });

  it("keeps unknown pause and corporate action flags distinct from false", () => {
    assert.equal(ui.booleanStatus(null, "Paused", "No"), "Unknown");
    assert.equal(ui.booleanStatus(null, "Pending", "None"), "Unknown");
    assert.equal(ui.booleanStatus(false, "Paused", "No"), "No");
  });

  it("only removes the sequencer feed finding with fresh observed recovery", () => {
    const focus = { entryReadiness: { chainEligible: true, evaluatedAt: now }, riskGate: { executionEligible: false, reasons: ["sequencer_feed_unavailable", "oracle_price_stale", "risk_block_not_canonical"] } };
    assert.deepEqual(Array.from(ui.focusRiskReasons(focus, now)), ["oracle_price_stale", "risk_block_not_canonical"]);
    assert.equal(ui.focusRiskReasons(focus, "2026-09-06T15:00:21Z").length, 3);
    assert.equal(ui.focusRiskReasons({ ...focus, entryReadiness: { ...focus.entryReadiness, chainEligible: false } }, now).length, 3);
  });

  it("only summarizes completed local lifecycle evidence for this stream", () => {
    const evidence = JSON.parse(readFileSync(new URL("../notes/canary-evidence-2026-09-06/local-lifecycle.json", import.meta.url), "utf8"));
    const result = summarizeRehearsal(evidence, evidence.source.streamKey);
    assert.equal(result?.scope, "local_anvil_mint_observe_decrease_collect");
    assert.deepEqual(Object.keys(result ?? {}).sort(), ["completedAt", "scope", "sourceBlock"]);
    assert.equal(summarizeRehearsal({ ...evidence, broadcastAuthorized: true }, evidence.source.streamKey), null);
    assert.equal(summarizeRehearsal({ ...evidence, finalPosition: { ...evidence.finalPosition, liquidity: "1" } }, evidence.source.streamKey), null);
    assert.equal(summarizeRehearsal(evidence, "different-stream"), null);
    assert.equal(summarizeRehearsal({}, evidence.source.streamKey), null);
  });
});

it("renders continuous paper results separately from session results", () => {
  const source = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
  const nodes = new Map<string, {textContent:string;children:unknown[];classList:unknown;replaceChildren:()=>void}>();
  const element = (id:string) => {
    if (!nodes.has(id)) nodes.set(id,{textContent:"",children:[],classList:{add(){},remove(){},toggle(){}},replaceChildren(){}});
    return nodes.get(id)!;
  };
  const render = runInNewContext(source.replace(/^(?:refresh|refreshLivePilot)\(\);\s*$/gm, "") + "\nrenderPaper;", {
    document:{getElementById:element},
  });
  // Use a minimal waiting state to exercise the actual DOM rendering path.
  const now="2026-09-08T12:00:00Z";
  render({id:"6",createdAt:now,updatedAt:now,heartbeatAt:now,policyHash:"test",
    policy:{executionBasis:"nitro_fork_v1",mode:"guarded",budgetQuote:"998000000",halfWidthSpacings:2,maxHoldingSeconds:86400,maxSourceAgeSeconds:180,maxSlippageBps:50,reentry:{cooldownSeconds:600}},
    state:{status:"waiting",position:null,last:null,navQuote:null,pnlQuote:null,alphaQuote:null,holdQuote:null,feeValueQuote:null,costsPaidQuote:"0",exitReserveQuote:"0",intervals:0,observedSwaps:"0",reasons:[]},
    monitorReasons:[],points:[],campaign:{valid:true,rootSessionId:"5",sessionIds:["5","6"],pnlQuote:"-2000000",alphaQuote:"-3000000",costsPaidQuote:"2000000",sourceAt:now}},now);
  assert.match(element("paper-campaign").textContent,/Automatic reentry enabled/);
  assert.match(element("paper-campaign").textContent,/cumulative P&L -2/);
  assert.match(element("paper-campaign").textContent,/Figures below cover this session/);
  assert.equal(element("paper-pnl").textContent,"—");
});

it('renders live custody, costs and scheduled re-entry without a paper helper',async()=>{
 const source=readFileSync(new URL('../dashboard/app.js',import.meta.url),'utf8').replace(/^(?:refresh|refreshLivePilot)\(\);\s*$/gm,'');
 const nodes=new Map<string,any>(),node=()=>({textContent:'',className:'',append(){},replaceChildren(){}});
 const get=(id:string)=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 const now=new Date().toISOString(),payload={pilot:{computedAt:now,broadcastEnabled:true,
  campaign:{heartbeat_at:now,monitor:['closed'],state:{phase:'closed',desired:'running',closedAt:now,gasSpentQuote:'116834' as string|null,gasSpentWei:'45956713584000',reserveUsdg:'49927111',tokenId:null}},
  actions:[{kind:'approve',status:'confirmed',hash:'0x1234',gas_wei:'6010456200000'}],
  marks:[{snapshot:{netNavQuote:'249791645' as string|null,phase:'closed',marketSession:{regime:'weekend'},snapshot:{timestamp:String(Math.floor(Date.now()/1000)),tick:222410,position:null}}}]}};
 const render=runInNewContext(source+'\nrefreshLivePilot;',{document:{getElementById:get,createElement:node},Node:class {},
  fetch:async()=>({ok:true,json:async()=>payload}),AbortSignal,setTimeout(){}});
 await render();assert.match(get('live-pilot-status').textContent,/WAITING FOR RE-ENTRY/);
 assert.equal(get('live-pilot-nav').textContent,'249.791645 USDG');assert.equal(get('live-pilot-gas').textContent,'0.116834 USDG');assert.equal(get('live-pilot-reserve').textContent,'49.927111 USDG');
 payload.pilot.campaign.state.gasSpentQuote=null;payload.pilot.marks[0]!.snapshot.netNavQuote=null;await render();
 assert.equal(get('live-pilot-nav').textContent,'—');assert.equal(get('live-pilot-gas').textContent,'—');
});
