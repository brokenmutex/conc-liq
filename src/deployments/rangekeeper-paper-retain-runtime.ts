import assert from 'node:assert/strict';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import {DeploymentConflict,type DeploymentStore} from './store.js';
import {loadRangeKeeperPaperExitContext,rangeKeeperPaperExitContextSeed} from './rangekeeper-paper-context.js';
import {readCanonicalPaperNextFrame} from './paper-preview.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';
import {resolveRangeKeeperPaperPolicy} from './rangekeeper-paper-open-model.js';
import {produceRangeKeeperPaperGasEvidence} from './rangekeeper-paper-gas-evidence.js';
import {sampleRangeKeeperPaperGasStages,terminalInventoryHash} from './rangekeeper-paper-gas-sampler.js';
import {buildRangeKeeperPaperExitModel,terminalQuote} from './rangekeeper-paper-exit-model.js';
import {persistTrustedRangeKeeperPaperExitPreview} from './rangekeeper-paper-exit-preflight.js';

/** Freeze the prior mark while sampling a real retain sequence and while its
 * preview is reviewed. Mark writers share this lock; acceptance makes the
 * operation pending before releasing it. All transactions are on a local fork. */
export async function prepareRangeKeeperPaperExitPreview(input:{store:DeploymentStore;
 client:RobinhoodClient;campaignId:string;buildId:string;rpcUrl:string;
 exitKind:'retain'|'convert';
 onFailure?:(stage:string,error:unknown)=>void}){
 const {store,client,campaignId,buildId}=input;
 const lease=await store.acquirePaperPreparationLease(campaignId);let retained=false,stage='persisted_context';
 try{
  const snapshot=await store.rangeKeeperPaperExitContextSnapshot(campaignId),
   seed=rangeKeeperPaperExitContextSeed(snapshot,campaignId);
  if(!seed)throw new DeploymentConflict('rangekeeper_persisted_context_unavailable');
  stage='canonical_frame';
  const frame=await readCanonicalPaperNextFrame(client,seed.profile,
   {sourceBlock:seed.previousSource.block,sourceHash:seed.previousSource.hash});
  const verifyAnchors=(chainId:number,sources:Parameters<typeof verifyCanonicalPaperAnchors>[2])=>
   verifyCanonicalPaperAnchors(client,chainId,sources);
  await verifyAnchors(seed.profile.pool.chainId,[seed.openSource,seed.candidateSource,seed.previousSource,frame.source]);
  const readGasProfiles=(q:{poolAddress:string;pathVersion:string;sizeBand:string})=>
   store.rangeKeeperPaperGasProfiles(q.poolAddress,q.pathVersion,q.sizeBand);
  stage='context_replay';
  const context=await loadRangeKeeperPaperExitContext({campaignId,buildId,frame,
   readSnapshot:async()=>snapshot,readGasProfiles});
  if(context.status!=='available')throw new DeploymentConflict(context.reason);
  const policy=resolveRangeKeeperPaperPolicy(context.draft,buildId);
  assert(policy.policy&&policy.unavailable.length===0,'rangekeeper_terminal_policy_unavailable');
  const candidate=context.currentEpoch.candidate,p=context.draft.profile.pool;
  const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
  assert(frame.price0&&frame.price1&&frame.poolLiquidity+candidate.liquidity>0n,
   'rangekeeper_terminal_reference_unavailable');
  const scope={poolAddress:p.pool,profileHash:context.draft.profileHash,
   candidateHash:context.currentEpoch.candidateHash,deployedValue:
    principal.amount0*frame.price0/10n**BigInt(p.decimals0)+principal.amount1*frame.price1/10n**BigInt(p.decimals1),
   sharePpm:candidate.liquidity*1_000_000n/(frame.poolLiquidity+candidate.liquidity),range:candidate.range,
   swapKind:candidate.swap?'direct_pool_exact_input' as const:'none' as const,
   inventoryHash:terminalInventoryHash(context,candidate,frame)};
  stage='terminal_quote';
  const conversion=await terminalQuote({candidateHash:scope.candidateHash,kind:input.exitKind,
   frame,draft:context.draft,amount0:principal.amount0+context.kernel.wallet0,
   amount1:principal.amount1+context.kernel.wallet1,chain:new RangeKeeperChain(client,p),
   limits:policy.policy.limits});
  stage='owned_fork_sampling';
  const report=await produceRangeKeeperPaperGasEvidence({kind:input.exitKind==='retain'?'retain_exit':'convert_exit',campaignId,
   revision:context.draft.revision,configHash:context.draft.configHash,buildId,profile:context.draft.profile,
   frame,candidateSource:context.currentEpoch.source,candidateReferenceProofHash:context.currentEpoch.candidateReferenceProofHash,
   candidate,openMarkId:context.openMarkId,openModelHash:contentHash(context.openModel),scope,
   marketGasPriceWei:await client.getGasPrice(),sampleOwnedFork:request=>sampleRangeKeeperPaperGasStages(request,{
    rpcUrl:input.rpcUrl,beforeRead:async()=>{},maxRequests:1600,timeoutMs:150_000,
    limits:policy.policy!.limits,terminalContext:context,...(conversion?{conversionQuote:conversion}:{})})});
  await lease.assertHealthy();
  stage='gas_registration';
  await store.registerRangeKeeperPaperGasEvidence({report,client,replayPersistedContext:async({report,frame})=>{
   const current=await loadRangeKeeperPaperExitContext({campaignId,buildId,frame,
    readSnapshot:()=>store.rangeKeeperPaperExitContextSnapshot(campaignId),readGasProfiles});
   if(current.status!=='available'||current.snapshotHash!==context.snapshotHash||
    current.currentEpoch.candidateHash!==report.candidateHash||
    terminalInventoryHash(current,candidate,frame)!==report.scope.inventoryHash)
    throw new DeploymentConflict('rangekeeper_paper_exit_gas_context_changed');
   return {replayHash:contentHash({snapshotHash:current.snapshotHash,source:frame.source,
    inventoryHash:report.scope.inventoryHash,candidateHash:report.candidateHash})};
  }});
  stage='exit_model';
  const marketGasPriceWei=await client.getGasPrice();
  const model=await buildRangeKeeperPaperExitModel({client,draft:context.draft,openModel:context.openModel,
   openMarkId:context.openMarkId,currentEpoch:context.currentEpoch,previous:context.previous,kernel:context.kernel,readGasProfiles,buildId,
   exitKind:input.exitKind,frame,now:Date.now(),marketGasPriceWei,marketGasPriceObservedAt:Date.now(),
   simulate:async()=>{throw new Error('rangekeeper_paper_recenter_execution_unavailable');}});
  if(model.status!=='indicative')return model;
  if(contentHash(model.conversion)!==contentHash(conversion))
   throw new DeploymentConflict('rangekeeper_exit_sampled_quote_changed');
  stage='preview_persistence';
  // Sampling and model construction can take long enough for the preparation
  // lease to expire. Do not persist a preview unless this worker still owns
  // the campaign's preparation window at the mutation boundary.
  await lease.assertHealthy();
  const saved=await persistTrustedRangeKeeperPaperExitPreview({store,draft:context.draft,model,
   kind:input.exitKind==='retain'?'close_retain':'close_convert',verifyAnchors});
  await lease.assertHealthy();lease.retainUntil(saved.expiresAt);retained=true;
  return {...model,...saved,expiresAt:saved.expiresAt.toISOString(),trustedPreviewSaved:true,
   operationAcceptanceAvailable:false,actionAvailable:false};
 }catch(error){try{input.onFailure?.(stage,error);}catch{/* Diagnostics cannot change the result. */}
  throw error;
 }finally{if(!retained)await lease.release();}
}

export function prepareRangeKeeperPaperRetainPreview(input:Omit<
 Parameters<typeof prepareRangeKeeperPaperExitPreview>[0],'exitKind'>){
 return prepareRangeKeeperPaperExitPreview({...input,exitKind:'retain'});
}
