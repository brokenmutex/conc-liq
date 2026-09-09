import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {paperSourcesValid,readPaperChain,paperCampaignSummary} from '../src/paper/reentry.ts';
import {PAPER_POOL,PAPER_NVDA} from '../src/paper/engine.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
import {principalAmounts} from '../src/backtest/principal.ts';
import {quoteValue} from '../src/simulator/math.ts';
import {USDG} from '../src/constants.ts';
import {boundaryFeeIncrement,boundaryContinuity} from '../src/paper/boundary-fees.ts';
const [command,input,output]=process.argv.slice(2);
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const hash=x=>createHash('sha256').update(x).digest('hex');
const write=(path,value)=>fs.writeFileSync(path,json(value),{flag:'wx'});
const value=(a0,a1,cp)=>quoteValue({amount0:BigInt(a0),amount1:BigInt(a1),sqrtPriceX96:BigInt(cp.sqrtPriceX96),token0:USDG,token1:PAPER_NVDA,quoteToken:USDG});
const time=t=>new Date(t).toISOString();
const count=xs=>Object.fromEntries([...new Set(xs)].map(k=>[k,xs.filter(x=>x===k).length]));
if(command==='capture'){
 const db=new pg.Client({connectionString:parseEnv(fs.readFileSync(input,'utf8')).DATABASE_URL,options:'-c default_transaction_read_only=on -c statement_timeout=60000'});await db.connect();
 try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const asOf=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const sessions=(await db.query('SELECT * FROM paper_sessions ORDER BY id')).rows;
  const selected=sessions.filter(s=>new Date(s.created_at)>=new Date('2026-09-07T21:00:00Z'));
  const ids=selected.map(s=>s.id),observations=(await db.query('SELECT * FROM paper_observations WHERE session_id=ANY($1::bigint[]) ORDER BY session_id,id',[ids])).rows;
  const executions=(await db.query('SELECT * FROM paper_execution_runs WHERE session_id=ANY($1::bigint[]) ORDER BY id',[ids])).rows;
  const checkpoints=(await db.query(`SELECT c.*,p.sqrt_price_x96::text,p.tick,p.liquidity::text,p.fee_growth_global0_x128::text,p.fee_growth_global1_x128::text,v.canonical,v.expected_hash,v.observed_hash FROM v3_strategy_checkpoint_runs c JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id WHERE c.id=ANY($1::bigint[]) AND lower(p.pool_address)=$2 ORDER BY c.id`,[[...new Set([...observations,...executions].map(x=>x.checkpoint_id))],PAPER_POOL])).rows;
  const from=new Date(new Date(selected[0].created_at).getTime()-360000).toISOString();
  const health=(await db.query('SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at>=$1 AND observed_at<=$2 ORDER BY observed_at,id',[from,asOf])).rows;
  const attempts=(await db.query(`SELECT a.*,r.block_number::text,r.block_hash,r.block_timestamp,r.observed_at,r.snapshot->>'observedAt' AS snapshot_observed_at,v.canonical,v.validated_at FROM risk_snapshot_attempts a LEFT JOIN risk_snapshot_runs r ON r.id=a.risk_run_id LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id WHERE a.attempted_at>=$1 AND a.attempted_at<=$2 ORDER BY a.attempted_at,a.id`,[from,asOf])).rows;
  const poolAddress=(await db.query('SELECT pool_address FROM indexer_pools WHERE lower(pool_address)=$1 LIMIT 1',[PAPER_POOL])).rows[0].pool_address;
  const blocks=checkpoints.map(c=>BigInt(c.block_number));const low=String(blocks.reduce((a,b)=>a<b?a:b)),high=String(blocks.reduce((a,b)=>a>b?a:b));
  const boundaryEvents=(await db.query(`SELECT block_number::text AS block,event_name AS "eventName",event_args AS args FROM v3_pool_events WHERE pool_address=$1 AND block_number>=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index`,[poolAddress,low,high])).rows;
  const validation=[],swapStats=[];
  for(const s of selected){validation.push({id:s.id,valid:await paperSourcesValid(db,s)});const entry=observations.find(o=>o.session_id===s.id&&o.action==='enter');if(!entry)continue;swapStats.push({id:s.id,...(await db.query(`SELECT count(*)::int AS n,min((event_args->>'tick')::int) AS min_tick,max((event_args->>'tick')::int) AS max_tick,count(*) FILTER(WHERE (event_args->>'tick')::int<$4 OR (event_args->>'tick')::int>=$5)::int AS outside_swaps FROM v3_pool_events WHERE pool_address=$1 AND event_name='Swap' AND block_number>$2 AND block_number<=$3`,[poolAddress,entry.block_number,s.state.last.block,entry.state.position.tickLower,entry.state.position.tickUpper])).rows[0]});}
  const chain=await readPaperChain(db,selected.at(-1)),campaign=paperCampaignSummary(chain);
  await db.query('COMMIT');
  const frozen={asOf,scope:'Sessions created since 2026-09-08 00:00 Europe/Vilnius; prior session headers retained for context',sessions,selectedIds:ids,observations,executions,checkpoints,health,attempts,boundaryEvents,validation,swapStats,campaign};
  write(output,frozen);fs.writeFileSync(output+'.sha256',hash(json(frozen))+'\n',{flag:'wx'});
  console.log(json({asOf,sessions:ids,observations:observations.length,executions:executions.length,health:health.length,boundaryEvents:boundaryEvents.length,campaign}));
 }finally{await db.end();}
}else if(command==='report'){
 const raw=fs.readFileSync(input,'utf8');assert.equal(hash(raw),fs.readFileSync(input+'.sha256','utf8').trim());const d=JSON.parse(raw),reports=[];
 const cps=new Map(d.checkpoints.map(c=>[c.id,{id:c.id,block:c.block_number,hash:c.block_hash,blockTimestamp:c.block_timestamp,capturedAt:c.captured_at,sqrtPriceX96:c.sqrt_price_x96,tick:c.tick,liquidity:c.liquidity,feeGrowth0:c.fee_growth_global0_x128,feeGrowth1:c.fee_growth_global1_x128,targetSetHash:c.target_set_hash}]));
 for(const s of d.sessions.filter(s=>d.selectedIds.includes(s.id))){
  assert(d.validation.find(v=>v.id===s.id).valid);const st=s.state,obs=d.observations.filter(o=>o.session_id===s.id),runs=d.executions.filter(x=>x.session_id===s.id),entered=obs.find(o=>o.action==='enter'),exited=obs.find(o=>o.action==='exit'),signal=obs.find(o=>o.action==='signal_exit');
  const er=runs.find(r=>r.id===st.execution?.entryRunId),xr=runs.find(r=>r.id===st.execution?.exitRunId),endcp=st.last;
  const metrics={id:s.id,status:s.status,createdAt:time(s.created_at),budget:s.policy.budgetQuote,parent:s.policy.reentry?.previousSessionId??null,policy:s.policy,runtime:s.runtime_identity,sourceAt:time(endcp.blockTimestamp),valid:true,
   entryAt:entered?time(entered.source_at):null,entryObservedAt:entered?time(entered.observed_at):null,exitAt:exited?time(exited.source_at):null,exitObservedAt:exited?time(exited.observed_at):null,signalAt:signal?time(signal.source_at):null,signalObservedAt:signal?time(signal.observed_at):null,
   holdingMinutes:entered?(Date.parse(endcp.blockTimestamp)-Date.parse(entered.source_at))/60000:null,entryWaitMinutes:entered?(Date.parse(entered.source_at)-Date.parse(s.created_at))/60000:null,exitDelaySeconds:signal&&exited?(Date.parse(exited.source_at)-Date.parse(signal.source_at))/1000:null,
   nav:st.navQuote,pnl:st.pnlQuote,alpha:st.alphaQuote,hold:st.holdQuote,fees:st.feeValueQuote,costs:st.costsPaidQuote,reserve:st.exitReserveQuote,drawdownPpm:st.maxDrawdownPpm,
   exitReasons:signal?.state.reasons??[],entryReasons:count(obs.filter(o=>!o.state.position).flatMap(o=>o.state.reasons)),attempts:count(runs.map(r=>r.action+':'+r.status)),failed: runs.filter(r=>r.status==='failed').map(r=>({id:r.id,action:r.action,at:r.observed_at,source:r.source_block,error:r.snapshot.error,preflightError:r.snapshot.preflight?.error??null})),recovered:!!xr?.snapshot.recovery,
   swapStats:d.swapStats.find(x=>x.id===s.id),observations:obs.length,intervals:st.intervals,observedSwaps:st.observedSwaps,
  };
  if(entered){
   const ep=entered.state.position,entrycp=entered.state.last,H0=ep.hold0,H1=ep.hold1,B=BigInt(s.policy.budgetQuote),ec=paperGasQuote(er.snapshot.result.entryGasWei,er.snapshot.valuation),xc=xr?paperGasQuote(xr.snapshot.result.totalGasWei,xr.snapshot.valuation):0n;
   assert.equal(String(ec+xc),st.costsPaidQuote);metrics.entryGas=String(ec);metrics.exitGas=String(xc);metrics.entryRange=[ep.tickLower,ep.tickUpper];metrics.entryTick=entrycp.tick;metrics.exitTick=endcp.tick;
   const pr=cp=>Number((1n<<192n)*10n**30n/BigInt(cp.sqrtPriceX96)**2n)/1e18;
   metrics.entryPrice=pr(entrycp);metrics.endPrice=pr(endcp);metrics.priceChangePpm=Math.round((pr(endcp)/pr(entrycp)-1)*1e6);
   const endInventory=xr?.snapshot.result.inventory??st.position,principal=principalAmounts({liquidity:BigInt(endInventory.liquidity),tickLower:endInventory.tickLower,tickUpper:endInventory.tickUpper,sqrtPriceX96:BigInt(endcp.sqrtPriceX96)});
   const grossPrincipal=value(principal.amount0+BigInt(endInventory.idle0),principal.amount1+BigInt(endInventory.idle1),endcp),grossWithFees=value(principal.amount0+BigInt(endInventory.idle0)+BigInt(endInventory.fee0),principal.amount1+BigInt(endInventory.idle1)+BigInt(endInventory.fee1),endcp);
   const holdEntry=value(H0,H1,entrycp),holdEnd=value(H0,H1,endcp),feeMarginal=grossWithFees-grossPrincipal;
   const exitDrag=xr?grossWithFees-BigInt(xr.snapshot.result.balances.afterExit.quote):0n;
   const parts={benchmarkMarketMove:holdEnd-holdEntry,entryExecutionDrag:B-holdEntry,lpInventoryVersusHolding:grossPrincipal-holdEnd,marginalFeeValue:feeMarginal,exitExecutionDrag:exitDrag,gas:ec+xc,reserve:BigInt(st.exitReserveQuote)};
   const reconstructed=parts.benchmarkMarketMove-parts.entryExecutionDrag+parts.lpInventoryVersusHolding+parts.marginalFeeValue-parts.exitExecutionDrag-parts.gas-parts.reserve;
   assert.equal(String(reconstructed),st.pnlQuote,`session ${s.id} PnL decomposition`);assert.equal(String(BigInt(st.navQuote)-BigInt(st.holdQuote)),st.alphaQuote);
   metrics.decomposition=parts;metrics.decompositionError='0';
   metrics.entryImmediateNav=entered.state.navQuote;metrics.entryImmediateDrag=String(B-BigInt(entered.state.navQuote));
   const initialPrincipal=principalAmounts({liquidity:BigInt(ep.liquidity),tickLower:ep.tickLower,tickUpper:ep.tickUpper,sqrtPriceX96:BigInt(entrycp.sqrtPriceX96)});
   metrics.entryLpAllocationPpm=Number(value(initialPrincipal.amount0,initialPrincipal.amount1,entrycp)*1000000n/B);metrics.entryIdleQuote=ep.idle0;metrics.entryIdleNvdaValue=String(value(0n,ep.idle1,entrycp));
   const intent=entered.state.execution.intent,quoteCp=intent?cps.get(runs.find(r=>r.action==='quote'&&r.source_block===intent.sourceBlock)?.checkpoint_id):null;
   metrics.quoteToEntrySeconds=intent?(Date.parse(entered.source_at)-Date.parse(intent.quotedAt))/1000:null;metrics.quoteTick=quoteCp?.tick??null;metrics.quoteToEntryTickMove=quoteCp?entrycp.tick-quoteCp.tick:null;

   const exposure=o=>{const p=o.state.position,ref=o.state.reference?.referencePriceX18;if(!p||!ref||p.liquidity==='0')return null;const q=principalAmounts({liquidity:BigInt(p.liquidity),tickLower:p.tickLower,tickUpper:p.tickUpper,sqrtPriceX96:BigInt(o.state.last.sqrtPriceX96)});const rv=(q.amount1+BigInt(p.idle1)+BigInt(p.fee1))*BigInt(ref)/10n**30n,total=q.amount0+BigInt(p.idle0)+BigInt(p.fee0)+rv-BigInt(o.state.costsPaidQuote)-BigInt(o.state.exitReserveQuote);return total>0n?Number(rv*1000000n/total):null;};
   metrics.entryExposurePpm=exposure(entered);metrics.signalExposurePpm=signal?exposure(signal):null;metrics.maxObservedExposurePpm=Math.max(...obs.map(exposure).filter(v=>v!==null));
   let inSeconds=0,outSeconds=0,feeIntervals=0;let previous=entered;
   for(const o of obs.filter(o=>BigInt(o.block_number)>BigInt(entered.block_number))){if(!o.state.position)continue;const seconds=(Date.parse(o.source_at)-Date.parse(previous.source_at))/1000;const tick=previous.state.last.tick; if(tick>=ep.tickLower&&tick<ep.tickUpper)inSeconds+=seconds;else outSeconds+=seconds;
    const old=previous.state.position,proof=o.state.position.boundaryFees,changes=d.boundaryEvents.filter(e=>BigInt(e.block)>BigInt(previous.block_number)&&BigInt(e.block)<=BigInt(o.block_number));
    if(s.policy.feeAccounting){assert(boundaryContinuity(old.boundaryFees,proof,changes),`boundary continuity ${s.id}/${o.id}`);const inc=boundaryFeeIncrement(previous.state.last,o.state.last,old.boundaryFees,proof,BigInt(old.liquidity),BigInt(old.feeRemainder0??'0'),BigInt(old.feeRemainder1??'0'));
     assert.equal(String(BigInt(old.fee0)+inc.fee0),o.state.execution.earnedFee0);assert.equal(String(BigInt(old.fee1)+inc.fee1),o.state.execution.earnedFee1);feeIntervals++;}previous=o;
   }
   metrics.inRangeSecondsApprox=inSeconds;metrics.outsideSecondsApprox=outSeconds;metrics.verifiedFeeIntervals=feeIntervals;
   metrics.gasTransactions=runs.filter(r=>r.status==='succeeded'&&['entry','exit'].includes(r.action)).map(r=>({id:r.id,action:r.action,transactions:r.snapshot.result.transactions.filter(t=>r.action==='exit'||['approve_entry_swap','buy_nvda','approve_mint_usdg','approve_mint_nvda','mint'].includes(t.action)).map(t=>({action:t.action,gas:t.estimate.gas,baseFeeWei:t.estimate.baseFeeWei,parentGas:t.estimate.parentGas,quote:String(paperGasQuote(t.estimate.totalFeeWei,r.snapshot.valuation))}))}));
  }
  if(signal){const now=Date.parse(signal.state.pendingSince??signal.observed_at);const hs=d.health.filter(h=>Date.parse(h.snapshot.observedAt)>=now-320000&&Date.parse(h.snapshot.observedAt)<=now);
   metrics.healthFindings=hs.flatMap(h=>{const p=h.snapshot,at=Math.floor(Date.parse(p.observedAt)/1000),issues=[];for(const q of p.probes){if(q.error||q.anchorError)issues.push(q.name+':probe_or_anchor_error');else{if(BigInt(q.headBlock??0)-BigInt(p.anchorBlock??0)<64n)issues.push(q.name+':depth_'+String(BigInt(q.headBlock??0)-BigInt(p.anchorBlock??0)));if(at-Number(q.headTimestamp)>15||at-Number(q.headTimestamp)<0)issues.push(q.name+':age_'+String(at-Number(q.headTimestamp)));if(q.anchorHash?.toLowerCase()!==p.anchorHash?.toLowerCase())issues.push(q.name+':hash_mismatch');}}return p.state!=='healthy'||issues.length?[{id:h.id,at:p.observedAt,state:p.state,lagBlocks:p.lagBlocks,lagSeconds:p.lagSeconds,reasons:p.reasons,issues}]:[];});
   const attempt=d.attempts.filter(a=>Date.parse(a.attempted_at)<=now).at(-1);const prior=d.attempts.filter(a=>a.status==='succeeded'&&Date.parse(a.completed_at)<=now).at(-1);
   metrics.riskAttemptAtSignal=attempt?{id:attempt.id,startedAt:attempt.attempted_at,completedAt:attempt.completed_at,statusNow:attempt.status,inFlightAtSignal:Date.parse(attempt.completed_at)>now,completionAfterSignalMs:Date.parse(attempt.completed_at)-now,priorCompleteId:prior?.id,priorSnapshotAgeSeconds:prior?(now-Date.parse(prior.snapshot_observed_at))/1000:null}:null;
  }
  reports.push(metrics);
 }
 const closed=reports.filter(r=>r.status==='closed'),sum=k=>closed.reduce((n,r)=>n+BigInt(r[k]),0n),totals={completed:closed.length,open:reports.filter(r=>r.status!=='closed').length,winning:closed.filter(r=>BigInt(r.pnl)>0).length,positiveSessionAlpha:closed.filter(r=>BigInt(r.alpha)>0).length,pnl:sum('pnl'),fees:sum('fees'),gas:sum('costs'),sessionAlphaSum:sum('alpha'),holdingMinutes:closed.reduce((n,r)=>n+r.holdingMinutes,0),decomposition:Object.fromEntries(Object.keys(closed[0].decomposition).map(k=>[k,closed.reduce((n,r)=>n+BigInt(r.decomposition[k]),0n)]))};
 assert.equal(String(totals.pnl),String(BigInt(closed.at(-1).nav)-BigInt(closed[0].budget)));
 const result={asOf:d.asOf,sourceSha256:hash(raw),source:input,campaign:d.campaign,totals,sessions:reports,limitations:['Paper local-fork gas estimates and simulated proceeds; no real broadcasts','No counterfactual claim that removing a guard saves its entire loss','Sum of session alpha is not campaign alpha; session holdings reset and cash intervals matter','LP relative inventory term includes mint funding/mark effects and divergence; not isolated causal adverse selection','Fee income from hypothetical fee-growth accounting; occupancy approximated between checkpoints']};write(output,result);console.log(json({asOf:d.asOf,campaign:d.campaign,totals}));
}else throw Error('Usage: node --import tsx scripts/paper-performance-audit.mjs capture PRIVATE_ENV OUTPUT | report FROZEN_SOURCE OUTPUT');
