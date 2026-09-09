import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const [base,notes]=process.argv.slice(2);assert(base&&notes,'Usage: summarize-management-audit.mjs DATA_DIRECTORY NOTES_DIRECTORY');
const read=path=>JSON.parse(fs.readFileSync(path,'utf8'));
const hash=path=>createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const r=read(base+'/reconciliation-v2.json'),c=read(base+'/counterfactuals.json'),metrics=read(notes+'/session-metrics.json');
assert.equal(r.asOf,c.asOf);assert.equal(c.asOf,metrics.asOf);
const exitGroups=Object.entries(c.exitCounts).map(([group,count])=>{
 const ids=c.buffer.filter(b=>b.exitGroup===group).map(b=>b.session),ss=metrics.sessions.filter(s=>ids.includes(s.id));assert.equal(ss.length,count);
 return {group,count,ids,...Object.fromEntries(['pnl','fees','costs'].map(k=>[k,String(ss.reduce((n,s)=>n+BigInt(s[k]),0n))]))};
});
const sourceFiles=['paper-source.json','market-source.json','reconciliation-v2.json','counterfactuals.json'];
const codeFiles=['scripts/capture-management-audit.mjs','scripts/management-decision-audit.mjs','scripts/management-counterfactual-audit.mjs','scripts/summarize-management-audit.mjs',
 'src/research/management-audit.ts','src/experiment/market.ts','src/experiment/portfolio.ts','src/experiment/source.ts','src/research/portfolio-math.ts','src/research/swap.ts','src/backtest/principal.ts','src/simulator/math.ts','src/paper/transaction-engine.ts'];
const count=items=>items.reduce((out,k)=>({...out,[k]:(out[k]??0)+1}),{});
const comparisons=c.cases.filter(x=>x.branches).map(x=>({session:x.session,exitGroup:x.exitGroup,anchorObservation:x.anchorObservation,
 anchorSourceAt:x.anchorSourceAt,anchorObservedAt:x.anchorObservedAt,anchorBeforeSignalSeconds:x.anchorBeforeSignalSeconds,horizonSourceAt:x.horizonSourceAt,paired:x.paired,
 branches:x.branches.map(b=>({action:b.action,costMultiplier:b.costMultiplier,initialBlock:b.initialBlock,invalid:b.final.invalid,
  nav:b.final.nav,liquidationNav:b.final.liquidationNav,alphaVsAnchorHolding:b.final.liquidationAlphaVsHolding,
  futureGas:b.final.costs,drawdownPpm:b.final.drawdownPpm,maxExposurePpm:b.final.maxExposurePpm,recenters:b.final.recenters,exits:b.final.exits,
  blocked:b.final.blocked,decisionObservations:b.decisionObservations,accountingOnly:b.accountingOnly,
  exitReasons:[...new Set(b.actions.filter(a=>a.action==='signal_exit'||a.action==='cash_exit').map(a=>a.reason))]}))}));
const baseRecenters=c.cases.flatMap(x=>x.branches?.filter(b=>b.action==='recenter'&&b.costMultiplier===1)??[]);
const recenterDisposition={initialBlocks:count(baseRecenters.filter(b=>b.initialBlock).map(b=>b.initialBlock)),quotedThenSafetyExit:count(baseRecenters.filter(b=>!b.initialBlock).map(b=>b.actions.find(a=>a.action==='signal_exit')?.reason??'unresolved'))};
const out={asOf:r.asOf,sources:Object.fromEntries(sourceFiles.map(f=>[base+'/'+f,{sha256:hash(base+'/'+f),bytes:fs.statSync(base+'/'+f).size}])),codeSha256:Object.fromEntries(codeFiles.map(f=>[f,hash(f)])),
 reconciliation:{verifiedCheckpoints:r.verifiedCheckpoints,sessions:r.sessions.length,marks:r.sessions.reduce((n,s)=>n+s.marks.length,0),allMarkDifferencesZero:r.sessions.every(s=>s.marks.every(m=>m.difference==='0')),
  cycle:r.cycle,cycleDetails:r.sessions.filter(s=>r.cycle.ids.includes(s.id)).map(({marks,...s})=>({...s,marks:marks.length})),nativeBridge:r.native.map(s=>({session:s.session,bridge:s.bridge})),
  allSessionResults:r.sessions.map(({marks,...s})=>({...s,marks:marks.length})),limitations:r.limitations},
 performance:{campaign:metrics.campaign,totals:metrics.totals,exitGroups},buffer:c.buffer,design:c.design,summary:c.summary,recenterDisposition,comparisons,
 inventoryRiskIllustration:{budgetUSDG:1000,rows:[0.6,0.8].map(exposure=>({exposurePercent:exposure*100,riskyValueUSDG:1000*exposure,lossAt5PercentFurtherDeclineUSDG:1000*exposure*0.05,lossAt10PercentFurtherDeclineUSDG:1000*exposure*0.1})),
  scope:'Static NVDA holdings after the LP becomes one-sided, with remaining assets held as cash. Arithmetic illustration, not a forecast or backtest; excludes fees, trading costs and issuer/reference risks.'}};
fs.writeFileSync(notes+'/summary.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({asOf:out.asOf,recenterDisposition,files:Object.keys(out.sources),verified:out.reconciliation.allMarkDifferencesZero}));
