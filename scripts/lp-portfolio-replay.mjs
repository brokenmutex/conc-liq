// Frozen-file research only: no environment, database, network, signer or broadcast.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {pipeline} from 'node:stream/promises';
import {FeeReplay} from '../src/research/fee-replay.ts';
import {ResearchPortfolio} from '../src/research/portfolio.ts';
import {sessionReferenceAt} from '../src/research/session-reference.ts';

const [timingPath,referencePath,output,budgetText='1000',endUtc]=process.argv.slice(2);
assert(timingPath&&referencePath&&output,'Usage: node --import tsx scripts/lp-portfolio-replay.mjs TIMESTAMPS REFERENCES OUTPUT [BUDGETS_CSV]');
const sourcePath='data/lp-research-2026-09-07/source.jsonl.gz',pool='0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';
const digest=s=>createHash('sha256').update(s).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const timingText=await readFile(timingPath,'utf8'),referenceText=await readFile(referencePath,'utf8');
const timing=JSON.parse(timingText),references=JSON.parse(referenceText),headers=new Map(timing.headers.map(h=>[h.number,h]));
assert.equal(references.manifest.timestampSha256,digest(timingText));
assert.equal(references.manifest.fromBlock,timing.fromBlock);assert.equal(references.manifest.toBlock,timing.toBlock);
const from=headers.get(timing.fromBlock).timestamp,sourceTo=headers.get(timing.toBlock).timestamp,to=endUtc?Date.parse(endUtc)/1000:sourceTo;
assert(Number.isSafeInteger(to)&&to>from&&to<=sourceTo);
const budgets=budgetText.split(',').map(Number);assert(budgets.length&&new Set(budgets).size===budgets.length&&budgets.every(b=>[250,500,1000,2000,3000,4000,5000].includes(b)));
const closure={start:Date.parse('2026-08-14T21:00:00Z')/1000,end:Date.parse('2026-08-16T22:00:00Z')/1000};
assert(to<Date.parse('2026-08-17T00:00:00Z')/1000&&from<Date.parse('2026-08-15T00:00:00Z')/1000);
const policy={rwaMaxAgeSeconds:86400,quoteMaxAgeSeconds:86400,closures:to>=closure.start?[closure]:[]};
const costRaw=[10000,50000,250000,1000000],feeIncomePpm=[1000000,500000];
const codeSha256={};for(const path of ['scripts/lp-portfolio-replay.mjs','src/research/portfolio.ts','src/research/portfolio-math.ts',
 'src/research/session-reference.ts','src/research/historical-reference.ts','src/research/fee-replay.ts','src/research/swap.ts','src/research/range-screen.ts',
 'src/backtest/principal.ts','src/risk/evaluate.ts'])codeSha256[path]=digest(await readFile(path));
const manifest={schemaVersion:1,executionEligible:false,sourcePath,sourceSha256:timing.sourceSha256,timingPath,referencePath,
 timestampSha256:digest(timingText),referenceSha256:digest(referenceText),fromBlock:timing.fromBlock,toBlock:timing.toBlock,
 from:new Date(from*1000).toISOString(),to:new Date(to*1000).toISOString(),sourceTo:new Date(sourceTo*1000).toISOString(),pool,fee:500,tickSpacing:10,
 budgets,halfWidthTicks:[10,20,30,40,50],modes:['fixed','persistent70'],transactionCostQuoteRaw:costRaw,feeIncomePpm,referencePolicy:policy,codeSha256,
 strategy:{referenceTolerancePpm:50000,maxLpPpm:800000,minCashReserveAtMintPpm:200000,inventoryTriggerPpm:600000,inventoryTargetPpm:500000,
 decisionSeconds:60,persistenceObservations:2,cooldownSeconds:600,delaySeconds:60,maxSwapSlippageBps:50,minimumPlacementQuoteRaw:'1000000'},
 assumptions:[
 'Every run and passive comparator begin with the same pre-held, preapproved 40% NVDA / 60% USDG inventory at the opening independent reference. Acquisition and approval costs are excluded from this endowed-inventory experiment.',
 'Each mint, bundled remove/collect, and inventory swap deducts the stated hypothetical flat USDG operation cost from cash. These costs are sensitivities, not measured path costs.',
 'Mint at most 80% of current reference NAV using actual available tokens, retaining at least 20% in USDG at mint. No forced purchase for a 50/50 split; underdeployment is allowed.',
 'Observed swap fee segments are diluted by hypothetical added liquidity and clipped to our bounds; historical price path and other LP behavior remain unchanged. This is a counterfactual approximation, not an exact market simulation.',
 'Inventory sales quote exact historical depth after removing our LP. Immediate remint uses the resulting price/depth; the next canonical observation returns to the historical path. Induced arbitrage and flow changes are unmodeled.',
 '50% fee-income scenario is a haircut to allocated fees, not a simulation of 50% fewer swaps.',
 'Session schedule is an explicit US_Equities_24/5 research assumption: Friday 17:00 ET to Sunday 18:00 ET closed. Closure holds the last valid NVDA anchor; USDG remains independently age-gated. Reopening requires a new publication.',
 '24-hour active age ceilings use mapped feed heartbeats as a research scenario; operational 300-second settings are unchanged.',
 'Token code, pause and multiplier are checked using the latest available sparse archive snapshot; forward-filling is an assumption. Continuous issuer/registry/sequencer evidence is unavailable.',
 'Terminal removal is charged and remaining NVDA is marked at independent reference, not liquidated. Passive comparator holds initial tokens. Missing terminal reference or failed removal gives null alpha.',
 'Marks and risk triggers are minute observations with a 60-second action delay; intraminute excursions can exceed measured exposure and drawdown. Fixed ranges share the same guard and inventory intervention rules.'
 ]};
await mkdir(dirname(output),{recursive:true});await writeFile(output+'.manifest.json',json(manifest),{flag:'wx'});
console.log(JSON.stringify({phase:'frozen',from:manifest.from,to:manifest.to,runs:budgets.length*5*2*costRaw.length*feeIncomePpm.length}));
const opening=sessionReferenceAt(references.roles,policy,from);assert(opening.priceX18!==null,'Opening independent reference unavailable');
const portfolios=[];for(const b of budgets)for(const halfWidthTicks of manifest.halfWidthTicks)for(const mode of manifest.modes)for(const c of costRaw)for(const f of feeIncomePpm)
 portfolios.push(new ResearchPortfolio(BigInt(b)*1000000n,opening.priceX18,{halfWidthTicks,mode,transactionCostQuote:BigInt(c),feeIncomePpm:f}));
const replay=new FeeReplay(pool,500),referenceMarks=[],tokenBaseline=references.tokenSnapshots[0].state;
function market(at){
 const ref=sessionReferenceAt(references.roles,policy,at),token=references.tokenSnapshots.filter(s=>s.at<=at).at(-1)?.state;
 const tokenSafe=!!token&&!token.oraclePaused&&token.codeHash===tokenBaseline.codeHash&&token.uiMultiplier==='1000000000000000000'&&
   token.newUIMultiplier===token.uiMultiplier&&token.effectiveAt==='0';
 return {at,referenceX18:ref.priceX18,referenceMode:ref.mode,tokenSafe,price:replay.pool.sqrtPriceX96,tick:replay.pool.tick,
 liquidity:replay.pool.liquidity,fee:500,spacing:10,ticks:replay.sortedTicks,net:t=>replay.ticks.get(t)?.net??0n,ref};
}
let next=from,matched=0,swaps=0,flashes=0,lastTime=from,manifestSeen=false,countsSeen=false;
function decisionsBefore(at){while(next<at&&next<=to){const m=market(next);assert(m.price!==null&&m.tick!==null);referenceMarks.push({...m.ref,tokenSafe:m.tokenSafe});for(const p of portfolios)p.decision(m);next+=60;}}
const input=createReadStream(sourcePath),gunzip=createGunzip(),hash=createHash('sha256');gunzip.on('data',c=>hash.update(c));
const done=pipeline(input,gunzip);done.catch(()=>{});
try{for await(const line of createInterface({input:gunzip,crlfDelay:Infinity})){
 const record=JSON.parse(line);
 if(record.kind==='manifest'){assert(!manifestSeen);manifestSeen=true;assert.equal(record.manifest.cursor.chain_id,'4663');continue;}
 if(record.kind==='counts'){countsSeen=true;continue;}
 assert(manifestSeen&&record.kind==='event');const row=record.event;if(row.pool_address.toLowerCase()!==pool.toLowerCase())continue;
 const block=Number(row.block_number);if(block>timing.toBlock)continue;
 if(block>=timing.fromBlock){const header=headers.get(block);assert(header&&header.hash.toLowerCase()===row.block_hash.toLowerCase());
  assert(header.timestamp>=lastTime);lastTime=header.timestamp;decisionsBefore(lastTime);matched++;if(lastTime>to)continue;}
 const old={price:replay.pool.sqrtPriceX96,tick:replay.pool.tick,liquidity:replay.pool.liquidity,p0:replay.pool.feeProtocol0,p1:replay.pool.feeProtocol1};
 const event={poolAddress:row.pool_address,blockNumber:BigInt(row.block_number),blockHash:row.block_hash,transactionHash:row.transaction_hash,
  transactionIndex:row.transaction_index,logIndex:row.log_index,eventName:row.event_name,args:row.event_args};
 const segments=replay.apply(event);
 if(block>=timing.fromBlock){
  if(event.eventName==='Swap')swaps++;
  if(event.eventName==='Flash'){flashes++;for(const token of [0,1])segments.push({from:old.price,to:old.price,tickBefore:old.tick,liquidity:old.liquidity,
   fee:BigInt(event.args[token===0?'paid0':'paid1']),token,crossed:null});}
  for(const s of segments)for(const p of portfolios)p.accrue(s,s.token===0?old.p0:old.p1);
 }
}await done;}finally{input.destroy();gunzip.destroy();}
assert(countsSeen);assert.equal(hash.digest('hex'),timing.sourceSha256,'Frozen source hash mismatch');assert.equal(matched,timing.counts[pool]);
decisionsBefore(to+1);const terminal=market(to),results=portfolios.map(p=>p.finish(terminal));
const reasons={};for(const r of referenceMarks)for(const reason of r.reasons)reasons[reason]=(reasons[reason]??0)+1;
const coverage={matchedEvents:matched,swaps,flashes,observations:referenceMarks.length,referencePassing:referenceMarks.filter(r=>r.available).length,
 heldPassing:referenceMarks.filter(r=>r.available&&r.mode==='scheduled_closed_held').length,reasons,terminalReferenceAvailable:terminal.referenceX18!==null};
await writeFile(output,json({manifest,coverage,referenceMarks,results}),{flag:'wx'});
await writeFile(output+'.summary.json',json({manifest,coverage,results:results.map(({actions,marks,...rest})=>rest)}),{flag:'wx'});
console.log(JSON.stringify({phase:'complete',output,runs:results.length,coverage}));
