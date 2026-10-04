// Composition of the REAL RangeKeeper live runtime (createRangeKeeperLiveRuntime with managementEnabled and persisted
// reviews) over the owned fork, with fork-branded test execution hooks, plus the real-time driver used by the scenarios.
// The hooks are the only signer/publisher: they sign with a throwaway key and publish ONLY to the branded loopback fork
// (assertOwnedPaperFork before every sign/publish); nothing can reach the upstream archive.
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {createRangeKeeperLiveRuntime} from '../../../src/deployments/rangekeeper-live-runtime.ts';
import {assertOwnedPaperFork} from '../../../src/paper/fork.ts';
import {sleep} from './management-fork-chain.mjs';

export const jsonSafe=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
const compactResult=result=>{
 if(!result||typeof result!=='object')return result;
 const results=Array.isArray(result.results)?result.results.map(r=>({status:r?.status??null,reason:r?.reason??null,
  campaignId:r?.campaignId??null,queued:r?.queued??null,jobId:r?.jobId??null,converted:r?.converted??null})):undefined;
 return jsonSafe({status:result.status,processed:result.processed,results,
  valuations:result.valuations&&typeof result.valuations==='object'?{status:result.valuations.status,recorded:result.valuations.recorded,
   missing:Array.isArray(result.valuations.missing)?result.valuations.missing.map(m=>String(m).slice(0,160)):undefined}:result.valuations});
};

/** Shared mutable test state observed by every runtime built by the factory. */
export function createExecutionStats(){
 return {signerCalls:0,publishCalls:0,ackLosses:0,signed:[],published:[],plannerPasses:[]};
}

export function createManagementRuntimeFactory({ctx,stats,faults,log,blockRetryMs=2000}){
 const {db,local,fork,clock,account}=ctx;
 const verifyLocalTarget=async()=>{
  assertOwnedPaperFork(fork);
  assert.equal(await local.getChainId(),4663,'Local test publisher is on the wrong chain');
  await local.getBlockNumber({cacheTime:0});
 };
 const signIntent=async intent=>{
  await verifyLocalTarget();
  // Pin the next local block to wall-clock time before the stage is signed; interval 0 keeps the 64 confirmation
  // headers at that same timestamp so the confirmed source is as fresh as the product requires.
  await clock.pinNext();
  stats.signerCalls++;
  const values={nonce:intent.nonce,value:intent.value,gas:intent.gas,maxFeePerGas:intent.maxFeePerGas,maxPriorityFeePerGas:intent.maxPriorityFeePerGas};
  for(const [key,value] of Object.entries(values))assert(value!==undefined&&value!==null,`Synthetic signer received missing ${key}`);
  const raw=await account.signTransaction({chainId:4663,type:'eip1559',nonce:intent.nonce,to:intent.to,data:intent.data,
   value:BigInt(intent.value),gas:BigInt(intent.gas),maxFeePerGas:BigInt(intent.maxFeePerGas),
   maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas),accessList:[]});
  stats.signed.push({hash:keccak256(raw),nonce:intent.nonce,action:intent.action});
  return raw;
 };
 const kindOfRaw=async raw=>(await db.query(`SELECT plan_json->>'kind' kind FROM deployment_live_stage_outbox WHERE signed_raw=$1`,[raw.toLowerCase()])).rows[0]?.kind??null;
 const publishRaw=async raw=>{
  await verifyLocalTarget();
  stats.publishCalls++;
  const hash=await local.request({method:'eth_sendRawTransaction',params:[raw]});
  let included=false;const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
   await verifyLocalTarget();
   const receipt=await local.request({method:'eth_getTransactionReceipt',params:[hash]});
   if(receipt!==null){
    assert.equal(String(receipt.transactionHash).toLowerCase(),hash.toLowerCase(),'Owned fork returned a receipt for another transaction');
    included=true;break;
   }
   await sleep(100);
  }
  assert(included,'Owned fork transaction was not mined before the confirmation test window');
  await verifyLocalTarget();
  await fork.rpc('anvil_mine',['0x40','0x0']);
  stats.published.push({hash,kind:await kindOfRaw(raw)});
  // Publish-acknowledgement loss: the exact bytes were accepted and mined; only the worker's acknowledgement is lost.
  if(faults.dropAckOnKind&&(await kindOfRaw(raw))===faults.dropAckOnKind){
   faults.dropAckOnKind=null;stats.ackLosses++;
   throw new Error('injected_owned_fork_publish_ack_loss');
  }
  return hash;
 };
 let generation=0;
 const create=label=>{
  generation++;
  const runtime=createRangeKeeperLiveRuntime({pool:db,client:local,walletAddress:ctx.wallet,transferStore:ctx.transferStore,
   loadProfiles:async()=>ctx.profileRows.map(row=>({id:row.id,profile:row.profile,profileHash:row.profile_hash})),
   rpcUrl:fork.localUrl,anvilBinary:ctx.anvilBinary,buildId:ctx.buildId,persistReviews:true,managementEnabled:true,
   execution:{enabled:true,signIntent,publishRaw},options:{leaseMs:300_000,blockRetryMs}});
  // Record every automatic management pass the worker runs before it claims work (the property lookup is late-bound
  // inside the composed runtime, so wrapping the planner object observes the real worker path).
  const original=runtime.planner.observeAndEnqueueManagement;
  runtime.planner.observeAndEnqueueManagement=async function(...args){
   const startedAt=Date.now();
   try{
    const result=await original.apply(this,args);
    stats.plannerPasses.push({runtime:label,generation,at:startedAt,ms:Date.now()-startedAt,result:compactResult(result)});
    return result;
   }catch(error){
    stats.plannerPasses.push({runtime:label,generation,at:startedAt,ms:Date.now()-startedAt,error:String(error?.message??error).slice(0,300)});
    throw error;
   }
  };
  log('runtime_created',{label,generation});
  ctx.runtimeRef.current=runtime;
  return runtime;
 };
 return {create,signIntent,publishRaw,verifyLocalTarget};
}

/** Real-time driver. One iteration pins fresh canonical time (a confirmation batch), lets the real worker run its
 * maintenance (recovery + automatic management pass) and one queue step, then checks a persisted-state predicate. */
export function createDriver({clock,getRuntime,log,defaultTickSeconds=20}){
 const trace=[];
 const step=async label=>{
  const startedAt=Date.now();
  let result;
  try{result=await getRuntime().worker.execute();}
  catch(error){result={status:'threw',reason:String(error?.message??error).slice(0,300)};}
  const entry={label,at:startedAt,ms:Date.now()-startedAt,status:result.status,jobId:result.jobId??null,stage:result.stage??null,
   reason:result.reason??null,maintenanceErrors:result.maintenanceErrors??null};
  trace.push(entry);log('worker_step',entry);
  return result;
 };
 const driveUntil=async(label,predicate,{timeoutSec=900,tickSeconds=defaultTickSeconds,idleSleepMs=1500}={})=>{
  const deadline=Date.now()+timeoutSec*1000;let lastTickAt=0;
  for(;;){
   const early=await predicate();if(early)return early;
   if(Date.now()>deadline)throw new Error(`Timed out after ${timeoutSec}s waiting for: ${label}; last worker steps: ${
    JSON.stringify(trace.slice(-5).map(e=>({status:e.status,stage:e.stage,reason:e.reason,jobId:e.jobId})))}`);
   if(Date.now()-lastTickAt>=tickSeconds*1000){await clock.tick();lastTickAt=Date.now();}
   const result=await step(label);
   const hit=await predicate();if(hit)return hit;
   // Between planner passes wait for the next tick; while a job is stepping through stages go straight on.
   if(['idle','blocked','disabled','threw'].includes(result.status))
    await sleep(Math.max(idleSleepMs,tickSeconds*1000-(Date.now()-lastTickAt)));
  }
 };
 return {trace,step,driveUntil};
}
