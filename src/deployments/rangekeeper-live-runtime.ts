import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import type {Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import type {PilotIntent} from '../live-pilot/journal.js';
import type {RangeKeeperLiveWorkerOptions} from './rangekeeper-live-wallet-worker.js';
import {createRangeKeeperLiveWalletRuntime} from './rangekeeper-live-queue-adapters.js';
import {createRangeKeeperLiveManagementObserver} from './rangekeeper-live-management-observer.js';
import {createRangeKeeperLiveManagementPlanner} from './rangekeeper-live-management-planner.js';
import {createRangeKeeperLiveManagementRuntime} from './rangekeeper-live-management.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import {readWalletState} from './live-wallet-store.js';
import {assertLiveRuntimeSchemaReady,assertPositionManagerWalletTransferSchemaReady} from '../storage/compatibility.js';

export interface RangeKeeperLiveRuntimeExecution {
 enabled:true;
 signIntent:(intent:PilotIntent)=>Promise<Hex>;
 publishRaw:(raw:Hex)=>Promise<Hex>;
}

export interface RangeKeeperLiveRuntimeInput {
 pool:Pool;client:RobinhoodClient;walletAddress:string;transferStore:PositionManagerTransferIndexStore;
 loadProfiles:(client:PoolClient)=>Promise<readonly unknown[]>;rpcUrl:string;anvilBinary:string;buildId:string;
 persistReviews?:boolean;
 /** Enables the policy observer, source-bound valuation marks, and automatic reviewed retain/recenter enqueue. */
 managementEnabled?:boolean;
 /** Execution stays disabled unless this explicit signer and publisher pair is provided. */
 execution?:RangeKeeperLiveRuntimeExecution;
 options?:Omit<RangeKeeperLiveWorkerOptions,'signerEnabled'|'publisherEnabled'>;
 readReferences?:Parameters<typeof createRangeKeeperLiveWalletRuntime>[0]['readReferences'];
 verifyReferences?:Parameters<typeof createRangeKeeperLiveWalletRuntime>[0]['verifyReferences'];
 now?:()=>number;
}

/** Compose one shared wallet queue, campaign worker, canonical management
 * observer/planner, and retained-exit review API. Constructing this runtime
 * never starts the worker. Management persistence and transaction execution
 * are independently closed by default. */
export function createRangeKeeperLiveRuntime(input:RangeKeeperLiveRuntimeInput){
 const execution=input.execution;
 assert(/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress),'A single configured operator wallet is required');
 assert(input.managementEnabled!==true||input.persistReviews===true,
  'Automatic management requires explicit live management review persistence');
 if(execution)assert(execution.enabled===true&&typeof execution.signIntent==='function'&&typeof execution.publishRaw==='function',
  'Live execution requires explicit signer and publisher callbacks');
 const wallet:LiveWalletIdentity={chainId:4663,address:input.walletAddress.toLowerCase()};
 let observeAndEnqueueManagement:(()=>Promise<void>)|undefined,refreshWalletSnapshot:(()=>Promise<void>)|undefined;
 const runtime=createRangeKeeperLiveWalletRuntime({pool:input.pool,client:input.client,walletAddress:input.walletAddress,
  transferStore:input.transferStore,loadProfiles:input.loadProfiles,rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary,
  readReferences:input.readReferences,verifyReferences:input.verifyReferences,
  options:{...input.options,signerEnabled:execution!==undefined,publisherEnabled:execution!==undefined},
  observeAndEnqueueManagement:async()=>{await observeAndEnqueueManagement?.();},
  refreshWalletSnapshot:async()=>{await refreshWalletSnapshot?.();}});
 if(execution){runtime.adapters.signIntent=execution.signIntent;runtime.adapters.publishRaw=execution.publishRaw;}
 const observer=createRangeKeeperLiveManagementObserver({pool:input.pool,client:input.client,wallet,
  loadProfiles:input.loadProfiles,transferStore:input.transferStore,buildId:input.buildId,rpcUrl:input.rpcUrl,
  anvilBinary:input.anvilBinary,queueReady:async()=>runtime.adapters.managementObservationReady?.()??false,
  enqueue:job=>runtime.queue.enqueue(job),persistReviews:input.persistReviews===true,now:input.now});
 const planner=createRangeKeeperLiveManagementPlanner({pool:input.pool,client:input.client,wallet,rpcUrl:input.rpcUrl,
  anvilBinary:input.anvilBinary,buildId:input.buildId,observer,queueReady:async()=>runtime.adapters.managementObservationReady?.()??false,
  enqueue:job=>runtime.queue.enqueue(job),enabled:input.managementEnabled===true&&input.persistReviews===true,now:input.now});
 observeAndEnqueueManagement=async()=>{await planner.observeAndEnqueueManagement();};
 refreshWalletSnapshot=async()=>{await observer.refreshWallet();};
 const management=createRangeKeeperLiveManagementRuntime({pool:input.pool,wallet,buildId:input.buildId,
  persistReviews:input.persistReviews===true,observe:observer.observe,verifyPinned:observer.verifyPinned,
  enqueue:job=>runtime.queue.enqueue(job),now:input.now});
 // Process-local self-check only. It cannot prove a separately supervised
 // worker is alive and must not be used by the command server as that proof.
 const workerReadiness=async()=>{
  const missing:string[]=[];
  try{
   await assertLiveRuntimeSchemaReady(input.pool);
   await assertPositionManagerWalletTransferSchemaReady(input.pool);
   if(typeof (input.transferStore as any).assertReady==='function')await (input.transferStore as any).assertReady();
  }catch{missing.push('live_runtime_or_wallet_history_schema_unavailable');}
  if(!execution)missing.push('live_signer_and_publisher_not_configured');
  try{
   const state=await readWalletState(input.pool,wallet),now=Math.floor((input.now??Date.now)()/1000);
   if(state.status!=='available'||!state.source||!state.snapshotHash||!state.commitmentsHash||state.nonce===null||
    state.pendingNonce!==state.nonce)missing.push('canonical_wallet_snapshot_unavailable');
   else if(state.source.timestamp>now+5||now-state.source.timestamp>180)missing.push('canonical_wallet_snapshot_stale');
  }catch{missing.push('canonical_wallet_snapshot_unavailable');}
  if(!await runtime.adapters.managementObservationReady?.().catch(()=>false))missing.push('live_wallet_queue_busy_or_unavailable');
  return {status:missing.length?'unavailable' as const:'available' as const,ready:missing.length===0,
   executionConfigured:execution!==undefined,missing:[...new Set(missing)]};
 };
 return {...runtime,observer,planner,management,workerReadiness,retainPreview:(campaignId:string)=>management.retainPreview(campaignId),
  retainOperation:(campaignId:string,body:Parameters<typeof management.retainOperation>[1])=>management.retainOperation(campaignId,body)};
}
