import type {Pool} from 'pg';
import {keccak256,getAddress,type Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import type {PinnedCustodySource} from './live-custody-snapshot.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {rangeKeeperConfirmedSource} from '../strategy/rangekeeper/source.js';
import {verifyRangeKeeperWalletCode} from '../strategy/rangekeeper/wallet-code.js';
import type {RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import {contentHash} from './contracts.js';
import {readLiveWalletCommitments} from './live-wallet-commitments.js';
import {allocateLiveWalletBalances} from './live-wallet-allocation.js';
import {readWalletState} from './live-wallet-store.js';
import {liveWalletInventoryMatchesState} from './live-wallet-commitment-projection.js';
import {readLiveWalletAllocation,resolveLiveWalletAddress,type LiveWalletReview} from './live-wallet-reader.js';
import {readCompletePositionManagerNftCustody} from './live-transfer-nft-enumeration.js';
import {buildRangeKeeperLiveSetupPreflight,type RangeKeeperLiveSetupPreflightInput} from './rangekeeper-live-setup-preflight.js';
import {liveSetupEvidenceHash,simulateLiveSetupCandidate} from './rangekeeper-live-setup-simulation.js';
import {readCanonicalPaperOpenFrame,type PaperOpenFrame} from './paper-preview.js';
import {createRangeKeeperLiveReviewRuntime,revalidateRangeKeeperPinnedSemanticHash,
 type RangeKeeperSnapshotObservation} from './rangekeeper-live-review-runtime.js';
import {admitRangeKeeperLiveSetup,createRangeKeeperLiveReviewStoreAdapter,
 type RangeKeeperLiveReviewPayload,type RangeKeeperLiveReviewAdmissionResult} from './rangekeeper-live-review-admission.js';
import type {LiveWalletSnapshotInput,LiveWalletIdentity} from './live-wallet-store.js';
import type {CompleteRangeKeeperNftEvidence,RangeKeeperNftPosition} from './rangekeeper-live-campaign-store.js';
import {randomUUID} from 'node:crypto';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../strategy/rangekeeper/config.js';
import type {DeploymentStore} from './store.js';

/** Re-read independent references at the frozen canonical source. This binds
 * the profile, source, prices and full semantic proof; only fetch-time metadata
 * is normalized by the shared semantic identity helper. */
export async function verifyRangeKeeperLiveSetupPinnedReferences(input:{client:RobinhoodClient;profile:MarketProfile;
 source:PaperOpenFrame['source'];profileHash:string;references:{price0:string;price1:string;nativePrice:string;
 semanticProofHash:string}}):Promise<boolean>{
 try{
  const actualProfileHash=contentHash(input.profile);
  if(actualProfileHash!==input.profileHash)return false;
  const frame=await readCanonicalPaperOpenFrame(input.client,input.profile,input.source);
  if(!frame.referenceEligible||frame.price0===null||frame.price1===null||frame.nativePrice===null||!frame.referenceProof)return false;
  const prices={price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)};
  if(prices.price0!==input.references.price0||prices.price1!==input.references.price1||
   prices.nativePrice!==input.references.nativePrice)return false;
  return await revalidateRangeKeeperPinnedSemanticHash({expectedSemanticProofHash:input.references.semanticProofHash,
   profileHash:input.profileHash,source:input.source,freshProfileHash:actualProfileHash,freshSource:frame.source,
   freshReferences:prices,freshReferenceProof:frame.referenceProof,
   verifyCanonical:async source=>{
    const [chainId,latest,pinned]=await Promise.all([input.client.getChainId(),input.client.getBlock(),
     input.client.getBlock({blockNumber:BigInt(source.block)})]);
    if(chainId!==4663||latest.number<BigInt(source.block)+64n||!pinned.hash||
     pinned.hash.toLowerCase()!==source.hash.toLowerCase()||Number(pinned.timestamp)!==source.timestamp)
     throw Error('live_setup_pinned_reference_source_changed');
   }});
 }catch{return false;}
}

/** Exact wallet-side portion of a frozen setup review. Whole-inventory equality
 * is checked separately against persisted wallet state; this compares the
 * campaign's token pair and NFT custody fields carried in the payload. */
export function rangeKeeperLiveWalletReviewMatchesPayload(review:LiveWalletReview,
 payload:RangeKeeperLiveReviewPayload,profile:MarketProfile):boolean{
 if(review.status!=='available'||review.walletAddress?.toLowerCase()!==payload.wallet.address.toLowerCase()||
  !review.source.confirmed||review.source.block!==payload.source.block||
  review.source.hash?.toLowerCase()!==payload.source.hash.toLowerCase()||review.source.timestamp!==payload.source.timestamp||
  review.commitmentsHash!==payload.wallet.commitmentsHash||review.nftCustody?.status!=='available'||
  review.nftCustody.enumerationComplete!==true||!review.nftCustody.tokenIds)return false;
 const token=(address:string)=>review.tokens.find(row=>row.address.toLowerCase()===address.toLowerCase());
 const token0=token(profile.pool.token0),token1=token(profile.pool.token1),nonce=review.native.nonce,
  pendingNonce=review.native.pendingNonce;
 return Boolean(token0&&token1&&token0.decimals===profile.pool.decimals0&&token1.decimals===profile.pool.decimals1&&
  nonce.status==='available'&&pendingNonce.status==='available'&&nonce.value===payload.wallet.nonce&&
  pendingNonce.value===payload.wallet.nonce&&
  token0.balanceRaw===payload.wallet.token0.balanceRaw&&token0.allocatedRaw===payload.wallet.token0.allocatedRaw&&
  token0.pendingRaw===payload.wallet.token0.pendingRaw&&token0.availableRaw===payload.wallet.token0.freeRaw&&
  token1.balanceRaw===payload.wallet.token1.balanceRaw&&token1.allocatedRaw===payload.wallet.token1.allocatedRaw&&
  token1.pendingRaw===payload.wallet.token1.pendingRaw&&token1.availableRaw===payload.wallet.token1.freeRaw&&
  review.native.balanceWei===payload.wallet.native.balanceWei&&review.native.allocatedWei===payload.wallet.native.allocatedWei&&
  review.native.pendingWei===payload.wallet.native.pendingWei&&review.native.exitReserveWei===payload.wallet.native.exitReserveWei&&
  review.native.availableWei===payload.wallet.native.freeWei&&
  [...review.nftCustody.tokenIds].sort().join(',')===[...payload.wallet.nftTokenIds].sort().join(','));
}

/** Wallet inventory, frozen registered-profile reviews and explicit admission.
 * This adapter has no signer, publisher or schema initializer. `persistReviews`
 * defaults off; when enabled it permits snapshot/review persistence and the
 * separate admitSetup call. HTTP admission also requires worker readiness. */
export function createRangeKeeperLiveSetupRuntime(deps:{store:DeploymentStore;indexer:Pool;client:RobinhoodClient;
 walletAddress:unknown;buildId:string;rpcUrl:string;anvilBinary:string;transferStore:PositionManagerTransferIndexStore;
 persistReviews?:boolean;reviewPool?:Pool;
 onSimulationFailure?:(error:unknown)=>void;
 ensureWalletHistory?:(input:{source:PinnedCustodySource;profiles:readonly MarketProfile[]})=>Promise<
  {status:'available';completeThroughSource:true}|{status:'unavailable';reason:string}>}){
 const wallet=resolveLiveWalletAddress(deps.walletAddress);
 const persistencePool=deps.reviewPool??deps.indexer;
 const profiles=async()=>{
  const catalog=await deps.store.listMarketProfiles();
  const loaded=await Promise.all(catalog.filter(row=>row.draftAvailable)
   .map(row=>deps.store.paperSetupProfile(row.id)));
  return loaded.filter(row=>row!==null).map(row=>row.profile);
 };
 type WalletObservation={review:LiveWalletReview;nft:CompleteRangeKeeperNftEvidence|null;positions:RangeKeeperNftPosition[]};
 const readWalletObservation=async(pinned?:PaperOpenFrame['source'],selected?:MarketProfile):Promise<WalletObservation>=>{
  let completeNft:CompleteRangeKeeperNftEvidence|null=null,positionRows:RangeKeeperNftPosition[]=[];
  const source=pinned?{block:BigInt(pinned.block),hash:pinned.hash as Hex,timestamp:pinned.timestamp}:
   await rangeKeeperConfirmedSource(deps.client);
  const registered=await profiles();
  if(selected&&!registered.some(p=>contentHash(p)===contentHash(selected)))
   throw Error('registered_market_profile_changed_since_review');
  if(deps.ensureWalletHistory){
   const history=await deps.ensureWalletHistory({source,profiles:registered});
   if(history.status!=='available'||history.completeThroughSource!==true)
    throw Error(history.status==='unavailable'?history.reason:'wallet_history_incomplete_at_source');
  }
  const commitments=wallet?await readLiveWalletCommitments(deps.indexer,wallet,{source,verifySource:async anchor=>{
   const block=await deps.client.getBlock({blockNumber:BigInt(anchor.block)});
   if(block.hash.toLowerCase()!==anchor.hash.toLowerCase()||Number(block.timestamp)!==anchor.timestamp)
    throw Error('live_wallet_allocation_anchor_changed');
  }}):
   {status:'unavailable' as const,reasons:['server_operator_wallet_address_invalid']};
  const observed=await readLiveWalletAllocation({walletAddress:wallet,client:deps.client,source,
   profiles:registered,commitments,readCompleteNftCustody:async input=>{
    const evidence=await readCompletePositionManagerNftCustody({...input,
     targetStrategyId:'rangekeeper_v1',store:deps.transferStore,startBlock:0n});
    if(evidence.status!=='available'||!evidence.tokenIds)return evidence;
    if(evidence.tokenIds.length>100)return {...evidence,status:'unavailable',enumerationComplete:false,
     missing:['live_setup_owned_nft_read_bound_exceeded']};
    const managed=new Map<string,{manager:string;liquidity:string;tokensOwed0:string;tokensOwed1:string}>();
    for(const row of commitments.rows??[]){if(row.known!==true||!Array.isArray(row.nftCustody))continue;
     for(const nft of row.nftCustody)if(nft&&typeof nft==='object'&&typeof nft.tokenId==='string')managed.set(nft.tokenId,nft);
    }
    const retired:string[]=[];
    // Only a reconciled campaign ownership row may explain an active NFT.
    // Unallocated owned NFTs require the zero-liquidity/zero-owed proof.
    for(let offset=0;offset<evidence.tokenIds.length;offset+=8){
     const positions=await Promise.all(evidence.tokenIds.slice(offset,offset+8).map(tokenId=>
      deps.client.readContract({address:input.positionManager,abi:nonfungiblePositionManagerReadAbi,
       functionName:'positions',args:[BigInt(tokenId)],blockNumber:input.source.block})));
     for(let index=0;index<positions.length;index++){
      const tokenId=evidence.tokenIds[offset+index]!,p=positions[index]!,owned=managed.get(tokenId);
      positionRows.push({tokenId,owner:wallet!,liquidity:String(p[7]),tokensOwed0:String(p[10]),tokensOwed1:String(p[11])});
      if(owned){
       if(owned.manager.toLowerCase()!==input.positionManager.toLowerCase()||String(p[7])!==owned.liquidity||
        String(p[10])!==owned.tokensOwed0||String(p[11])!==owned.tokensOwed1)
        return {...evidence,status:'unavailable',enumerationComplete:false,missing:['live_setup_managed_nft_custody_changed']};
      }else if(p[7]!==0n||p[10]!==0n||p[11]!==0n)
       return {...evidence,status:'unavailable',enumerationComplete:false,missing:['live_setup_owned_nft_custody_unallocated']};
      else retired.push(tokenId);
     }
    }
    const complete={...evidence,retiredEmptyTokenIds:retired};
    completeNft=complete as unknown as CompleteRangeKeeperNftEvidence;
    return complete;
   }});
  if(!completeNft&&observed.nftCustody?.status==='available'&&observed.nftCustody.enumerationComplete&&
   observed.nftCustody.tokenIds?.length===0&&wallet){
   const evidence=await readCompletePositionManagerNftCustody({client:deps.client,operator:wallet,
    positionManager:observed.nftCustody.positionManager!,source,targetStrategyId:'rangekeeper_v1',
    store:deps.transferStore,startBlock:0n});
   if(evidence.status==='available'&&evidence.enumerationComplete&&evidence.tokenIds?.length===0)
    completeNft=evidence as unknown as CompleteRangeKeeperNftEvidence;
  }
  if(wallet&&commitments.rows?.some(row=>row.active&&row.known)){
   let unchanged=false;
   try{unchanged=liveWalletInventoryMatchesState(await readWalletState(deps.indexer,{chainId:4663,address:wallet}),{
    nonce:observed.native.nonce.status==='available'?observed.native.nonce.value:null,
    nativeBalanceWei:observed.native.balanceWei,tokens:observed.tokens,commitmentsHash:observed.commitmentsHash});}catch{}
   if(!unchanged){const reason='live_wallet_unattributed_inventory_change';
    return {review:{...observed,status:'unavailable',blockers:[...new Set([...observed.blockers,reason])],
     reasons:[...new Set([...observed.reasons,reason])]},nft:completeNft,positions:positionRows};}
  }
  return {review:observed,nft:completeNft,positions:positionRows};
 };
 const walletReview=async(pinned?:PaperOpenFrame['source'],selected?:MarketProfile):Promise<LiveWalletReview>=>(
  await readWalletObservation(pinned,selected)).review;
 const verifyPinnedSource=async(source:PaperOpenFrame['source'])=>{
  const [chainId,latest,block]=await Promise.all([deps.client.getChainId(),deps.client.getBlock(),
   deps.client.getBlock({blockNumber:BigInt(source.block)})]);
  if(chainId!==4663||latest.number<BigInt(source.block)+64n||!block.hash||
   block.hash.toLowerCase()!==source.hash.toLowerCase()||Number(block.timestamp)!==source.timestamp)
   throw Error('live_setup_pinned_source_changed');
 };
 /** Revalidate a server-frozen review at its exact source without refreshing
  * wallet generation or changing the frozen payload. */
 const revalidatePinnedReview=async(payload:RangeKeeperLiveReviewPayload):Promise<RangeKeeperLiveReviewPayload|null>=>{
  try{
   if(!wallet||payload.wallet.address.toLowerCase()!==wallet.toLowerCase()||payload.wallet.id!=='operator-1'||
    payload.binding.buildId!==deps.buildId)return null;
   const registered=await deps.store.paperSetupProfile(payload.profileId);
   if(!registered||registered.id!==payload.profileId||contentHash(registered.profile)!==registered.profileHash||
    registered.profileHash!==payload.profileHash)return null;
   const parsedProfile=marketProfileSchema.safeParse(registered.profile);
   if(!parsedProfile.success)return null;
   const profile=parsedProfile.data,allProfiles=await profiles();
   if(!allProfiles.some(candidate=>contentHash(candidate)===registered.profileHash))return null;
   const source={block:BigInt(payload.source.block),hash:payload.source.hash as Hex,timestamp:payload.source.timestamp};
   await verifyPinnedSource(payload.source);
   const config=parseRangeKeeperConfig(payload.policy.config);
   if(rangeKeeperConfigHash(config).slice(2)!==payload.policy.configHash||!config.operator||
    config.operator.toLowerCase()!==wallet.toLowerCase()||contentHash(config.pool)!==contentHash(profile.pool))return null;
   const candidate=payload.candidate as {sourceBlock?:unknown;sourceHash?:unknown};
   const costs=payload.costs as {source?:unknown};
   if(candidate.sourceBlock!==payload.source.block||typeof candidate.sourceHash!=='string'||
    candidate.sourceHash.toLowerCase()!==payload.source.hash.toLowerCase()||
    liveSetupEvidenceHash(payload.candidate)!==payload.binding.candidateHash||
    contentHash(payload.costs)!==payload.binding.costsHash||contentHash(payload.requirements)!==payload.binding.requirementsHash||
    contentHash({token0Raw:payload.requirements.token0Raw,token1Raw:payload.requirements.token1Raw,
     nativeWei:payload.requirements.nativeWei})!==payload.binding.finalAllocationHash||
    !costs.source||contentHash(costs.source)!==contentHash(payload.source))return null;
   const walletBytecode=await deps.client.getBytecode({address:wallet,blockNumber:source.block});
   let walletCode:RangeKeeperConfig['walletCode'];
   if(!walletBytecode||walletBytecode==='0x')walletCode={kind:'eoa'};
   else{
    if(!/^0xef0100[0-9a-fA-F]{40}$/.test(walletBytecode))return null;
    const delegate=getAddress(`0x${walletBytecode.slice(8)}`),delegateCode=await deps.client.getBytecode({address:delegate,blockNumber:source.block});
    if(!delegateCode||delegateCode==='0x')return null;
    walletCode={kind:'eip7702',delegate,delegateCodeHash:keccak256(delegateCode)};
   }
   if(contentHash(walletCode)!==contentHash(config.walletCode))return null;
   await verifyRangeKeeperWalletCode(deps.client,source,wallet,{walletCode});
   const observation=await readWalletObservation(payload.source,profile),review=observation.review;
   if(!rangeKeeperLiveWalletReviewMatchesPayload(review,payload,profile))return null;
   const nonce=review.native.nonce;
   if(nonce.status!=='available')return null;
   const persisted=await readWalletState(deps.indexer,{chainId:4663,address:wallet});
   if(!liveWalletInventoryMatchesState(persisted,{nonce:nonce.value,nativeBalanceWei:review.native.balanceWei,
    tokens:review.tokens,commitmentsHash:review.commitmentsHash})||!persisted.source||
    persisted.source.block!==payload.source.block||persisted.source.hash.toLowerCase()!==payload.source.hash.toLowerCase()||
    persisted.source.timestamp!==payload.source.timestamp)return null;
   const references=payload.references as {price0:string;price1:string;nativePrice:string;semanticProofHash:string};
   if(!(await verifyRangeKeeperLiveSetupPinnedReferences({client:deps.client,profile,source:payload.source,
    profileHash:payload.profileHash,references})))return null;
   return payload;
  }catch{return null;}
 };
 const admitSetup=async(input:unknown):Promise<RangeKeeperLiveReviewAdmissionResult>=>{
  if(!deps.persistReviews)return {status:'unavailable',missing:['live_review_admission_disabled'],
   actionAvailable:false,executionEligible:false};
  if(!wallet)return {status:'unavailable',missing:['server_operator_wallet_address_invalid'],
   actionAvailable:false,executionEligible:false};
  const adapter=createRangeKeeperLiveReviewStoreAdapter(persistencePool,wallet);
  return admitRangeKeeperLiveSetup(input,{wallet,buildId:deps.buildId,...adapter,
   revalidatePinned:revalidatePinnedReview,verifyCanonical:verifyPinnedSource});
 };
 const setupPreflight=async(input:RangeKeeperLiveSetupPreflightInput)=>{
  let frame:PaperOpenFrame|null=null,profile:MarketProfile|null=null,review:LiveWalletReview|null=null;
  let walletObservation:Awaited<ReturnType<typeof readWalletObservation>>|null=null;
  let walletCode:RangeKeeperConfig['walletCode']|null=null;
  const liveIdentity:LiveWalletIdentity|null=wallet?{chainId:4663,address:wallet}:null;
  const liveReviewRuntime=liveIdentity?createRangeKeeperLiveReviewRuntime({pool:persistencePool,wallet:liveIdentity,
   buildId:deps.buildId,now:Date.now,
   observeWallet:async():Promise<RangeKeeperSnapshotObservation>=>{
    const source=frame?.source;if(!source||!profile)throw Error('live_setup_frame_not_ready');
    const currentObservation=await readWalletObservation(source,profile);walletObservation=currentObservation;
    const observed=currentObservation.review,nonce=observed.native.nonce,pending=observed.native.pendingNonce;
    const complete=observed.status==='available'&&nonce.status==='available'&&pending.status==='available'&&
     observed.source.confirmed&&observed.source.hash!==null&&observed.source.timestamp!==null&&
     observed.tokens.every(t=>t.balanceRaw!==null)&&observed.native.balanceWei!==null&&currentObservation.nft!==null&&
     observed.nftCustody?.status==='available'&&observed.nftCustody.enumerationComplete;
    const snapshot:LiveWalletSnapshotInput={...liveIdentity,source:{block:source.block,hash:source.hash,timestamp:source.timestamp},
     nonce:nonce.status==='available'?nonce.value:'0',pendingNonce:pending.status==='available'?pending.value:'0',
     nativeBalanceWei:observed.native.balanceWei??'0',tokens:observed.tokens.map(t=>({address:t.address,balanceRaw:t.balanceRaw??'0'})),
     commitmentsHash:observed.commitmentsHash,status:observed.status==='available'?'available':'blocked'};
    const retired=Array.isArray((observed.nftCustody as unknown as {retiredEmptyTokenIds?:unknown})?.retiredEmptyTokenIds)?
     (observed.nftCustody as unknown as {retiredEmptyTokenIds:string[]}).retiredEmptyTokenIds:[];
    const evidence=currentObservation.nft;
    return {snapshot,complete,missing:complete?[]:[...observed.blockers,...(evidence?[]:['complete_nft_custody_unavailable'])],
     nft:{positionManager:evidence?.positionManager??'',completeEvidence:evidence as CompleteRangeKeeperNftEvidence,
      positions:currentObservation.positions,retiredEmptyTokenIds:retired}};
   },
   verifyCanonical:async source=>{
    const [chainId,latest,block]=await Promise.all([deps.client.getChainId(),deps.client.getBlock(),
     deps.client.getBlock({blockNumber:BigInt(source.block)})]);
    if(chainId!==4663||latest.number<BigInt(source.block)+64n||!block.hash||
     block.hash.toLowerCase()!==source.hash.toLowerCase()||Number(block.timestamp)!==source.timestamp)
     throw Error('live_setup_snapshot_source_not_canonical');
   },
  }):null;
  type SnapshotRefresh=Awaited<ReturnType<NonNullable<typeof liveReviewRuntime>['refreshSnapshot']>>;
  const refreshResult:{value:SnapshotRefresh|null}={value:null};
  const preflight=await buildRangeKeeperLiveSetupPreflight(input,{buildId:deps.buildId,
   serverWallet:async()=>{
    if(!wallet)return null;
    const source=await rangeKeeperConfirmedSource(deps.client);
    const code=await deps.client.getBytecode({address:wallet,blockNumber:source.block});
    if(!code||code==='0x')walletCode={kind:'eoa'};
    else{
     if(!/^0xef0100[0-9a-fA-F]{40}$/.test(code))throw Error('server_wallet_code_unsupported');
     const delegate=getAddress(`0x${code.slice(8)}`);
     const bytecode=await deps.client.getBytecode({address:delegate,blockNumber:source.block});
     if(!bytecode||bytecode==='0x')throw Error('server_wallet_delegate_code_unavailable');
     walletCode={kind:'eip7702',delegate,delegateCodeHash:keccak256(bytecode)};
    }
    await verifyRangeKeeperWalletCode(deps.client,source,wallet,{walletCode});
    return {id:'operator-1',address:wallet,walletCode};
   },
   loadProfile:id=>deps.store.paperSetupProfile(id),
   readFrame:async selected=>{profile=selected;frame=await readCanonicalPaperOpenFrame(deps.client,selected);return frame;},
   readWalletSnapshot:async selected=>{
    if(!frame)throw Error('live_setup_pinned_frame_unavailable');
    profile=selected;
    let currentObservation:Awaited<ReturnType<typeof readWalletObservation>>;
    if(deps.persistReviews&&liveReviewRuntime){
     refreshResult.value=await liveReviewRuntime.refreshSnapshot();
     currentObservation=walletObservation??await readWalletObservation(frame.source,selected);
    }else currentObservation=await readWalletObservation(frame.source,selected);
    walletObservation=currentObservation;review=currentObservation.review;
    const currentReview=currentObservation.review,nonce=currentReview.native.nonce;
    return {...currentReview.allocationSnapshot,status:currentReview.status,blockers:currentReview.blockers,
     source:frame.source,canonical:currentReview.source.confirmed,nonce:nonce.status==='available'?nonce.value:null,
     nftCustody:currentReview.nftCustody??{status:'unavailable' as const,enumerationComplete:false,tokenIds:null}};
   },
   readGasPrice:async()=>{const [latest,price]=await Promise.all([deps.client.getBlock(),deps.client.getGasPrice()]);
    if(!latest.baseFeePerGas)throw Error('fresh_gas_price_unavailable');
    return {baseFeePerGasWei:latest.baseFeePerGas,marketGasPriceWei:price};},
   verifyCanonical:async(chainId,source)=>{
    const [actualChain,latest,pinned]=await Promise.all([deps.client.getChainId(),deps.client.getBlock(),
     deps.client.getBlock({blockNumber:BigInt(source.block)})]);
    if(actualChain!==chainId||latest.number<BigInt(source.block)+64n||
     pinned.hash.toLowerCase()!==source.hash.toLowerCase()||Number(pinned.timestamp)!==source.timestamp)
     throw Error('live_setup_canonical_source_changed');
    if(wallet&&walletCode)await verifyRangeKeeperWalletCode(deps.client,{block:BigInt(source.block),
     hash:source.hash as Hex,timestamp:source.timestamp},wallet,{walletCode});
    if(review&&wallet){
     const commitments=await readLiveWalletCommitments(deps.indexer,wallet,{source:{block:BigInt(source.block),hash:source.hash as Hex,timestamp:source.timestamp},
      verifySource:async anchor=>{const header=await deps.client.getBlock({blockNumber:BigInt(anchor.block)});
       if(header.hash.toLowerCase()!==anchor.hash.toLowerCase()||Number(header.timestamp)!==anchor.timestamp)throw Error('allocation_anchor_changed');}});
     const allocation=allocateLiveWalletBalances({tokens:review.tokens.map(t=>({...t,balanceRaw:t.balanceRaw})),
      nativeBalanceWei:review.native.balanceWei,commitments:commitments.rows??[],commitmentsStatus:commitments.status});
     if(commitments.status!=='available'||allocation.commitmentsHash!==review.commitmentsHash)
      throw Error('live_setup_wallet_commitments_changed');
    }
   },
   quote:async(token,amount)=>{
    if(!frame||!profile||frame.price0===null||frame.price1===null)throw Error('live_setup_quote_source_unavailable');
    return new RangeKeeperChain(deps.client,profile.pool).quote({block:BigInt(frame.source.block),
     hash:frame.source.hash as Hex,timestamp:frame.source.timestamp},token,amount,frame.price0,frame.price1);
   },
   simulateCandidate:async request=>{
    try{return await simulateLiveSetupCandidate(request,{client:deps.client,rpcUrl:deps.rpcUrl,
     anvilBinary:deps.anvilBinary});}
    catch(error){try{deps.onSimulationFailure?.(error);}catch{}throw error;}
   },
  });
  if(!deps.persistReviews)return preflight;
  let reviewPersistence:{status:'persisted'|'unavailable'|'disabled';reviewId:string|null;reviewHash:string|null;
   expiresAt:string|null;missing:readonly string[]}={status:'unavailable',reviewId:null,reviewHash:null,expiresAt:null,
    missing:refreshResult.value?.missing??['live_setup_snapshot_persistence_unavailable']};
  if(!liveReviewRuntime)reviewPersistence={...reviewPersistence,missing:['server_operator_wallet_address_invalid']};
  else if(preflight.status==='indicative'&&refreshResult.value?.status==='persisted'){
   const report=preflight as typeof preflight&{profileHash:string;source:PaperOpenFrame['source'];
    references:{price0:string;price1:string;nativePrice:string;semanticProofHash:string}};
   if(!profile||!(await verifyRangeKeeperLiveSetupPinnedReferences({client:deps.client,profile,source:report.source,
    profileHash:report.profileHash,references:report.references})))
    return {...preflight,reviewPersistence:{...reviewPersistence,missing:['review_reference_semantics_changed']}};
   const reviewId=randomUUID(),result=await liveReviewRuntime.persistReview(reviewId,preflight);
   reviewPersistence=result.status==='review_recorded'?{status:'persisted',reviewId:result.reviewId,
    reviewHash:result.reviewHash,expiresAt:result.expiresAt,missing:[]}:
    {status:'unavailable',reviewId:null,reviewHash:null,expiresAt:null,
     missing:result.status==='unavailable'?result.missing:['live_setup_review_persistence_unavailable']};
  }
  return {...preflight,reviewPersistence};
 };
 return {walletReview,setupPreflight,revalidatePinnedReview,admitSetup};
}
