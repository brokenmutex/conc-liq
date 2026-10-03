import assert from 'node:assert/strict';
import type {Pool,PoolClient} from 'pg';
import {getAddress} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {rangeKeeperConfirmedSource} from '../strategy/rangekeeper/source.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {rangeKeeperJson} from '../strategy/rangekeeper/live-domain.js';
import {markRangeKeeper} from '../strategy/rangekeeper/live-mark.js';
import {rawValue} from '../strategy/rangekeeper/planner.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import {readCompletePositionManagerNftCustody} from './live-transfer-nft-enumeration.js';
import {readRangeKeeperLiveWalletEvidenceAtSource} from './rangekeeper-live-queue-adapters.js';
import {readRangeKeeperLiveStageReferences,verifyRangeKeeperLiveStageReferences} from './rangekeeper-live-references.js';
import {readRangeKeeperLiveCampaign,recordRangeKeeperLiveValuationMarkInTransaction,recordRangeKeeperNftCustodySnapshotInTransaction} from './rangekeeper-live-campaign-store.js';
import {createRangeKeeperLiveReviewRuntime,rangeKeeperPinnedSemanticProofHash} from './rangekeeper-live-review-runtime.js';
import {deriveRangeKeeperCampaignStageSnapshot,type RangeKeeperLiveCampaign,type RangeKeeperLiveManagementReviewPayload,
 type RangeKeeperStageReferences} from './rangekeeper-live-campaign.js';
import {readCommitments,readWalletState,withLiveWalletTransaction,type LiveWalletIdentity,type LiveWalletSnapshotInput} from './live-wallet-store.js';
import {readLiveWalletLane} from './live-wallet-queue.js';
import {liveWalletCommitmentFingerprint,liveWalletInventoryMatchesState} from './live-wallet-commitment-projection.js';
import {verifyRangeKeeperWalletCode} from '../strategy/rangekeeper/wallet-code.js';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import {contentHash} from './contracts.js';
import {simulateRangeKeeperRetain} from '../strategy/rangekeeper/fork-simulator.js';
import {recordRangeKeeperLiveManagementReview,type RangeKeeperLiveManagementObservation,type RangeKeeperLiveManagementQueueInput} from './rangekeeper-live-management.js';
import type {RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';

const lower=(v:string)=>v.toLowerCase();
const sameSource=(a:any,b:any)=>String(a?.block)===String(b?.block)&&lower(String(a?.hash??''))===lower(String(b?.hash??''))&&Number(a?.timestamp)===Number(b?.timestamp);
const ceilDiv=(a:bigint,b:bigint)=>a===0n?0n:(a+b-1n)/b;

export interface RangeKeeperLiveManagementObserverInput {
 pool:Pool;client:RobinhoodClient;wallet:LiveWalletIdentity;loadProfiles:(client:PoolClient)=>Promise<readonly unknown[]>;
 transferStore:PositionManagerTransferIndexStore;buildId:string;rpcUrl:string;anvilBinary:string;
 queueReady:()=>Promise<boolean>;
 enqueue:(job:RangeKeeperLiveManagementQueueInput)=>Promise<{campaignId:string;jobId:string;allocationId?:string;replayed:boolean;status:string}>;
 persistReviews?:boolean;now?:()=>number;
}

/** Concrete canonical source reader and retain-only cost verifier. `observe`
 * is read-only with respect to campaign state; `observeHoldingCampaigns`
 * appends source-bound valuation marks only while the shared queue is idle. */
export function createRangeKeeperLiveManagementObserver(input:RangeKeeperLiveManagementObserverInput){
 const profiles=async(db:PoolClient):Promise<Array<{id:string|null;profile:MarketProfile}>>=>{
  const rows=await input.loadProfiles(db);assert(rows.length>0&&rows.length<=100,'Registered profile scope is unavailable');
  const parsed=rows.map(row=>({id:(row as any)?.id||(row as any)?.profileId?String((row as any).id??(row as any).profileId):null,
   profile:marketProfileSchema.parse((row as any)?.profile??row)}));
  assert(new Set(parsed.map(row=>row.profile.pool.pool.toLowerCase())).size===parsed.length,'Duplicate registered pool profile');
  assert(new Set(parsed.map(row=>row.profile.pool.positionManager.toLowerCase())).size===1,'Registered profiles do not share one manager');
  return parsed;
 };
 const sourceNow=async()=>{
  const source=await rangeKeeperConfirmedSource(input.client);
  assert(source.block>=0n&&/^0x[0-9a-f]{64}$/i.test(source.hash)&&Number.isSafeInteger(source.timestamp),'Confirmed source malformed');
  const now=Math.floor((input.now??Date.now)()/1000);
  assert(source.timestamp<=now+5&&now-source.timestamp<=180,'Canonical source is stale or from the future');
  return source;
 };
 const observedWallet=async(source:RangeKeeperSource,allProfiles:readonly {id:string|null;profile:MarketProfile}[])=>{
  const existing=await readRangeKeeperLiveWalletEvidenceAtSource({client:input.client,wallet:input.wallet.address,source,
   profiles:allProfiles.map(row=>row.profile),transferStore:input.transferStore});
  const manager=getAddress(allProfiles[0]!.profile.pool.positionManager);
  const custody=await readCompletePositionManagerNftCustody({client:input.client,store:input.transferStore,targetStrategyId:'rangekeeper_v1',
   operator:input.wallet.address,positionManager:manager,source,startBlock:0n});
  assert(custody.status==='available'&&custody.enumerationComplete&&custody.tokenIds,'Complete wallet NFT custody unavailable');
  const commitments=await readCommitments(input.pool,input.wallet),ids=custody.tokenIds;
  const oldRows=commitments.nftCustody.filter(n=>lower(n.manager)===lower(manager));
  const accounted=oldRows.filter(n=>n.status==='active'||n.status==='retired_empty').map(n=>n.tokenId).sort();
  assert.deepEqual([...ids].sort(),accounted,'Canonical NFT owner set differs from allocated custody ledger');
  const retired:string[]=[],positions=[] as Array<{tokenId:string;owner:string;liquidity:string;tokensOwed0:string;tokensOwed1:string}>;
  for(const id of ids){
   const p=await input.client.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[BigInt(id)],blockNumber:source.block});
   const prior=oldRows.find(n=>n.tokenId===id);assert(prior,'Owned NFT has no persisted custody owner');
   if(prior.status==='retired_empty'){assert(p[7]===0n&&p[10]===0n&&p[11]===0n,'Retired NFT is no longer empty');retired.push(id);}
   else{
    assert(prior.status==='active','Unmanaged active NFT blocks wallet observation');
    assert(String(p[7])===prior.liquidity&&String(p[10])===prior.tokensOwed0&&String(p[11])===prior.tokensOwed1,
     'Active NFT changed without a canonical receipt allocation update');
   }
   positions.push({tokenId:id,owner:input.wallet.address,liquidity:String(p[7]),tokensOwed0:String(p[10]),tokensOwed1:String(p[11])});
  }
  const commitmentHash=liveWalletCommitmentFingerprint(commitments);
  const snapshot:LiveWalletSnapshotInput={...input.wallet,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
   nonce:String(existing.nonce),pendingNonce:String(existing.pendingNonce),nativeBalanceWei:String(existing.nativeWei),
   tokens:Object.entries(existing.tokens).map(([address,balance])=>({address,balanceRaw:String(balance)})),
   commitmentsHash:commitmentHash,status:'available'};
  return {existing,custody,positions,retired,snapshot};
 };
 const refresh=async(source:RangeKeeperSource,allProfiles:readonly {id:string|null;profile:MarketProfile}[])=>{
  const obs=await observedWallet(source,allProfiles);
  // The shared queue may hold queued or campaign-local blocked work; the snapshot writer still refuses any unresolved transaction.
  const reviewRuntime=createRangeKeeperLiveReviewRuntime({pool:input.pool,wallet:input.wallet,buildId:input.buildId,requireIdleQueue:false,
   observeWallet:async()=>({snapshot:obs.snapshot,complete:true,missing:[],nft:{positionManager:obs.custody.positionManager!,
    completeEvidence:obs.custody as any,positions:obs.positions,retiredEmptyTokenIds:obs.retired}}),
   verifyCanonical:async s=>{const block=await input.client.getBlock({blockNumber:BigInt(s.block)});
    assert(block.hash&&lower(block.hash)===lower(s.hash)&&Number(block.timestamp)===s.timestamp,'Canonical wallet source changed');}});
  const result=await reviewRuntime.refreshSnapshot();
  assert(result.status==='persisted'&&result.state?.status==='available','Wallet inventory could not be safely refreshed');
  assert(result.state.source?.block===String(source.block)&&lower(result.state.source.hash)===lower(source.hash),'Wallet refresh source differs');
  return {obs,state:result.state};
 };
 const collect=async(campaign:RangeKeeperLiveCampaign,includeRetainCost:boolean,refreshWallet=true):Promise<RangeKeeperLiveManagementObservation>=>{
  // A recenter in progress is observed (never retain-priced) so policy exits can still reach a stuck campaign.
  assert(campaign.state&&campaign.status==='active'&&(campaign.state.phase==='holding'&&campaign.state.activeTokenId!==null||
   campaign.state.phase==='recenter'&&!includeRetainCost),'Management observation requires an active held campaign');
  if(refreshWallet){const lane=await readLiveWalletLane(input.pool,input.wallet);
   assert(!lane.inflight&&!lane.unresolved,'persisted_live_queue_has_priority');}
  const allProfiles=await input.pool.connect().then(async db=>{try{return await profiles(db);}finally{db.release();}});
  const profile=marketProfileSchema.parse(campaign.profile),registered=allProfiles.find(p=>(p.id===null||p.id===campaign.profileId)&&
   contentHash(p.profile)===campaign.profileHash);
  assert(registered&&contentHash(registered.profile)===campaign.profileHash,'Campaign profile is not the current registered profile');
  let source:RangeKeeperSource,state:Awaited<ReturnType<typeof readWalletState>>,obs:Awaited<ReturnType<typeof observedWallet>>;
  if(refreshWallet){source=await sourceNow();({state,obs}=await refresh(source,allProfiles));}
  else{
   const current=await readWalletState(input.pool,input.wallet);assert(current.status==='available'&&current.source&&current.commitmentsHash,
    'Persisted wallet source is unavailable');
   source={block:BigInt(current.source.block),hash:current.source.hash as `0x${string}`,timestamp:current.source.timestamp};
   const latest=await input.client.getBlock();assert(latest.number>=source.block+64n,'Persisted wallet source is not sufficiently confirmed');
   assert(source.timestamp<=Math.floor((input.now??Date.now)()/1000)+5&&
    Math.floor((input.now??Date.now)()/1000)-source.timestamp<=180,'Persisted wallet source is stale');
   obs=await observedWallet(source,allProfiles);state=current;
   assert(obs.snapshot.commitmentsHash===current.commitmentsHash&&liveWalletInventoryMatchesState(current,{nonce:String(obs.existing.nonce),
    nativeBalanceWei:String(obs.existing.nativeWei),tokens:Object.entries(obs.existing.tokens).map(([address,balanceRaw])=>({address,balanceRaw:String(balanceRaw)})),
    commitmentsHash:obs.snapshot.commitmentsHash}),'Observed wallet inventory differs from persisted wallet state');
  }
  assert(state.nonce===String(obs.existing.nonce)&&state.pendingNonce===String(obs.existing.pendingNonce),'Wallet nonce is unsettled');
  const chain=new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances),snapshot=await chain.snapshot(source,campaign.wallet,campaign.state.activeTokenId);
  assert(snapshot.nonce===Number(state.nonce),'Pool snapshot nonce differs from canonical wallet');
  const scoped=deriveRangeKeeperCampaignStageSnapshot(campaign,snapshot),refs=await readRangeKeeperLiveStageReferences({client:input.client,
   campaignId:campaign.id,revision:campaign.revision,profile,source});
  assert(await verifyRangeKeeperLiveStageReferences({client:input.client,campaignId:campaign.id,revision:campaign.revision,profile,expected:refs}),
   'Independent source-bound valuation unavailable');
  const mark=await markRangeKeeper(campaign.state,scoped,chain,campaign.config,{price0:refs.price0,price1:refs.price1});
  const p=scoped.position,heldTokenId=campaign.state.activeTokenId;
  assert(heldTokenId===null?p===null:p!==null&&p.tokenId===heldTokenId,'Campaign NFT snapshot is unavailable');
  // A withdrawn recenter holds loose inventory only: no NFT valuation, but the same canonical wallet and reference proof.
  const feeEvidence=p?{kind:'rangekeeper_live_position_fee_evidence_v1',source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
   tokenId:String(p.tokenId),liquidityRaw:String(p.liquidity),principal0Raw:String(mark.principal0),principal1Raw:String(mark.principal1),
   uncollected0Raw:String(mark.uncollected0),uncollected1Raw:String(mark.uncollected1),grossFee0Raw:String(mark.grossFee0),
   grossFee1Raw:String(mark.grossFee1),inventory0Raw:String(mark.principal0+mark.uncollected0),inventory1Raw:String(mark.principal1+mark.uncollected1),
   collectionSimulation:'canonical_eth_call',referenceProofHash:refs.proofHash}:null;
  const costs=includeRetainCost?await managementCosts(campaign,source,profile,refs):null;
  const position=p?{tokenId:String(p.tokenId),liquidityRaw:String(p.liquidity),principal0Raw:String(mark.principal0),principal1Raw:String(mark.principal1),
   uncollected0Raw:String(mark.uncollected0),uncollected1Raw:String(mark.uncollected1),inventory0Raw:String(mark.inventory0),inventory1Raw:String(mark.inventory1),
   grossFee0Raw:String(mark.grossFee0),grossFee1Raw:String(mark.grossFee1),gasSpentWei:String(campaign.state.gasSpentWei),
   tokenInventoryValueUsdX18:String(mark.nav),
   referenceProofHash:refs.proofHash,feeEvidence}:null;
  const observationHash=contentHash({source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},snapshot:JSON.parse((await import('../strategy/rangekeeper/live-domain.js')).rangeKeeperJson(snapshot)),
   position,refs:refs.proofHash,costs});
  const dbstate=await readWalletState(input.pool,input.wallet);assert(dbstate.status==='available'&&dbstate.source&&dbstate.commitmentsHash,'Refreshed wallet state unavailable');
  assert(dbstate.generation>=campaign.allocation.sourceGeneration,'Wallet generation predates campaign allocation');
  return {source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},snapshot,references:refs,position,
   positionFeeEvidence:feeEvidence,decision:{reason:'retain_only_preview',observationHash},costs,expiresAt:source.timestamp+90};
 };
 const managementCosts=async(campaign:RangeKeeperLiveCampaign,source:RangeKeeperSource,profile:MarketProfile,refs:RangeKeeperStageReferences)=>{
  const tokenId=campaign.state?.activeTokenId;assert(tokenId!==null&&tokenId!==undefined,'Retain cost requires managed NFT');
  const retain=await simulateRangeKeeperRetain({rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary,source,config:campaign.config,
   operator:campaign.wallet,activeTokenId:tokenId,prices:{price0:refs.price0,price1:refs.price1},
   allocation:{amount0:campaign.allocation.liquidByTokenAddress[profile.pool.token0.toLowerCase()]!,
    amount1:campaign.allocation.liquidByTokenAddress[profile.pool.token1.toLowerCase()]!}});
  assert(sameSource(retain.source,{block:String(source.block),hash:source.hash,timestamp:source.timestamp}),'Retain fork proof source changed');
  const stages=retain.gasByStage.map(row=>{const actual=row.gasUsed,estimated=(row as any).estimatedGas;
   assert(actual>0n&&typeof estimated==='bigint'&&estimated>0n,'Retain stage gas proof is incomplete');
   const basis=actual>estimated?actual:estimated;return {...row,gasUnitsBound:ceilDiv(basis*13n,10n)};});
  const gasWei=stages.reduce((sum,row)=>sum+row.gasUnitsBound,0n);
  const block=await input.client.getBlock({blockNumber:source.block}),gasPrice=await input.client.getGasPrice();
  const feePerGas=ceilDiv((block.baseFeePerGas&&block.baseFeePerGas>gasPrice?block.baseFeePerGas:gasPrice)*5n,4n),gasCostWei=gasWei*feePerGas;
  const gasCostValue=ceilDiv(gasCostWei*refs.nativePrice,10n**18n);
  assert(gasCostWei>0n&&gasCostValue>0n&&gasCostWei<=campaign.allocation.exitReserveWei,'Retain cost exceeds reviewed exit reserve');
  const now=Math.floor((input.now??Date.now)()/1000);assert(source.timestamp<=now+5&&now-source.timestamp<=180,'Retain proof source expired');
  return {status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
   stages:stages.map(s=>({kind:s.kind,phase:s.phase,gasUsed:String(s.gasUsed),estimatedGas:String((s as any).estimatedGas),gasUnitsBound:String(s.gasUnitsBound)})),
   gasUnitsBound:String(gasWei),
   feePerGasBoundWei:String(feePerGas),gasWei:String(gasCostWei),gasValueUsdX18:String(gasCostValue),actionCostValue:String(gasCostValue),
   retained0:String(retain.retained0),retained1:String(retain.retained1)};
 };
 const observe=(campaign:RangeKeeperLiveCampaign)=>collect(campaign,true);
 const observeForManagement=async(campaign:RangeKeeperLiveCampaign)=>{
  const result=await collect(campaign,false,false);
  return {source:result.source,snapshot:result.snapshot,references:result.references,position:result.position,
   positionFeeEvidence:(result as any).positionFeeEvidence,decision:result.decision,costs:result.costs,expiresAt:result.expiresAt};
 };
 const verifyPinned=async(campaign:RangeKeeperLiveCampaign,payload:RangeKeeperLiveManagementReviewPayload):Promise<boolean>=>{
  try{
   const allProfiles=await input.pool.connect().then(async db=>{try{return await profiles(db);}finally{db.release();}});
   const row=allProfiles.find(p=>(p.id===null||p.id===campaign.profileId)&&contentHash(p.profile)===payload.profileHash),profile=row?.profile;
   if(!profile||contentHash(profile)!==payload.profileHash)return false;
   const source={block:BigInt(payload.source.block),hash:payload.source.hash as `0x${string}`,timestamp:payload.source.timestamp};
   const latest=await input.client.getBlock();if(latest.number<source.block+64n)return false;
   const header=await input.client.getBlock({blockNumber:source.block});if(!header.hash||lower(header.hash)!==lower(source.hash)||Number(header.timestamp)!==source.timestamp)return false;
   const fresh=await observedWallet(source,allProfiles),wallet=await readWalletState(input.pool,input.wallet);
   if(!wallet.source||fresh.snapshot.commitmentsHash!==wallet.commitmentsHash||!liveWalletInventoryMatchesState(wallet,{nonce:String(fresh.existing.nonce),nativeBalanceWei:String(fresh.existing.nativeWei),
    tokens:Object.entries(fresh.existing.tokens).map(([address,balanceRaw])=>({address,balanceRaw:String(balanceRaw)})),
    commitmentsHash:fresh.snapshot.commitmentsHash})||wallet.source.block!==payload.source.block||lower(wallet.source.hash)!==lower(payload.source.hash))return false;
   await verifyRangeKeeperWalletCode(input.client,source,campaign.wallet,campaign.config);
   const exactSnapshot=await new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances)
    .snapshot(source,campaign.wallet,BigInt(String((payload.position as any)?.tokenId)));
   if(contentHash(JSON.parse(rangeKeeperJson(exactSnapshot)))!==contentHash(JSON.parse(rangeKeeperJson(payload.snapshot))))return false;
   const refs=await readRangeKeeperLiveStageReferences({client:input.client,campaignId:campaign.id,revision:campaign.revision,profile,source});
   return String(wallet.nonce)===String(fresh.existing.nonce)&&String(wallet.pendingNonce)===String(fresh.existing.pendingNonce)&&
    refs.proofHash===payload.reference.proofHash&&String(refs.price0)===payload.reference.price0&&
    String(refs.price1)===payload.reference.price1&&String(refs.nativePrice)===payload.reference.nativePrice&&
    (refs.evidence as any)?.semanticProofHash===(payload.reference.evidence as any)?.semanticProofHash&&
    rangeKeeperPinnedSemanticProofHash({profileHash:contentHash(profile),source:payload.source,references:{price0:payload.reference.price0,
     price1:payload.reference.price1,nativePrice:payload.reference.nativePrice},referenceProof:(refs.evidence as any).referenceProof})===payload.reference.proofHash&&
    rangeKeeperPinnedSemanticProofHash({profileHash:contentHash(profile),source:payload.source,references:{price0:payload.reference.price0,
     price1:payload.reference.price1,nativePrice:payload.reference.nativePrice},referenceProof:(refs.evidence as any).referenceProof})===payload.reference.proofHash;
  }catch{return false;}
 };
 const observeHoldingCampaigns=async()=>{
  if(!await input.queueReady())return {status:'idle' as const,recorded:0,missing:[] as string[]};
  const rows=(await input.pool.query<any>(`SELECT c.id FROM deployment_campaigns c JOIN deployment_revisions r
   ON r.campaign_id=c.id AND r.revision=c.current_revision JOIN deployment_live_campaign_runtime m ON m.campaign_id=c.id AND m.revision=r.revision
   WHERE c.chain_id=4663 AND lower(c.wallet)=$1 AND c.mode='live'
   AND c.lifecycle='active' AND r.strategy_id='rangekeeper_v1' ORDER BY m.updated_at,c.id LIMIT 101`,[input.wallet.address.toLowerCase()])).rows;
  assert(rows.length<=100,'Holding campaign observation bound exceeded');let recorded=0;const missing:string[]=[];
  for(const row of rows){
   if(!await input.queueReady())return {status:'deferred' as const,recorded,missing:[...missing,'wallet_queue_became_busy']};
   let campaign:RangeKeeperLiveCampaign;try{campaign=await readRangeKeeperLiveCampaign(input.pool,{...input.wallet,campaignId:row.id});}
   catch{continue;}
   if(!campaign.state||campaign.state.phase!=='holding'||campaign.state.activeTokenId===null)continue;
   // A campaign with its own queued or blocked job is not marked: its frozen review is bound to the current state hash.
   if((await readLiveWalletLane(input.pool,input.wallet,campaign.id)).campaignWork)continue;
   try{
    const observation=await collect(campaign,false),profile=marketProfileSchema.parse(campaign.profile);
    const walletRead=await readWalletState(input.pool,input.wallet);
    assert(walletRead.source&&sameSource(walletRead.source,observation.source),'Wallet changed after management observation');
    const chain=new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances);
    const fee=(observation.position as any).feeEvidence;
    await withLiveWalletTransaction(input.pool,input.wallet,async db=>{
     const lane=await readLiveWalletLane(db,input.wallet,campaign.id);
     assert(!lane.inflight&&!lane.unresolved&&!lane.campaignWork,'Shared wallet queue became busy');
     await recordRangeKeeperLiveValuationMarkInTransaction(db,{wallet:input.wallet,campaignId:campaign.id,revision:campaign.revision,
     snapshot:observation.snapshot,references:observation.references as any,positionFeeEvidence:fee});
    });recorded++;
   }catch(error){missing.push(`${campaign.id}:${error instanceof Error?error.message:'valuation_unavailable'}`);}
  }
  return {status:'observed' as const,recorded,missing};
 };
 /** Re-anchor the persisted whole-wallet snapshot to a fresh confirmed source. It refuses any unresolved transaction
  * and any balance change that lacks receipt attribution, exactly like every other snapshot writer. */
 const refreshWallet=async()=>{
  const allProfiles=await input.pool.connect().then(async db=>{try{return await profiles(db);}finally{db.release();}});
  const source=await sourceNow();
  return (await refresh(source,allProfiles)).state;
 };
 return {observe,observeForManagement,verifyPinned,observeHoldingCampaigns,refreshWallet};
}
