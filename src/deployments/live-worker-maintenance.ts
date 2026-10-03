import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {getAddress} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import {maintainRegisteredWalletPositionManagerHistory} from '../nft/wallet-transfer-index-runtime.js';
import {rangeKeeperConfirmedSource} from '../strategy/rangekeeper/source.js';
import type {RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {readCompletePositionManagerNftCustody} from './live-transfer-nft-enumeration.js';
import {liveWalletCommitmentFingerprint} from './live-wallet-commitment-projection.js';
import {readCommitments,readWalletState,type LiveWalletIdentity} from './live-wallet-store.js';
import {readRangeKeeperLiveWalletEvidenceAtSource} from './rangekeeper-live-queue-adapters.js';
import {createRangeKeeperLiveReviewRuntime,type RangeKeeperSnapshotObservation} from './rangekeeper-live-review-runtime.js';
import type {CompleteRangeKeeperNftEvidence} from './rangekeeper-live-campaign-store.js';
import type {MarketProfile} from './market-profile.js';
import {redactLiveWorkerText} from './live-worker-signer.js';
import type {LiveWorkerLog} from './live-worker-loop.js';
import type {DeploymentStore} from './store.js';

/** The same registered-profile set the command's live setup runtime uses, so the
 * wallet token scope (and therefore the snapshot) is identical on both sides. */
export async function loadLiveWorkerProfiles(store:Pick<DeploymentStore,'listMarketProfiles'|'paperSetupProfile'>){
 const catalog=await store.listMarketProfiles();
 const loaded=await Promise.all(catalog.filter(row=>row.draftAvailable).map(row=>store.paperSetupProfile(row.id)));
 return loaded.filter(row=>row!==null);
}

const BUSY=new Set(['persisted_live_queue_has_priority','persisted_live_action_recovery_has_priority']);
const BUSY_TEXT=/unresolved (?:stage|pending transaction)/i;
export type LiveWorkerSnapshotOutcome={status:'refreshed'|'busy'|'unavailable';missing:readonly string[]};

export function classifyLiveWorkerSnapshotRefresh(result:{status:string;missing:readonly string[]},
 observationFailure?:unknown):LiveWorkerSnapshotOutcome{
 if(result.status==='persisted'&&result.missing.length===0)return {status:'refreshed',missing:[]};
 if(result.missing.some(code=>BUSY.has(code))||(observationFailure instanceof Error&&BUSY_TEXT.test(observationFailure.message)))
  return {status:'busy',missing:result.missing};
 return {status:'unavailable',missing:result.missing.length?result.missing:['wallet_snapshot_unavailable']};
}

/** Records a canonical wallet snapshot through the existing review runtime's
 * refreshSnapshot (the writer the setup runtime and management observer use).
 * The observation mirrors the management observer's private wallet observation
 * plus the setup runtime's retired-empty rule for unmanaged zero-liquidity NFTs.
 * requireIdleQueue makes any queued/unresolved work a busy result, never an error. */
export async function refreshLiveWorkerWalletSnapshot(input:{pool:Pool;client:RobinhoodClient;wallet:LiveWalletIdentity;
 profiles:readonly MarketProfile[];transferStore:PositionManagerTransferIndexStore;buildId:string;
 source:RangeKeeperSource}):Promise<LiveWorkerSnapshotOutcome>{
 const {pool,client,wallet,profiles,transferStore,source}=input,lower=(v:string)=>v.toLowerCase();
 let observationFailure:unknown;
 const observeWallet=async():Promise<RangeKeeperSnapshotObservation>=>{
  try{
   assert(profiles.length>0,'Registered profile scope is unavailable');
   const existing=await readRangeKeeperLiveWalletEvidenceAtSource({client,wallet:wallet.address,source,profiles,transferStore});
   const manager=getAddress(profiles[0]!.pool.positionManager);
   const custody=await readCompletePositionManagerNftCustody({client,store:transferStore,targetStrategyId:'rangekeeper_v1',
    operator:wallet.address,positionManager:manager,source,startBlock:0n});
   assert(custody.status==='available'&&custody.enumerationComplete&&custody.tokenIds,'Complete wallet NFT custody unavailable');
   const commitments=await readCommitments(pool,wallet),ids=custody.tokenIds;
   const rows=commitments.nftCustody.filter(n=>lower(n.manager)===lower(manager));
   for(const row of rows)if(row.status==='active')assert(ids.includes(row.tokenId),'Allocated NFT is no longer owned');
   const retired:string[]=[],positions=[] as Array<{tokenId:string;owner:string;liquidity:string;tokensOwed0:string;tokensOwed1:string}>;
   for(const id of ids){
    const p=await client.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',
     args:[BigInt(id)],blockNumber:source.block});
    const prior=rows.find(n=>n.tokenId===id),empty=p[7]===0n&&p[10]===0n&&p[11]===0n;
    if(prior?.status==='active')
     assert(String(p[7])===prior.liquidity&&String(p[10])===prior.tokensOwed0&&String(p[11])===prior.tokensOwed1,
      'Active NFT changed without a canonical receipt allocation update');
    else{assert(empty,'Unmanaged active NFT blocks wallet observation');retired.push(id);}
    positions.push({tokenId:id,owner:wallet.address,liquidity:String(p[7]),tokensOwed0:String(p[10]),tokensOwed1:String(p[11])});
   }
   return {snapshot:{...wallet,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
    nonce:String(existing.nonce),pendingNonce:String(existing.pendingNonce),nativeBalanceWei:String(existing.nativeWei),
    tokens:Object.entries(existing.tokens).map(([address,balance])=>({address,balanceRaw:String(balance)})),
    commitmentsHash:liveWalletCommitmentFingerprint(commitments),status:'available'},complete:true,missing:[],
    nft:{positionManager:custody.positionManager!,completeEvidence:custody as unknown as CompleteRangeKeeperNftEvidence,
     positions,retiredEmptyTokenIds:retired}};
  }catch(error){observationFailure=error;throw error;}
 };
 const result=await createRangeKeeperLiveReviewRuntime({pool,wallet,buildId:input.buildId,requireIdleQueue:true,observeWallet,
  verifyCanonical:async s=>{
   const block=await client.getBlock({blockNumber:BigInt(s.block)});
   assert(block.hash&&lower(block.hash)===lower(s.hash)&&Number(block.timestamp)===s.timestamp,'Canonical wallet source changed');
  }}).refreshSnapshot();
 return classifyLiveWorkerSnapshotRefresh(result,observationFailure);
}

export interface LiveWorkerMaintenanceInput {
 pool:Pool;client:RobinhoodClient;wallet:LiveWalletIdentity;buildId:string;
 transferStore:PositionManagerTransferIndexStore;loadProfiles:()=>Promise<readonly {profile:MarketProfile}[]>;
 history:{intervalMs:number;chunkBlocks:bigint;maxBlocksPerRun:bigint};refreshAfterSeconds:number;
 log:LiveWorkerLog;now?:()=>number;
 /** Test seam; defaults to the existing wallet-scoped index runtime and snapshot recorder. */
 maintainHistory?:typeof maintainRegisteredWalletPositionManagerHistory;
 refreshSnapshot?:typeof refreshLiveWorkerWalletSnapshot;
}

/** Cadenced, bounded maintenance of the two facts every dashboard review and
 * every execution step depends on: complete wallet-scoped Position Manager
 * history through a confirmed source, and a fresh canonical wallet snapshot.
 * It never initializes a missing history cursor or patches a gap: the initial
 * genesis backfill stays the explicit `nft-wallet-index` operation. */
export function createLiveWorkerMaintenance(input:LiveWorkerMaintenanceInput){
 const now=input.now??Date.now,maintainHistory=input.maintainHistory??maintainRegisteredWalletPositionManagerHistory,
  refreshSnapshot=input.refreshSnapshot??refreshLiveWorkerWalletSnapshot;
 // historyReason is the last attempt's verdict; it is reported on every pass until the next attempt.
 let nextHistoryAt=0,historyReason:string|null='wallet_history_unchecked',lastKey:string|null=null;
 return async():Promise<{ready:boolean;reasons:readonly string[]}>=>{
  const reasons:string[]=[],profiles=(await input.loadProfiles()).map(row=>row.profile);
  assert(profiles.length>0,'registered_market_profiles_unavailable');
  const source=await rangeKeeperConfirmedSource(input.client);
  if(now()>=nextHistoryAt){
   // After a failure or an unavailable result, wait for the cadence; keep scanning every pass only while catching up.
   nextHistoryAt=now()+input.history.intervalMs;
   try{
    const manager=getAddress(profiles[0]!.pool.positionManager);
    if(!await input.transferStore.getCursor(ROBINHOOD_CHAIN_ID,manager,0n))historyReason='wallet_history_uninitialized';
    else{
     const scan=await maintainHistory({client:input.client,store:input.transferStore,wallet:getAddress(input.wallet.address),profiles,
      source:{block:source.block,hash:source.hash,timestamp:source.timestamp},chunkBlocks:input.history.chunkBlocks,
      maxBlocksPerRun:input.history.maxBlocksPerRun});
     const complete=scan.status==='scanned'&&scan.completeThroughSource===true;
     historyReason=complete?null:scan.status==='scanned'?'wallet_history_catching_up':
      `wallet_history_${(scan as {reason?:string}).reason??'unavailable'}`;
     if(historyReason==='wallet_history_catching_up')nextHistoryAt=0;
     if(scan.status==='scanned'&&(scan.chunks>0||!complete))
      input.log('info','live_worker_wallet_history',{status:scan.status,chunks:scan.chunks,transfers:scan.transfers,
       coveredThroughBlock:scan.coveredThroughBlock,sourceBlock:String(source.block),completeThroughSource:complete});
    }
   }catch(error){
    historyReason='wallet_history_maintenance_failed';
    input.log('error','live_worker_wallet_history_failed',{reason:redactLiveWorkerText(error)});
   }
  }
  if(historyReason)reasons.push(historyReason);
  // Complete history is the precondition for any observation of the wallet.
  if(historyReason===null){
   const state=await readWalletState(input.pool,input.wallet),nowSeconds=Math.floor(now()/1000);
   const fresh=state.status==='available'&&state.source!==null&&state.source.timestamp<=nowSeconds+5&&
    nowSeconds-state.source.timestamp<=input.refreshAfterSeconds;
   if(!fresh){
    let outcome:Awaited<ReturnType<typeof refreshSnapshot>>;
    try{outcome=await refreshSnapshot({pool:input.pool,client:input.client,wallet:input.wallet,profiles,
     transferStore:input.transferStore,buildId:input.buildId,source});}
    catch(error){outcome={status:'unavailable',missing:['wallet_snapshot_refresh_failed']};
     input.log('error','live_worker_wallet_snapshot_failed',{reason:redactLiveWorkerText(error)});}
    // Queued or unresolved work is busy, not a failure: receipts keep the snapshot current while it drains.
    if(outcome.status==='unavailable')reasons.push(...outcome.missing);
    else if(outcome.status==='refreshed')input.log('info','live_worker_wallet_snapshot',{sourceBlock:String(source.block),
     sourceTimestamp:source.timestamp});
   }
  }
  const ready=reasons.length===0,key=reasons.join(',');
  if(key!==lastKey){lastKey=key;if(!ready)input.log('warn','live_worker_not_ready',{reasons});
   else input.log('info','live_worker_ready',{});}
  return {ready,reasons};
 };
}
