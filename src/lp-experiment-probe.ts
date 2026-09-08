import {sanitizeRiskError} from './risk/evaluate.js';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {NitroPaperExecutor} from './paper/executor.js';
import {paperPolicy} from './paper/config.js';
import type {PaperCheckpoint} from './paper/engine.js';
import {ExperimentSource} from './experiment/source.js';
import {json,parse} from './experiment/runner.js';
import {loadRuntimeIdentity} from './runtime/identity.js';
async function main(){
 const [selectionPath,output]=process.argv.slice(2);assert(selectionPath&&output);
 const selection=parse(await readFile(selectionPath,'utf8'));
 const groups=[...new Map(selection.selected.map((c:any)=>[`${c.budget}-${c.halfWidthTicks}`,c])).values()] as any[];
 assert(groups.length<=4);const source=new ExperimentSource(process.env.DATABASE_URL!),executor=new NitroPaperExecutor(process.env.DATABASE_URL!);await source.connect();const results=[];
 const current=async(after?:string)=>{
  const rows=await source.checkpoints(new Date(Date.now()-180000).toISOString(),new Date().toISOString());
  const row=rows.filter(r=>!after||new Date(r.source_at).getTime()>Date.parse(after)).at(-1);if(!row)return null;
  await source.coverage(row.block,row.target_set_hash);assert(row.canonical);
  return {id:row.id,block:row.block,hash:row.hash,blockTimestamp:new Date(row.source_at).toISOString(),capturedAt:new Date(row.observed_at).toISOString(),tick:row.tick,sqrtPriceX96:row.price,liquidity:row.liquidity,feeGrowth0:row.global0,feeGrowth1:row.global1,targetSetHash:row.target_set_hash} satisfies PaperCheckpoint;
 };
 try{for(const candidate of groups){
  const policy=paperPolicy({budgetQuote:candidate.budget,halfWidthSpacings:candidate.halfWidthTicks/10,feeAccounting:'initialized_boundaries_v1',lpAllocationPpm:800000,inventoryExitPpm:600000,maxHoldingSeconds:86400,referencePolicy:{kind:'continuous_bounded_v1',maxHeldAgeSeconds:345600,maxDeviationPpm:50000,maxGasPriceAgeSeconds:86400}});
  try{
   const cp=await current();assert(cp,'No fresh source');const quote=await executor.quote(cp,policy);console.log(JSON.stringify({candidate:candidate.id,phase:'quote',block:cp.block}));
   let later:PaperCheckpoint|null=null;
   for(let i=0;i<10&&!later;i++){await new Promise(resolve=>setTimeout(resolve,10000));later=await current(quote.quotedAt);}
   assert(later,'No later fresh checkpoint within probe budget');
   const evidence=await executor.enter(later,policy,quote);
   results.push({candidate,policy,quote,status:'succeeded',evidence});console.log(JSON.stringify({candidate:candidate.id,phase:'round_trip_verified',block:later.block}));
  }catch(error){const message=sanitizeRiskError(error);results.push({candidate,status:'unavailable',error:message});console.log(JSON.stringify({candidate:candidate.id,phase:'unavailable',error:message}));}
 }
 await writeFile(output,json({observedAt:new Date().toISOString(),runtimeIdentity:loadRuntimeIdentity(),scope:'Bounded prospective local-fork cash acquisition, mint, removal and cash liquidation probes; no forward fee income or active recenter validation',executionEligible:false,results}),{flag:'wx'});
 }finally{await source.close();await executor.close();}
}
main().catch(e=>{console.error(sanitizeRiskError(e));process.exitCode=1;});
