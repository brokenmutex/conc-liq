import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateCanaryEntryReadiness} from '../src/canary-plan/entry-readiness.ts';
const [previousPath,currentPath,metricsPath,output]=process.argv.slice(2);
assert(previousPath&&currentPath&&metricsPath&&output,'Usage: node --import tsx scripts/paper-session-update.mjs PREVIOUS_SOURCE CURRENT_SOURCE CURRENT_METRICS OUTPUT');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=p=>{assert.equal(hash(p),fs.readFileSync(p+'.sha256','utf8').trim());return JSON.parse(fs.readFileSync(p,'utf8'));};
const old=read(previousPath),d=read(currentPath),m=JSON.parse(fs.readFileSync(metricsPath,'utf8'));
assert.equal(m.sourceSha256,hash(currentPath));
const previous=new Map(old.sessions.filter(s=>old.selectedIds.includes(s.id)).map(s=>[s.id,s]));
const sessions=d.sessions.filter(s=>d.selectedIds.includes(s.id));
const newlyClosed=sessions.filter(s=>s.status==='closed'&&previous.get(s.id)?.status!=='closed');
const frozenClosed=[...previous.values()].filter(s=>s.status==='closed');
for(const prior of frozenClosed){const current=sessions.find(s=>s.id===prior.id);assert(current);for(const k of ['state','policy','runtime_identity'])assert.deepEqual(current[k],prior[k],`Prior session ${prior.id} ${k} changed`);}
const sum=(rows,k)=>String(rows.reduce((n,s)=>n+BigInt(s[k]),0n));
const at=x=>Date.parse(x);
const reports=[];
for(const s of newlyClosed){
 const metrics=m.sessions.find(x=>x.id===s.id),os=d.observations.filter(o=>o.session_id===s.id);
 const signal=os.find(o=>o.action==='signal_exit'),entry=os.find(o=>o.action==='enter');assert(signal&&entry);
 const reasons=signal.state.reasons;
 const group=reasons.includes('corporate_action_pending')?'token_safety':reasons.includes('paper_inventory_threshold_exit_to_cash')?'inventory':reasons.some(r=>r.startsWith('chain_'))?'chain':reasons.includes('paper_usdg_oracle_price_stale')?'quote_reference':'unclassified';
 const range=entry.state.position,tick=signal.state.last.tick;
 const row={id:s.id,group,entryAt:metrics.entryAt,exitAt:metrics.exitAt,holdingMinutes:metrics.holdingMinutes,pnl:metrics.pnl,alpha:metrics.alpha,fees:metrics.fees,costs:metrics.costs,
  decomposition:metrics.decomposition,signalObservation:signal.id,signalAt:signal.observed_at,exitReasons:reasons,signalInside:tick>=range.tickLower&&tick<range.tickUpper,signalTick:tick,range:[range.tickLower,range.tickUpper],
  signalExposurePpm:metrics.signalExposurePpm,actualAllocationPpm:metrics.entryLpAllocationPpm,quoteToEntrySeconds:metrics.quoteToEntrySeconds,quoteToEntryTickMove:metrics.quoteToEntryTickMove,
  exitDelaySeconds:metrics.exitDelaySeconds,verifiedFeeIntervals:metrics.verifiedFeeIntervals,failedPreflights:metrics.failed,sourceValid:metrics.valid,runtime:s.runtime_identity};
 if(group==='chain'){
  const now=at(signal.state.pendingSince),samples=d.health.filter(h=>at(h.snapshot.observedAt)>=now-360000&&at(h.snapshot.observedAt)<=now);
  const gate=evaluateCanaryEntryReadiness({now:new Date(now).toISOString(),sourceBlock:BigInt(signal.block_number),samples});
  const expected=signal.entry_reasons.filter(r=>r.startsWith('chain_'));
  assert(expected.every(r=>gate.reasons.includes(r)),`Chain gate differs for ${s.id}`);
  const selected=new Set(gate.sampleIds),faults=[];
  for(const h of samples.filter(h=>selected.has(h.id))){
   const x=h.snapshot,depths=Object.fromEntries(x.probes.map(p=>[p.name,p.headBlock===null||x.anchorBlock===null?null:String(BigInt(p.headBlock)-BigInt(x.anchorBlock))]));
   const insufficient=x.probes.some(p=>p.headBlock!==null&&x.anchorBlock!==null&&BigInt(p.headBlock)-BigInt(x.anchorBlock)<64n);
   if((x.state!=='healthy'&&x.reasons.some(r=>r!=='recovery_hysteresis'))||insufficient)faults.push({id:h.id,at:x.observedAt,state:x.state,reasons:x.reasons,lagBlocks:x.lagBlocks,lagSeconds:x.lagSeconds,depths,
    probes:x.probes.map(p=>({name:p.name,syncing:p.syncing,error:p.error,anchorError:p.anchorError,anchorHash:p.anchorHash}))});
  }
  row.chain={productionGateReproduced:true,gate,sampleCount:gate.sampleIds.length,faults};
 }
 reports.push(row);
}
const totals=Object.fromEntries(['pnl','fees','costs'].map(k=>[k,sum(reports,k)]));
assert.equal(BigInt(totals.pnl),BigInt(newlyClosed.at(-1).state.navQuote)-BigInt(newlyClosed[0].policy.budgetQuote));
const groups=[...new Set(reports.map(s=>s.group))].map(group=>{const rows=reports.filter(s=>s.group===group);return {group,ids:rows.map(s=>s.id),count:rows.length,...Object.fromEntries(['pnl','fees','costs'].map(k=>[k,sum(rows,k)]))};});
const result={asOf:d.asOf,previousAsOf:old.asOf,sourceSha256:hash(currentPath),previousSourceSha256:hash(previousPath),scriptSha256:hash('scripts/paper-session-update.mjs'),
 oldClosedUnchanged:frozenClosed.length,newSessionIds:sessions.filter(s=>!previous.has(s.id)).map(s=>s.id),newlyClosedIds:reports.map(s=>s.id),
 newlyClosed:{count:reports.length,winning:reports.filter(s=>BigInt(s.pnl)>0n).length,positiveSessionAlpha:reports.filter(s=>BigInt(s.alpha)>0n).length,...totals,
  initialCash:newlyClosed[0].policy.budgetQuote,finalCash:newlyClosed.at(-1).state.navQuote,feeIntervals:reports.reduce((n,s)=>n+s.verifiedFeeIntervals,0),groups,
  decomposition:Object.fromEntries(Object.keys(reports[0].decomposition).map(k=>[k,String(reports.reduce((n,s)=>n+BigInt(s.decomposition[k]),0n))]))},
 sincePreviousMark:{navChange:String(BigInt(d.campaign.navQuote)-BigInt(old.campaign.navQuote)),holdingChange:String(BigInt(d.campaign.holdQuote)-BigInt(old.campaign.holdQuote)),alphaChange:String(BigInt(d.campaign.alphaQuote)-BigInt(old.campaign.alphaQuote))},
 campaign:d.campaign,latestSession:{id:sessions.at(-1).id,status:sessions.at(-1).status,heartbeatAt:sessions.at(-1).heartbeat_at,reasons:sessions.at(-1).state.reasons},reports,
 limitations:['Newly closed cycles include all of session 31, which was already open at the previous cutoff; this differs from mark-to-mark changes',
  'Per-session alphas reset holdings and cannot be summed into campaign alpha','First-exit categories do not establish losses avoided by removing a guard',
  'Recorded chain evidence is replayed, not replaced with hypothetical historical hashes','No policy changes, new comparison, funded execution or realized live PnL']};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({asOf:result.asOf,oldClosedUnchanged:result.oldClosedUnchanged,newlyClosed:result.newlyClosed,sincePreviousMark:result.sincePreviousMark},null,2));
