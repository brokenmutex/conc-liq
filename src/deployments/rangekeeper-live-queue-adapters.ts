import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createPublicClient,getAddress,http,type Hex} from 'viem';
import {robinhoodChain} from '../constants.js';
import {assertOwnedPaperFork,type PaperFork} from '../paper/fork.js';
import type {RobinhoodClient} from '../client.js';
import {nonfungiblePositionManagerReadAbi} from '../nft/abi.js';
import type {PositionManagerTransferIndexStore} from '../nft/position-manager-transfer-index.js';
import {scanPositionManagerTransferHistory} from '../nft/position-manager-transfer-index.js';
import {liveSetupEvidenceHash} from './rangekeeper-live-setup-simulation.js';
import {RangeKeeperChain,type RangeKeeperSource} from '../strategy/rangekeeper/chain.js';
import {parseRangeKeeperJson,rangeKeeperJson,type RangeKeeperSnapshot} from '../strategy/rangekeeper/live-domain.js';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import {readLiveCustodySnapshot} from './live-custody-snapshot.js';
import {readCompletePositionManagerNftCustody} from './live-transfer-nft-enumeration.js';
import {readRangeKeeperLiveCampaign} from './rangekeeper-live-campaign-store.js';
import {authorizeRangeKeeperLiveStage,prepareRangeKeeperLiveStageAuthorization,isRangeKeeperAwaitingReplan,isRangeKeeperRetainedExit,
 type RangeKeeperStageReferences, type RangeKeeperStageWalletBefore} from './rangekeeper-live-campaign.js';
import {simulateRangeKeeperLiveStage,type RangeKeeperLiveStageProof} from './rangekeeper-live-stage-proof.js';
import {mergeAllowanceTargetsBySpender,readRangeKeeperLiveWallet} from './rangekeeper-live-wallet-chain.js';
import {readWalletState,readCommitments,withLiveWalletTransaction} from './live-wallet-store.js';
import {releaseLiveWalletAllocation} from './live-wallet-store.js';
import {liveWalletCommitmentFingerprint,liveWalletInventoryMatchesState} from './live-wallet-commitment-projection.js';
import {readLiveWalletCommitments} from './live-wallet-commitments.js';
import {reconcileRangeKeeperWalletReceipt,type RangeKeeperWalletCampaignAllocation,
 type RangeKeeperWholeWalletSnapshot} from './rangekeeper-live-wallet-reconcile.js';
import {LiveWalletQueue,readLiveWalletLane,type LiveJob,type LiveOutbox,type LiveWalletQueueAdapters,type VerifiedQueueReceipt} from './live-wallet-queue.js';
import type {LiveWalletIdentity} from './live-wallet-store.js';
import {deriveRangeKeeperCampaignStageSnapshot,deriveRangeKeeperStage} from './rangekeeper-live-campaign.js';
import {nextRangeKeeperStage} from '../strategy/rangekeeper/live-stage.js';
import {markRangeKeeper} from '../strategy/rangekeeper/live-mark.js';
import {encodeRangeKeeperTx} from '../strategy/rangekeeper/calldata.js';
import {rangeKeeperConfigHash,initialRangeKeeperState} from '../strategy/rangekeeper/config.js';
import type {RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import {initializeRangeKeeperLiveCampaignInTransaction,appendRangeKeeperLiveCampaignEventInTransaction,
 rangeKeeperLiveInitialCapitalValueX18} from './rangekeeper-live-campaign-store.js';
import {createRangeKeeperLiveWalletWorker,RangeKeeperLiveStaleManagementReviewError,type RangeKeeperLiveWorkerAdapters,type RangeKeeperLiveWorkerOptions,
 type RangeKeeperManagementSettlement,type RangeKeeperNextStage} from './rangekeeper-live-wallet-worker.js';
import {classifyRangeKeeperStageError,settleRangeKeeperLiveStageError} from './rangekeeper-live-management-recovery.js';
import {RangeKeeperMintUnavailableError,RangeKeeperStaleCandidateError} from '../strategy/rangekeeper/live-stage.js';
import {createRangeKeeperLivePreparedIntentVerifier,readRangeKeeperLiveStageReferences,verifyRangeKeeperLiveStageReferences} from './rangekeeper-live-references.js';
import {contentHash} from './contracts.js';
import {applyRangeKeeperLiveReceiptEffectInTransaction} from './rangekeeper-live-campaign-effects.js';
import {deriveRangeKeeperLiveManagementTransition,deriveRangeKeeperLiveClosedState,
 type RangeKeeperLiveManagementReviewPayload} from './rangekeeper-live-campaign.js';
import {allowancePolicyFromUses,buildWalletAllowanceScope,readRangeKeeperWalletAllowanceUses} from './live-wallet-allowance-scope.js';
import {RANGEKEEPER_ALLOWANCE_POLICY,assertWalletAllowancesInPolicy,walletAllowanceCaps,type WalletAllowanceScope} from '../strategy/rangekeeper/allowance-policy.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const uint=(v:unknown)=>typeof v==='bigint'?v:BigInt(String(v));
/** A receipt may be attributed without a reference valuation only after this long; sooner, a reference outage is
 * retried so the cost evidence that later stages require is not lost to a short outage. */
export const RANGEKEEPER_RECEIPT_VALUATION_RETRY_SECONDS=600;
/** True when a failed reference read at a receipt should abort attribution (roll back and retry) instead of
 * recording the receipt unvalued. Transport/availability failures always retry; other failures retry while the
 * receipt is recent. The signed, mined transaction stays unresolved, so the wallet lane waits for references. */
export function shouldRetryReceiptValuation(error:unknown,receiptTimestampSeconds:number,nowMs=Date.now()):boolean{
 if(isTransientReferenceReadError(error))return true;
 return nowMs/1000-receiptTimestampSeconds<RANGEKEEPER_RECEIPT_VALUATION_RETRY_SECONDS;
}
/** An RPC transport/availability failure (for example HTTP 503) is retried, never recorded as an unvalued receipt. */
export function isTransientReferenceReadError(error:unknown):boolean{
 let current:unknown=error;
 for(let depth=0;depth<6&&current&&typeof current==='object';depth++){
  const e=current as {name?:unknown;message?:unknown;shortMessage?:unknown;details?:unknown;status?:unknown;cause?:unknown};
  if(typeof e.status==='number'&&e.status>=500)return true;
  if(['HttpRequestError','TimeoutError','RpcRequestError','InternalRpcError','FetchError','AbortError'].includes(String(e.name)))return true;
  if([e.message,e.shortMessage,e.details].some(v=>typeof v==='string'&&/\b(50[0-4])\b|http request failed|fetch failed|timed? ?out|econn|etimedout|enotfound|socket hang up|network/i.test(v)))return true;
  current=e.cause;
 }
 return false;
}
type LiveCampaign=Awaited<ReturnType<typeof readRangeKeeperLiveCampaign>>;
export const rangeKeeperLiveCapabilityCacheKey=(jobId:string,stage:string,intent:unknown,plan:unknown)=>
 `${jobId}:${stage}:${liveSetupEvidenceHash({intent,plan})}`;

/** Decode bigint markers before comparing terminal effect sources. */
export function readRangeKeeperLiveTerminalEffect(effects:unknown,source:{block:string|bigint;hash:string;timestamp:number}){
 try{
  const evidence=parseRangeKeeperJson<any>(effects),snapshot=evidence?.afterPool,effectSource=evidence?.source;
  const sameSource=(candidate:any)=>candidate&&String(candidate.block)===String(source.block)&&
   same(candidate.hash,source.hash)&&Number(candidate.timestamp)===Number(source.timestamp);
  if(!snapshot||!sameSource(effectSource)||!sameSource(snapshot.source))return null;
  const referenceValuation=sameSource(evidence.referenceValuation?.source)?evidence.referenceValuation:null;
  const positionFeeEvidence=evidence.positionFeeEvidence?.kind==='rangekeeper_live_position_fee_evidence_v1'&&
   sameSource(evidence.positionFeeEvidence.source)?evidence.positionFeeEvidence:null;
  return {snapshot:snapshot as RangeKeeperSnapshot,referenceValuation,positionFeeEvidence};
 }catch{return null;}
}

/** A canonical post-withdraw snapshot may still enumerate the now-empty NFT.
 * Collapse it only for the terminal campaign projection, after checking the
 * cleanup source and the campaign's recorded retired-token identity. */
export function buildRangeKeeperLiveTerminalSnapshot(campaign:LiveCampaign,snapshot:RangeKeeperSnapshot,
 cleanup:{verified:boolean;custodyState:string;source:{block:string|bigint;hash:string;timestamp:number}}){
 assert(cleanup.verified===true&&cleanup.custodyState==='closed_empty','Terminal snapshot requires verified empty-custody cleanup');
 assert(String(snapshot.source.block)===String(cleanup.source.block)&&same(snapshot.source.hash,cleanup.source.hash)&&
  Number(snapshot.source.timestamp)===Number(cleanup.source.timestamp),'Terminal pool snapshot differs from cleanup source');
 let terminalSource=snapshot;
 if(snapshot.position){
  const position=snapshot.position;
  assert(position.owner.toLowerCase()===campaign.wallet.toLowerCase(),'Terminal NFT owner differs from campaign wallet');
  assert(position.token0.toLowerCase()===campaign.config.pool.token0.toLowerCase()&&
   position.token1.toLowerCase()===campaign.config.pool.token1.toLowerCase()&&position.fee===campaign.config.pool.fee,
   'Terminal NFT profile differs from campaign pool');
  assert(campaign.state?.retiredTokenIds.includes(String(position.tokenId)),
   'Terminal NFT is not recorded as retired by this campaign');
  assert(position.liquidity===0n&&position.tokensOwed0===0n&&position.tokensOwed1===0n,
   'Terminal NFT still has liquidity or owed tokens');
  terminalSource={...snapshot,position:null,nftCount:0n};
 }
 const scoped=deriveRangeKeeperCampaignStageSnapshot(campaign,terminalSource);
 const nativeCap=campaign.allocation.nativeSpendWei+campaign.allocation.exitReserveWei;
 scoped.nativeWei=snapshot.nativeWei<nativeCap?snapshot.nativeWei:nativeCap;
 return {...scoped,position:null,nftCount:0n};
}

export function buildRangeKeeperLiveEntryState(campaign:LiveCampaign,snapshot:RangeKeeperSnapshot):RangeKeeperLiveState{
 const candidateRaw=(campaign.reviewPayload as any)?.candidate;
 assert(candidateRaw&&candidateRaw.range&&Number.isSafeInteger(candidateRaw.expiresAt),'Frozen setup candidate is incomplete');
 const candidate={...candidateRaw,sourceBlock:BigInt(candidateRaw.sourceBlock),amount0Desired:BigInt(candidateRaw.amount0Desired),
  amount1Desired:BigInt(candidateRaw.amount1Desired),amount0Min:BigInt(candidateRaw.amount0Min),amount1Min:BigInt(candidateRaw.amount1Min),
  liquidity:BigInt(candidateRaw.liquidity),deployedValue:BigInt(candidateRaw.deployedValue),
  swap:candidateRaw.swap?{...candidateRaw.swap,amountIn:BigInt(candidateRaw.swap.amountIn),quotedOut:BigInt(candidateRaw.swap.quotedOut),
   minOut:BigInt(candidateRaw.swap.minOut),priceAfter:BigInt(candidateRaw.swap.priceAfter),feeValue:BigInt(candidateRaw.swap.feeValue),
   shortfallValue:BigInt(candidateRaw.swap.shortfallValue)}:null};
 const payload=campaign.reviewPayload as any,token0=campaign.allocation.liquidByTokenAddress[campaign.config.pool.token0.toLowerCase()],
  token1=campaign.allocation.liquidByTokenAddress[campaign.config.pool.token1.toLowerCase()],buildId=String(payload.binding.buildId),
  initialValue=BigInt(payload.requirements.strategyAllocationValueUsdX18),native=campaign.allocation.nativeSpendWei+campaign.allocation.exitReserveWei;
 assert(token0!==undefined&&token1!==undefined&&initialValue>0n,'Reserved setup allocation is incomplete');
 const source=snapshot.source.timestamp,state:RangeKeeperLiveState={version:1,id:campaign.id,operator:campaign.wallet,
  configHash:rangeKeeperConfigHash(campaign.config),buildId,phase:'entry',desired:'running',haltReason:null,exitMode:null,createdAt:source,
  expiresAt:campaign.config.campaignScope.maxDurationSeconds===0?Number.MAX_SAFE_INTEGER:source+campaign.config.campaignScope.maxDurationSeconds,
  economicActions:0,recenters:0,policy:initialRangeKeeperState(campaign.config,buildId),last:snapshot,activeTokenId:null,
  retiredTokenIds:[],legacyNftCount:BigInt(snapshot.nftCount),reserve0:0n,reserve1:0n,reserveNativeWei:0n,
  initial0:token0,initial1:token1,initialNativeWei:native,initialStrategyValue:initialValue,candidate,swapDone:false,
  swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,
  collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],highWaterValue:initialValue,activeSeconds:0,
  outsideSeconds:0,lastMarkTimestamp:source,lastReason:'live_open_reserved',closedAt:null};
 return state;
}
export function configuredAllowanceTargets(entries:readonly {token:string;spender:string}[],registeredTokens:readonly string[]){
 const tokenScope=new Set(registeredTokens.map(token=>getAddress(token).toLowerCase()));
 const bySpender=new Map<string,{address:`0x${string}`;tokens:Set<string>}>();
 for(const entry of entries){
  assert(entry&&typeof entry.token==='string'&&typeof entry.spender==='string');
  const token=getAddress(entry.token),spender=getAddress(entry.spender);
  assert(tokenScope.has(token.toLowerCase()),`Configured allowance token is outside registered wallet token scope: ${token.toLowerCase()}`);
  const key=spender.toLowerCase(),prior=bySpender.get(key);
  if(prior)prior.tokens.add(token.toLowerCase());else bySpender.set(key,{address:spender,tokens:new Set([token.toLowerCase()])});
 }
 return [...bySpender.values()].sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
  .map(item=>({address:item.address,label:`zero_allowance:${[...item.tokens].sort().join(',')}`}));
}
export function assertCleanupAllowanceIdentityCoverage(expected:readonly {token:string;spender:string}[],
 observed:readonly {token:string;spender:string}[]):void{
 assert(expected.length>0&&expected.length<=64&&observed.length>0&&observed.length<=64,'Allowance identity scope is empty or out of bounds');
 const keys=(rows:readonly {token:string;spender:string}[])=>{
  const result=rows.map(row=>`${getAddress(row.token).toLowerCase()}:${getAddress(row.spender).toLowerCase()}`);
  assert.equal(new Set(result).size,result.length,'Allowance identity scope contains duplicates');return new Set(result);
 };
 const expectedKeys=keys(expected),observedKeys=keys(observed);
 for(const key of expectedKeys)assert(observedKeys.has(key),`Cleanup snapshot omitted a persisted allowance identity: ${key}`);
}
/** Wallet allowance scope for a cleanup proof. `closingCampaignId` removes a closing campaign from the pairs still in use:
 * whatever it leaves non-zero must then be a pair a sibling campaign still uses. */
export async function readRangeKeeperAllowanceScope(db:Pick<PoolClient,'query'>,wallet:string,profiles:readonly MarketProfile[],
 closingCampaignId?:string):Promise<WalletAllowanceScope>{
 return buildWalletAllowanceScope(await readRangeKeeperWalletAllowanceUses(db,wallet),profiles,closingCampaignId);
}
/** Terminal allowance invariant: every observed allowance is zero or within the cap of a pair an active campaign uses. The
 * returned allowed-pair caps are persisted with the cleanup proof so the queue re-checks them independently. */
export function rangeKeeperAllowanceCleanupProof(allowances:readonly {token:string;spender:string;amount:string}[],scope:WalletAllowanceScope){
 assertWalletAllowancesInPolicy(allowances.map(a=>({token:a.token,spender:a.spender,amount:BigInt(a.amount)})),scope);
 return {kind:RANGEKEEPER_ALLOWANCE_POLICY,caps:walletAllowanceCaps(scope)};
}
async function walletAllowanceTargets(client:PoolClient,wallet:string,profiles:readonly MarketProfile[]){
 const rows=await client.query<any>(`SELECT r.config FROM deployment_campaigns c
  JOIN deployment_revisions r ON r.campaign_id=c.id AND r.revision=c.current_revision
  WHERE c.mode='live' AND lower(c.wallet)=$1 AND c.lifecycle NOT IN ('draft','closed')
  AND r.strategy_id='rangekeeper_v1' ORDER BY c.id LIMIT 101`,[wallet.toLowerCase()]);
 assert(rows.rows.length<=100,'Registered allowance scope bound exceeded');
 const entries=rows.rows.flatMap(row=>Array.isArray(row.config?.zeroAllowances)?row.config.zeroAllowances:[]);
 const registeredTokens=profiles.flatMap(profile=>[profile.pool.token0,profile.pool.token1]);
 return configuredAllowanceTargets(entries,registeredTokens);
}
async function assertExecutionWallet(input:{db:PoolClient;pool:Pool;client:RobinhoodClient;wallet:string;source:RangeKeeperSource;
 profiles:readonly MarketProfile[];transferStore:PositionManagerTransferIndexStore;allowanceTargets:readonly {address:`0x${string}`;label:string}[];
 allowanceScope:WalletAllowanceScope}){
 const identity:LiveWalletIdentity={chainId:4663,address:input.wallet},state=await readWalletState(input.db,identity),
  commitments=await readCommitments(input.db,identity);
 assert(state.status==='available'&&state.source&&state.snapshotHash&&state.commitmentsHash,'Persisted wallet is not available');
 assert(state.source.block===String(input.source.block)&&same(state.source.hash,input.source.hash)&&state.source.timestamp===input.source.timestamp,
  'Canonical source differs from the persisted wallet generation');
 assert(state.commitmentsHash===liveWalletCommitmentFingerprint(commitments),'Persisted commitment fingerprint changed');
 const commitmentReview=await readLiveWalletCommitments(input.pool,input.wallet,{source:input.source,verifySource:async anchor=>{
  const b=await input.client.getBlock({blockNumber:BigInt(anchor.block)});
  assert(b.hash&&same(b.hash,anchor.hash)&&Number(b.timestamp)===anchor.timestamp,'Allocation source is no longer canonical');
 }});
 assert(commitmentReview.status==='available',`Wallet ownership ledger unavailable: ${commitmentReview.status==='unavailable'?commitmentReview.reasons.join(','):'unknown'}`);
 const observed=await readRangeKeeperLiveWalletEvidenceAtSource({client:input.client,wallet:input.wallet,source:input.source,
  profiles:input.profiles,transferStore:input.transferStore,allowanceTargets:input.allowanceTargets});
 const balances=Object.entries(observed.tokens).map(([address,balanceRaw])=>({address,balanceRaw:String(balanceRaw)}));
 assert(liveWalletInventoryMatchesState(state,{nonce:String(observed.nonce),nativeBalanceWei:String(observed.nativeWei),
  tokens:balances,commitmentsHash:state.commitmentsHash}),'Observed whole-wallet inventory differs from persisted source');
 const custody=commitments.nftCustody.filter(n=>same(n.manager,input.profiles[0]!.pool.positionManager));
 const ids=custody.filter(n=>n.status==='active'||n.status==='retired_empty').map(n=>n.tokenId).sort();
 assert(new Set(ids).size===ids.length&&JSON.stringify(ids)===JSON.stringify([...observed.nftTokenIds].sort()),
  'Indexed owner set differs from persisted active/retired custody');
 for(let offset=0;offset<observed.nftTokenIds.length;offset+=8){
  const subset=observed.nftTokenIds.slice(offset,offset+8);
  const positions=await Promise.all(subset.map(id=>input.client.readContract({address:getAddress(input.profiles[0]!.pool.positionManager),
   abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[BigInt(id)],blockNumber:input.source.block})));
  for(let i=0;i<subset.length;i++){
   const id=subset[i]!,p=positions[i]!,entry=custody.find(n=>n.tokenId===id);
   assert(entry,'NFT custody row missing');
   if(entry.status==='retired_empty')assert(p[7]===0n&&p[10]===0n&&p[11]===0n,'Retired NFT position is nonempty');
   else{
    assert(entry.status==='active'&&input.profiles.some(profile=>same(profile.pool.token0,p[2])&&same(profile.pool.token1,p[3])&&profile.pool.fee===p[4]),
     'Active NFT does not belong to a registered pool');
    assert(String(p[7])===entry.liquidity&&String(p[10])===entry.tokensOwed0&&String(p[11])===entry.tokensOwed1,
     'Active NFT position differs from custody ledger');
   }
  }
 }
 // Every allowance must equal the result of the last canonical stage receipt.
 // Any pair introduced by a later registered config must still be zero.
 const prior=(await input.db.query<any>(`SELECT effect_evidence_json FROM deployment_live_stage_outbox
  WHERE chain_id=4663 AND wallet=$1 AND status='confirmed' ORDER BY updated_at DESC,job_id DESC,stage DESC LIMIT 1`,[input.wallet.toLowerCase()])).rows[0];
 const expected=new Map<string,bigint>();
 if(prior?.effect_evidence_json?.afterWallet?.allowances){
  for(const a of prior.effect_evidence_json.afterWallet.allowances){
   const token=getAddress(a.token).toLowerCase(),spender=getAddress(a.spender).toLowerCase();
   expected.set(`${token}:${spender}`,BigInt(String(a.amount)));
  }
 }
 for(const a of observed.allowances){
  const key=`${a.token.toLowerCase()}:${a.spender.toLowerCase()}`,amount=expected.get(key)??0n;
  assert.equal(a.amount,amount,'Observed allowance differs from canonical stage receipt history');expected.delete(key);
 }
 assert.equal(expected.size,0,'Persisted allowance receipt scope was omitted by wallet reader');
 // persistent_capped_v1: whatever the receipts explain must also be in policy (registered spender, a pair an active
 // campaign uses, within its cap); anything else is a wallet-integrity block, exactly like an unexplained change.
 assertWalletAllowancesInPolicy(observed.allowances,input.allowanceScope);
 return {state,commitments,observed};
}
function wholeWallet(value:any):RangeKeeperWholeWalletSnapshot{
 assert(value&&value.source&&Number.isSafeInteger(Number(value.nonce))&&Number.isSafeInteger(Number(value.pendingNonce)));
 const tokens:Record<string,bigint>={};for(const [address,amount] of Object.entries(value.tokens??{}))tokens[getAddress(address).toLowerCase()]=uint(amount);
 return {operator:getAddress(value.operator),source:{block:BigInt(value.source.block),hash:value.source.hash,timestamp:Number(value.source.timestamp)},
  nonce:Number(value.nonce),nativeWei:uint(value.nativeWei),tokens,nftTokenIds:(value.nftTokenIds??[]).map(String),
  allowances:(value.allowances??[]).map((a:any)=>({token:getAddress(a.token),spender:getAddress(a.spender),amount:uint(a.amount)}))};
}

export async function readRangeKeeperLiveWalletEvidenceAtSource(input:{client:RobinhoodClient;wallet:string;source:RangeKeeperSource;
 profiles:readonly MarketProfile[];transferStore:PositionManagerTransferIndexStore;
 allowanceTargets?:readonly {address:`0x${string}`;label:string}[]}){
 assert(input.profiles.length>0&&input.profiles.length<=100);
 for(const profile of input.profiles)await new RangeKeeperChain(input.client,profile.pool).verify(input.source);
 const manager=getAddress(input.profiles[0]!.pool.positionManager);
 assert(input.profiles.every(p=>same(p.pool.positionManager,manager)),'Profile NFT manager scope changed');
 // Receipt blocks may extend the verified genesis index by a few canonical
 // blocks. Never initialize a missing cursor here: that would turn unknown
 // prehistory into an apparently complete owner set.
 const cursor=await input.transferStore.getCursor(4663,manager,0n);
 assert(cursor&&cursor.startBlock===0n,'Verified genesis NFT transfer index is unavailable');
 const gap=cursor.coveredThroughBlock===null?input.source.block+1n:
  input.source.block>cursor.coveredThroughBlock?input.source.block-cursor.coveredThroughBlock:0n;
 if(gap>0n)assert(gap<=10_000n,'NFT transfer index extension exceeds the bounded receipt window');
 const scan=await scanPositionManagerTransferHistory({client:input.client,store:input.transferStore,chainId:4663,manager,startBlock:0n,
  source:input.source,maxBlocksPerRun:10_000n});
 assert(scan.status==='scanned'&&scan.completeThroughSource,'Canonical genesis NFT owner index did not reach this source');
 const indexed=await readCompletePositionManagerNftCustody({client:input.client,store:input.transferStore,
  targetStrategyId:'rangekeeper_v1',operator:input.wallet,positionManager:manager,source:input.source,startBlock:0n});
 assert(indexed.status==='available'&&indexed.enumerationComplete&&indexed.tokenIds,'Complete indexed NFT custody unavailable');
 assert(indexed.tokenIds.length<=100,'Whole-wallet NFT bound exceeded');
 const tokens=new Map<string,{address:`0x${string}`;symbol:string}>(),targets=new Map<string,{address:`0x${string}`;label:string}>();
 for(const p of input.profiles){
  for(const [address,symbol] of [[p.pool.token0,p.pool.reference0],[p.pool.token1,p.pool.reference1]] as const)
   tokens.set(address.toLowerCase(),{address:getAddress(address),symbol});
  for(const [address,label] of [[p.pool.router,'router'],[p.pool.positionManager,'position_manager']] as const)
   targets.set(address.toLowerCase(),{address:getAddress(address),label});
 }
 const observed=await readLiveCustodySnapshot({client:input.client,targetStrategyId:'rangekeeper_v1',operator:input.wallet,
  source:input.source,tokens:[...tokens.values()],allowanceTargets:mergeAllowanceTargetsBySpender([...targets.values(),...(input.allowanceTargets??[])]),positionManager:manager,
  knownNftIds:indexed.tokenIds});
 assert(observed.source.confirmed&&observed.operator&&observed.status!=='unavailable','Canonical wallet source incomplete');
 assert(observed.nftCount.status==='available'&&BigInt(observed.nftCount.value)===BigInt(indexed.tokenIds.length));
 assert(observed.knownNftOwnership.length===indexed.tokenIds.length&&observed.knownNftOwnership.every(x=>
  x.owner.status==='available'&&same(x.owner.value,input.wallet)),'Indexed NFT owner set differs from canonical chain');
 const balances=Object.fromEntries(observed.tokenBalances.map(t=>{
  assert(t.raw.status==='available',`Token balance unavailable: ${t.token}`);
  return [getAddress(t.token).toLowerCase(),BigInt(t.raw.value)];
 }));
 assert(observed.nativeBalanceWei.status==='available'&&observed.nonce.status==='available');
 const pendingNonce=await input.client.getTransactionCount({address:getAddress(input.wallet),blockTag:'pending'});
 assert(String(pendingNonce)===observed.nonce.value,'Wallet has an unresolved pending transaction');
 const allowances=observed.allowances.map(a=>{
  assert(a.raw.status==='available',`Allowance unavailable: ${a.token}:${a.spender}`);
  return {token:getAddress(a.token),spender:getAddress(a.spender),amount:BigInt(a.raw.value)};
 });
 const header=await input.client.getBlock({blockNumber:input.source.block});
 assert(header.hash&&same(header.hash,input.source.hash)&&Number(header.timestamp)===input.source.timestamp,'Wallet source changed after reads');
 return {operator:getAddress(input.wallet),source:input.source,nonce:Number(observed.nonce.value),pendingNonce:Number(pendingNonce),
  nativeWei:BigInt(observed.nativeBalanceWei.value),tokens:balances,nftTokenIds:indexed.tokenIds.map(String),allowances};
}

/** Cancelled unsigned intents for a job; each one retires its stage key, so a replacement needs a new identity. */
async function cancelledStageCount(db:Pick<PoolClient,'query'>,jobId:string):Promise<number>{
 return Number((await db.query<any>(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE job_id=$1 AND status='cancelled'`,[jobId])).rows[0]?.n??0);
}

function liveJobFromRow(row:any):LiveJob{
 return {id:row.id,chainId:4663,wallet:row.wallet,campaignId:row.campaign_id,revision:Number(row.revision),
  allocationId:row.allocation_id,reviewId:row.review_id,kind:row.kind,status:row.status,priority:Number(row.priority),payload:row.payload,
  payloadHash:row.payload_hash,buildId:row.build_id,idempotencyKey:row.idempotency_key,requestDigest:row.request_digest,
  leaseToken:row.lease_token,leaseUntil:row.lease_until?new Date(row.lease_until).toISOString():null,attempt:Number(row.attempt),resumeStage:row.resume_stage};
}
function liveOutboxFromRow(row:any):LiveOutbox{
 return {jobId:row.id,stage:row.stage,intent:row.intent_json,plan:row.plan_json,before:row.before_json,
  nonce:String(row.nonce),status:row.outbox_status,raw:row.signed_raw,hash:row.signed_raw_hash,receipt:row.canonical_receipt_json,
  effects:row.effect_evidence_json,cleanup:row.allowance_cleanup_json};
}

/** Build mandatory queue adapters. Signing and publishing remain outside this
 * module; authorization is delegated to the strategy-owned stage authorizer. */
export function createRangeKeeperLiveQueueAdapters(input:{pool:Pool;client:RobinhoodClient;walletAddress:string;
 transferStore:PositionManagerTransferIndexStore;loadProfiles:(client:PoolClient)=>Promise<readonly unknown[]>;
 rpcUrl:string;anvilBinary:string;
 readReferences?:(input:{campaignId:string;revision:number;profile:MarketProfile;source:RangeKeeperSource})=>Promise<RangeKeeperStageReferences>;
 verifyReferences?:(references:RangeKeeperStageReferences)=>Promise<boolean>;
 capabilityCache?:Map<string,RangeKeeperLiveStageProof>}):LiveWalletQueueAdapters{
 const readReferences=input.readReferences??(args=>readRangeKeeperLiveStageReferences({client:input.client,...args}));
 const verifyReferences=input.verifyReferences??(async references=>{
  const evidence=references.evidence as any;if(!evidence?.campaignId||!Number.isSafeInteger(evidence.revision))return false;
  try{const campaign=await readRangeKeeperLiveCampaign(input.pool,{chainId:4663,address:input.walletAddress,
    campaignId:evidence.campaignId,revision:evidence.revision});
   const profile=marketProfileSchema.parse(campaign.profile);
   return await verifyRangeKeeperLiveStageReferences({client:input.client,campaignId:evidence.campaignId,
    revision:evidence.revision,profile,expected:references as any});
  }catch{return false;}
 });
 const capabilityCache=input.capabilityCache??new Map<string,RangeKeeperLiveStageProof>();
 const profiles=async(client:PoolClient):Promise<MarketProfile[]>=>{
  const rows=await input.loadProfiles(client);assert(Array.isArray(rows)&&rows.length>0&&rows.length<=100);
  return rows.map(row=>marketProfileSchema.parse((row as any)?.profile??row));
 };
 return {
  authorizeStage:async(client,{job,stage,intent,plan})=>{
   assert(same(job.wallet,input.walletAddress),'Queue job is not bound to the configured server wallet');
   const campaign=await readRangeKeeperLiveCampaign(client,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
   const profile=marketProfileSchema.parse(campaign.profile),walletStateRow=(await client.query<any>(
    `SELECT generation,source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2`,
    [4663,job.wallet.toLowerCase()])).rows[0];
   assert(walletStateRow,'Canonical wallet snapshot is missing');
   const source:RangeKeeperSource={block:BigInt(walletStateRow.source_block),hash:walletStateRow.source_hash,
    timestamp:Number(walletStateRow.source_timestamp)};
   const registered=await profiles(client),extraAllowanceTargets=await walletAllowanceTargets(client,job.wallet,registered),
    uses=await readRangeKeeperWalletAllowanceUses(client,job.wallet),
    observed=await assertExecutionWallet({db:client,pool:input.pool,client:input.client,wallet:job.wallet,source,
     profiles:registered,transferStore:input.transferStore,allowanceTargets:extraAllowanceTargets,
     allowanceScope:buildWalletAllowanceScope(uses,registered)});
   const generation=Number(walletStateRow.generation);
   const storedWallet=await client.query<any>(`SELECT nonce,pending_nonce,native_balance_wei,source_block,source_hash,source_timestamp
    FROM deployment_live_wallets WHERE chain_id=$1 AND wallet=$2`,[4663,job.wallet.toLowerCase()]);
   assert(storedWallet.rows[0]&&String(storedWallet.rows[0].nonce)===String(observed.observed.nonce)&&
    String(storedWallet.rows[0].pending_nonce)===String(observed.observed.pendingNonce)&&
    String(storedWallet.rows[0].native_balance_wei)===String(observed.observed.nativeWei),
    'Observed wallet differs from the generation pinned by the queue');
   const tokenRows=await client.query<any>(`SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=$1 AND wallet=$2`,
    [4663,job.wallet.toLowerCase()]);
   assert(tokenRows.rows.length===Object.keys(observed.observed.tokens).length&&tokenRows.rows.every((r:any)=>
    String(observed.observed.tokens[r.token_address])===String(r.balance_raw)),'Observed token inventory differs from persisted queue snapshot');
   const tokenId=campaign.state?.activeTokenId??null;
   const stageRetry=await cancelledStageCount(client,job.id),exitSpendAllowed=job.kind==='close_retain'||isRangeKeeperRetainedExit(campaign.state);
   const chain=new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances),snapshot=await chain.snapshot(source,getAddress(job.wallet),tokenId);
   const references=await readReferences({campaignId:job.campaignId,revision:job.revision,profile,source});
   assert(await verifyReferences(references),'Independent reference provenance could not be reverified');
   const walletBefore:RangeKeeperStageWalletBefore={walletGeneration:generation,wallet:{
    operator:observed.observed.operator,source:{block:String(observed.observed.source.block),hash:observed.observed.source.hash,
     timestamp:observed.observed.source.timestamp},nonce:observed.observed.nonce,pendingNonce:observed.observed.pendingNonce,
    nativeWei:observed.observed.nativeWei,tokens:observed.observed.tokens,nftTokenIds:observed.observed.nftTokenIds,
    allowances:observed.observed.allowances}};
   const prepared=await prepareRangeKeeperLiveStageAuthorization({campaign,snapshot,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
    references,chain,walletBefore,stage,proposedPlan:plan as any,intent,verifyReferences,exitSpendAllowed,stageRetry,
    allowancePolicy:allowancePolicyFromUses(uses,job.campaignId)});
   const cacheKey=rangeKeeperLiveCapabilityCacheKey(job.id,stage,intent,plan);
   const proof=capabilityCache.get(cacheKey);assert(proof,'Exact cached owned-fork stage capability is unavailable; derive a fresh stage proposal');
   capabilityCache.delete(cacheKey);
   return authorizeRangeKeeperLiveStage({campaign,snapshot,source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
    references,chain,walletBefore,stage,proposedPlan:plan as any,intent,capability:proof,verifyReferences,
    exitSpendAllowed,stageRetry,allowancePolicy:allowancePolicyFromUses(uses,job.campaignId)});
  },
  reconcile:async(client,{job,outbox,allocation})=>{
   assert(outbox.hash,'Signed transaction hash is required for receipt reconciliation');
   const before=outbox.before as any;
   assert(before?.wallet&&before?.allocation&&before?.pool,'Persisted pre-stage evidence is incomplete');
   const campaign=await readRangeKeeperLiveCampaign(client,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
   const parsed=marketProfileSchema.parse(campaign.profile),pool=parsed.pool;
   const poolBefore=(before.snapshot??before.pool) as RangeKeeperSnapshot,plan=outbox.plan as any;
   const receipt=await input.client.getTransactionReceipt({hash:outbox.hash});
   assert(receipt.status==='success'||receipt.status==='reverted');
   const header=await input.client.getBlock({blockNumber:receipt.blockNumber});
   assert(header.hash&&same(header.hash,receipt.blockHash),'Receipt header is unavailable or noncanonical');
   const source:RangeKeeperSource={block:receipt.blockNumber,hash:header.hash,timestamp:Number(header.timestamp)};
   const registered=await profiles(client),extraAllowanceTargets=await walletAllowanceTargets(client,job.wallet,registered);
   const afterWallet=await readRangeKeeperLiveWalletEvidenceAtSource({client:input.client,wallet:job.wallet,source,
    profiles:registered,transferStore:input.transferStore,allowanceTargets:extraAllowanceTargets});
   let tokenId=poolBefore.position?.tokenId??null;
   if(plan.kind==='mint'&&receipt.status==='success'){
    const {mintedRangeKeeperTokenId}=await import('../strategy/rangekeeper/live-reconcile.js');
    tokenId=mintedRangeKeeperTokenId(pool,getAddress(job.wallet),receipt);
   }
   const afterPool=await new RangeKeeperChain(input.client,pool,campaign.config.zeroAllowances).snapshot(source,getAddress(job.wallet),tokenId);
   const beforeWallet=wholeWallet(before.wallet);
   const campaignAllocation=before.allocation as any;
   const allocationProof:RangeKeeperWalletCampaignAllocation={campaignId:job.campaignId,
    liquidByTokenAddress:Object.fromEntries(Object.entries(campaignAllocation.liquidByTokenAddress).map(([a,v])=>[a,uint(v)])),
    nativeSpendWei:uint(campaignAllocation.nativeSpendWei),exitReserveWei:uint(campaignAllocation.exitReserveWei),
    nftTokenIds:campaignAllocation.nftTokenIds.map(String)};
   const verified=await reconcileRangeKeeperWalletReceipt({client:input.client,pool,action:{hash:outbox.hash,
    plan,before:poolBefore,intent:outbox.intent},beforeWallet,afterWallet,afterPool,allocation:allocationProof,
    exitSpendAllowed:job.kind==='close_retain'||job.kind==='close_convert'||isRangeKeeperRetainedExit(campaign.state)});
   let referenceValuation:null|{source:{block:string;hash:string;timestamp:number};proofHash:string;evidence:unknown;
    price0:string;price1:string;nativePrice:string}=null;
   try{const refs=await readReferences({campaignId:job.campaignId,revision:job.revision,profile:parsed,source});
    if(!(await verifyReferences(refs)&&refs.source.block===String(source.block)&&same(refs.source.hash,source.hash)&&
      refs.source.timestamp===source.timestamp))throw new Error('reference_verification_unavailable');
    referenceValuation={source:refs.source,proofHash:refs.proofHash,evidence:refs.evidence,
     price0:String(refs.price0),price1:String(refs.price1),nativePrice:String(refs.nativePrice)};
   }catch(error){
    // A reference outage is retried while the receipt is recent: reconcile rolls back and the signed, mined
    // transaction is attributed once references return. Only an old receipt is recorded unvalued.
    if(shouldRetryReceiptValuation(error,source.timestamp))throw error;
   }
   let positionFeeEvidence:any=null;
   if(afterPool.position&&afterPool.position.liquidity>0n){
    positionFeeEvidence={status:'unavailable',source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
     missing:[referenceValuation?'position_fee_mark_unavailable':'independent_reference_unavailable']};
    if(referenceValuation&&campaign.state){
     try{
      const scopedAfter=deriveRangeKeeperCampaignStageSnapshot(campaign,afterPool),mark=await markRangeKeeper(campaign.state,scopedAfter,
       new RangeKeeperChain(input.client,pool,campaign.config.zeroAllowances),campaign.config,
       {price0:BigInt(referenceValuation.price0),price1:BigInt(referenceValuation.price1)}),position=afterPool.position;
      assert(position&&String(mark.source.block)===String(source.block)&&same(mark.source.hash,source.hash)&&
       mark.source.timestamp===source.timestamp,'Position fee mark moved from the receipt source');
      positionFeeEvidence={kind:'rangekeeper_live_position_fee_evidence_v1',source:{block:String(source.block),hash:source.hash,
       timestamp:source.timestamp},referenceProofHash:referenceValuation.proofHash,
       tokenId:String(position.tokenId),liquidityRaw:String(position.liquidity),
       principal0Raw:String(mark.principal0),principal1Raw:String(mark.principal1),uncollected0Raw:String(mark.uncollected0),
       uncollected1Raw:String(mark.uncollected1),grossFee0Raw:String(mark.grossFee0),grossFee1Raw:String(mark.grossFee1),
       inventory0Raw:String(mark.principal0+mark.uncollected0),inventory1Raw:String(mark.principal1+mark.uncollected1),
       collectionSimulation:'canonical_eth_call'};
     }catch(error){positionFeeEvidence={status:'unavailable',source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
      missing:[error instanceof Error?error.message:'position_fee_mark_unavailable']};}
    }
   }else if(afterPool.position){
    positionFeeEvidence={status:'unavailable',source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},
     missing:['position_has_no_active_liquidity']};
   }
   return {...verified,source:verified.source,receiptHash:verified.receiptHash,proofHash:verified.proofHash,
    status:verified.status,receipt:verified.receipt,effects:verified.collection,positionFeeEvidence,
    referenceValuation,afterWallet:{...verified.afterWallet,pendingNonce:afterWallet.pendingNonce}} as any;
  },
  verifyCleanup:async(client,{job,allocation,walletState:rawWalletState})=>{
   const walletState=rawWalletState as Record<string,any>,allocationRow=allocation as Record<string,any>;
   const identity:LiveWalletIdentity={chainId:4663,address:job.wallet};
   const campaign=await readRangeKeeperLiveCampaign(client,{...identity,campaignId:job.campaignId,revision:job.revision});
   const catalog=await profiles(client),extraAllowanceTargets=await walletAllowanceTargets(client,job.wallet,catalog);
   const custodyState=job.kind==='close_retain'||job.kind==='close_convert'||isRangeKeeperRetainedExit(campaign.state)?'closed_empty':'managed';
   // A closing campaign no longer uses its pool's pairs: whatever it leaves non-zero must be a sibling's still-used pair.
   const allowanceScope=await readRangeKeeperAllowanceScope(client,job.wallet,catalog,custodyState==='closed_empty'?job.campaignId:undefined);
   assert(walletState.source_block!==undefined&&/^0x[0-9a-f]{64}$/i.test(String(walletState.source_hash))&&
    Number.isSafeInteger(Number(walletState.source_timestamp)),'Persisted wallet source is incomplete');
   const source={block:BigInt(walletState.source_block),hash:walletState.source_hash as `0x${string}`,
    timestamp:Number(walletState.source_timestamp)};
   const physical=await readRangeKeeperLiveWallet({client:input.client,pool:input.pool,walletAddress:job.wallet,
    source,profiles:catalog,transferStore:input.transferStore,allowanceTargets:extraAllowanceTargets,allowanceScope});
   assert(physical.status==='available'&&physical.review&&physical.commitments,
    `Wallet custody is not fully reconciled${physical.reasons.length?`: ${physical.reasons.slice(0,8).join(',')}`:''}`);
   const allowances=physical.review.allowances.map(a=>{
    assert(a.raw.status==='available');return {token:a.token,spender:a.spender,amount:a.raw.value};
   });
   const lastReceipt=(await client.query<any>(`SELECT effect_evidence_json FROM deployment_live_stage_outbox
    WHERE job_id=$1 AND status='confirmed' AND canonical_receipt_json IS NOT NULL
    ORDER BY created_at DESC,stage DESC LIMIT 1`,[job.id])).rows[0];
   const lastEvidence=typeof lastReceipt?.effect_evidence_json==='string'?JSON.parse(lastReceipt.effect_evidence_json):lastReceipt?.effect_evidence_json;
   const expectedAllowances=lastEvidence?.afterWallet?.allowances;
   assert(Array.isArray(expectedAllowances),'Final canonical receipt lacks its complete allowance identity set');
   assertCleanupAllowanceIdentityCoverage(expectedAllowances,allowances);
   const allowancePolicy=rangeKeeperAllowanceCleanupProof(allowances,allowanceScope);
   const owned=physical.commitments.nftCustody.filter(n=>n.campaignId===job.campaignId);
   const active=owned.filter(n=>n.status==='active');
   if(custodyState==='closed_empty')assert.equal(active.length,0,'Closed campaign still owns an active position');
   else assert(active.length===1&&campaign.allocation.nftTokenIds.includes(active[0]!.tokenId),
    'Opening campaign does not own its verified active RangeKeeper position');
   const allocationHash=String(allocationRow.allocation_hash);
   assert(/^[0-9a-f]{64}$/.test(allocationHash));
   return {allowances,allowancePolicy,allocationHash,
    source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},noPendingAction:true as const,custodyState};
  },
  persistStageAuthorization:async(client,{job,outbox,authorized})=>{
   const campaign=await readRangeKeeperLiveCampaign(client,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
   const {persistRangeKeeperLiveStageAuthorizationInTransaction}=await import('./rangekeeper-live-campaign-store.js');
   await persistRangeKeeperLiveStageAuthorizationInTransaction(client,{jobId:job.id,chainId:4663,wallet:job.wallet,
    campaign,stage:outbox.stage,authorized:authorized as any});
  },
 };
}

/** Persist a recoverable stale/infeasible recenter condition as campaign state (replan or retained exit), so a
 * completed withdrawal or swap is never repeated and the job never loops on the same failure. A bounded post-swap
 * mint wait is returned without a state write. Any other error is left unsettled, with no reads or writes. */
export async function settleRangeKeeperLiveManagementStage(pool:Pool,input:{job:LiveJob;error:unknown;
 readSnapshot:(campaign:LiveCampaign,source:RangeKeeperSource)=>Promise<RangeKeeperSnapshot>;now?:()=>number}):Promise<RangeKeeperManagementSettlement>{
 const {job,error}=input;
 if(job.kind!=='change_range'||!(error instanceof RangeKeeperStaleCandidateError||error instanceof RangeKeeperMintUnavailableError))return {kind:'unsettled'};
 return withLiveWalletTransaction(pool,{chainId:4663,address:job.wallet},async db=>{
  const campaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
  assert(campaign.state&&campaign.stateHash,'Management campaign state is unavailable');
  const row=(await db.query<any>(`SELECT source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,
   [job.wallet.toLowerCase()])).rows[0];assert(row,'Canonical live wallet snapshot missing');
  const source:RangeKeeperSource={block:BigInt(row.source_block),hash:row.source_hash,timestamp:Number(row.source_timestamp)};
  const snapshot=await input.readSnapshot(campaign,source);
  const settlement=settleRangeKeeperLiveStageError(campaign.state,snapshot,Math.floor((input.now??Date.now)()/1000),error);
  if(settlement.kind==='unsettled'||settlement.kind==='wait')return settlement;
  const sourceText={block:String(source.block),hash:source.hash,timestamp:source.timestamp};
  await appendRangeKeeperLiveCampaignEventInTransaction(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision,
   effectId:contentHash({kind:'rangekeeper_management_settle',jobId:job.id,previousStateHash:campaign.stateHash,action:settlement.kind}),
   kind:'mark',expectedStateHash:campaign.stateHash,state:settlement.state,source:sourceText,
   payload:{schemaVersion:1,kind:'rangekeeper_live_management_settle_v1',jobId:job.id,action:settlement.kind,reason:settlement.reason,
    error:(error instanceof Error?error.message:String(error)).slice(0,300),source:sourceText,previousStateHash:campaign.stateHash}});
  return {kind:settlement.kind,reason:settlement.reason};
 });
}

/** Compose canonical queue adapters with the RangeKeeper worker lifecycle.
 * The composition deliberately supplies no signer or publisher. */
export function createRangeKeeperLiveWalletWorkerAdapters(input:{pool:Pool;client:RobinhoodClient;walletAddress:string;
 transferStore:PositionManagerTransferIndexStore;loadProfiles:(client:PoolClient)=>Promise<readonly unknown[]>;
 rpcUrl:string;anvilBinary:string;readReferences?:(input:{campaignId:string;revision:number;profile:MarketProfile;source:RangeKeeperSource})=>Promise<RangeKeeperStageReferences>;
 verifyReferences?:(references:RangeKeeperStageReferences)=>Promise<boolean>;capabilityCache?:Map<string,RangeKeeperLiveStageProof>;
 observeAndEnqueueManagement?:()=>Promise<void>;
 /** Re-anchor the persisted wallet snapshot to a fresh confirmed source (refuses while a transaction is unresolved). */
 refreshWalletSnapshot?:()=>Promise<void>;
}):RangeKeeperLiveWorkerAdapters&{queueAdapters:LiveWalletQueueAdapters}{
 const capabilityCache=input.capabilityCache??new Map<string,RangeKeeperLiveStageProof>();
 const readReferences=input.readReferences??((args:{campaignId:string;revision:number;profile:MarketProfile;source:RangeKeeperSource})=>
  readRangeKeeperLiveStageReferences({client:input.client,...args}));
 const verifyReferences=input.verifyReferences??(async(references:RangeKeeperStageReferences)=>{
  const evidence=references.evidence as any;if(!evidence?.campaignId||!Number.isSafeInteger(evidence.revision))return false;
  try{const campaign=await readRangeKeeperLiveCampaign(input.pool,{chainId:4663,address:input.walletAddress,
    campaignId:evidence.campaignId,revision:evidence.revision});
   return await verifyRangeKeeperLiveStageReferences({client:input.client,campaignId:evidence.campaignId,revision:evidence.revision,
    profile:marketProfileSchema.parse(campaign.profile),expected:references as any});
  }catch{return false;}
 });
 const queueAdapters=createRangeKeeperLiveQueueAdapters({...input,capabilityCache,readReferences,verifyReferences});
 queueAdapters.afterReceipt=async(client,args)=>{await applyRangeKeeperLiveReceiptEffectInTransaction(client,args);};
 const preparedVerifier=createRangeKeeperLivePreparedIntentVerifier({pool:input.pool,client:input.client,
  wallet:{chainId:4663,address:input.walletAddress.toLowerCase()}});
 const sourceAt=async(db:PoolClient,wallet:string):Promise<RangeKeeperSource>=>{
  const row=(await db.query<any>(`SELECT source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,
   [wallet.toLowerCase()])).rows[0];assert(row,'Canonical live wallet snapshot missing');
  return {block:BigInt(row.source_block),hash:row.source_hash,timestamp:Number(row.source_timestamp)};
 };
 const campaignFor=async(job:LiveJob,db:PoolClient)=>readRangeKeeperLiveCampaign(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,revision:job.revision});
 const initializeOpeningCampaign=async({job}: {job:LiveJob})=>withLiveWalletTransaction(input.pool,{chainId:4663,address:job.wallet},async db=>{
  const campaign=await campaignFor(job,db);if(campaign.state)return;
  assert(job.kind==='open'&&campaign.status==='opening','Only a reserved open campaign can be initialized');
  const source=await sourceAt(db,job.wallet),chain=new RangeKeeperChain(input.client,campaign.config.pool,campaign.config.zeroAllowances);
  await chain.verify(source);const snapshot=await chain.snapshot(source,campaign.wallet,null);
  const state=buildRangeKeeperLiveEntryState(campaign,snapshot),payload=campaign.reviewPayload as any,
   token0=state.initial0,token1=state.initial1,native=state.initialNativeWei;
  await initializeRangeKeeperLiveCampaignInTransaction(db,{chainId:4663,address:job.wallet,campaignId:campaign.id,revision:campaign.revision,
   effectId:contentHash({kind:'rangekeeper_live_initialized',jobId:job.id}),kind:'initialized',expectedStateHash:null,state,
   source:{block:String(source.block),hash:source.hash,timestamp:source.timestamp},payload:{jobId:job.id,reviewId:job.reviewId},initial:{
    profileId:campaign.profileId,profileHash:campaign.profileHash,profile:campaign.profile,config:campaign.config,configHash:campaign.configHash,
    revisionConfigHash:campaign.revisionConfigHash,allocationId:campaign.allocation.allocationId,initialToken0Raw:String(token0),
    initialToken1Raw:String(token1),initialNativeWei:String(native),baseline:campaign.baseline}});
 });
 const nextStage=async({job}: {job:LiveJob;lastOutbox:LiveOutbox|null}):Promise<RangeKeeperNextStage&{value?:{stage:string;intent:any;plan:unknown}}>=>(async()=>{
  const wallet={chainId:4663 as const,address:job.wallet};
  return withLiveWalletTransaction(input.pool,wallet,async db=>{
   const campaign=await campaignFor(job,db);assert(campaign.state,'Opening campaign has not been initialized');
   // The first range was discarded as stale after a confirmed withdrawal: nothing to plan until the manager
   // installs a freshly confirmed and simulated one. Waiting never repeats the withdrawal.
   if(isRangeKeeperAwaitingReplan(campaign.state))return {kind:'wait' as const,reason:'awaiting_replan'};
   const source=await sourceAt(db,job.wallet),profile=marketProfileSchema.parse(campaign.profile),registered=await input.loadProfiles(db),
    parsed=registered.map(row=>marketProfileSchema.parse((row as any)?.profile??row)),
    extra=await walletAllowanceTargets(db,job.wallet,parsed),uses=await readRangeKeeperWalletAllowanceUses(db,job.wallet);
   const walletCheck=await assertExecutionWallet({db,pool:input.pool,client:input.client,wallet:job.wallet,source,
    profiles:parsed,transferStore:input.transferStore,allowanceTargets:extra,allowanceScope:buildWalletAllowanceScope(uses,parsed)});
   const allowancePolicy=allowancePolicyFromUses(uses,job.campaignId);
   const snapshot=await new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances).snapshot(source,campaign.wallet,campaign.state.activeTokenId);
   const references=await readReferences({campaignId:job.campaignId,revision:job.revision,profile,source});
   assert(await verifyReferences(references),'Independent pinned reference verification failed');
   const strategySnapshot=deriveRangeKeeperCampaignStageSnapshot(campaign,snapshot),plan=await nextRangeKeeperStage(campaign.state,
    strategySnapshot,campaign.config,new RangeKeeperChain(input.client,profile.pool,campaign.config.zeroAllowances),
    {price0:references.price0,price1:references.price1},allowancePolicy);
   if(!plan)return {kind:'complete' as const};
   const stageRetry=await cancelledStageCount(db,job.id),exitSpendAllowed=job.kind==='close_retain'||isRangeKeeperRetainedExit(campaign.state);
   const stage=deriveRangeKeeperStage(plan,campaign.stateRevision,stageRetry),call=encodeRangeKeeperTx(profile.pool,campaign.wallet,plan),nonce=walletCheck.observed.nonce;
   const sourceText={block:String(source.block),hash:source.hash,timestamp:source.timestamp};
   const walletBefore:RangeKeeperStageWalletBefore={walletGeneration:Number(walletCheck.state.generation),wallet:{
    operator:walletCheck.observed.operator,source:sourceText,nonce,pendingNonce:walletCheck.observed.pendingNonce,
    nativeWei:walletCheck.observed.nativeWei,tokens:walletCheck.observed.tokens,nftTokenIds:walletCheck.observed.nftTokenIds,
    allowances:walletCheck.observed.allowances}};
   const placeholder={id:randomUUID(),chainId:4663 as const,operator:campaign.wallet,action:plan.kind,nonce,to:call.to,data:call.data,
    value:'0' as const,gas:'8000000',maxFeePerGas:'1',maxPriorityFeePerGas:'0',sourceBlock:String(source.block),sourceHash:source.hash};
   const prepared=await prepareRangeKeeperLiveStageAuthorization({campaign,snapshot,source:sourceText,references,chain:new RangeKeeperChain(
    input.client,profile.pool,campaign.config.zeroAllowances),walletBefore,stage,proposedPlan:plan,intent:placeholder,verifyReferences,
    exitSpendAllowed,stageRetry,allowancePolicy});
   // A router price failure for the mint is a pre-signing timing condition, not a custody or authorization fault.
   const proof=await simulateRangeKeeperLiveStage(prepared.request,{client:input.client,rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary})
    .catch(error=>{throw classifyRangeKeeperStageError(plan,error);});
   const evidence=proof.evidence,intent={...placeholder,gas:evidence.gasUnitsBound,maxFeePerGas:evidence.maxFeePerGasWei,
    maxPriorityFeePerGas:evidence.priorityFeePerGasWei};
   const cacheKey=rangeKeeperLiveCapabilityCacheKey(job.id,stage,intent,plan);
   for(const [key,cached] of capabilityCache)if(cached.evidence.expiresAt<=Date.now())capabilityCache.delete(key);
   assert(capabilityCache.size<1000,'Owned-fork capability cache bound exceeded');
   assert(!capabilityCache.has(cacheKey),'Owned-fork stage capability cache collision');capabilityCache.set(cacheKey,proof);
   return {kind:'stage' as const,value:{stage,intent,plan}};
  });
 })();
 const waitForCanonicalReceipt=async({hash}: {job:LiveJob;stage:string;hash:Hex})=>{
  const deadline=Date.now()+300_000;
  while(Date.now()<deadline){
   const receipt=await input.client.getTransactionReceipt({hash}).catch(()=>null);
   if(receipt){const [header,tip]=await Promise.all([input.client.getBlock({blockNumber:receipt.blockNumber}),input.client.getBlock()]);
    if(same(receipt.transactionHash,hash)&&header.hash&&same(header.hash,receipt.blockHash)&&tip.number>=receipt.blockNumber+64n)return;}
   await new Promise(resolve=>setTimeout(resolve,1500));
  }
  throw new Error('canonical_receipt_confirmation_timeout');
 };
 const hasCanonicalReceipt=async({hash}: {job:LiveJob;stage:string;hash:Hex})=>{
  try{const receipt=await input.client.getTransactionReceipt({hash}),[header,tip]=await Promise.all([
    input.client.getBlock({blockNumber:receipt.blockNumber}),input.client.getBlock()]);
   return same(receipt.transactionHash,hash)&&!!header.hash&&same(header.hash,receipt.blockHash)&&tip.number>=receipt.blockNumber+64n;
  }catch{return false;}
 };
 const completeOpeningLifecycle=async({effectId,job,finalOutbox,cleanup}: {effectId:string;job:LiveJob;finalOutbox:LiveOutbox;cleanup:unknown})=>
  withLiveWalletTransaction(input.pool,{chainId:4663,address:job.wallet},async db=>{
   const campaign=await campaignFor(job,db);assert(campaign.state&&campaign.state.phase==='holding','Opening cleanup lacks a held strategy position');
   const c=((cleanup as any)?.cleanup??cleanup) as any,receiptHash=(finalOutbox.receipt as any)?.receiptHash;
   assert(c?.source&&typeof receiptHash==='string'&&/^[0-9a-f]{64}$/.test(receiptHash),'Canonical cleanup/receipt evidence missing');
   await appendRangeKeeperLiveCampaignEventInTransaction(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,
    revision:job.revision,effectId,kind:'opened',expectedStateHash:campaign.stateHash,state:campaign.state,
    source:c.source,receiptHash:`0x${receiptHash}` as Hex,payload:{jobId:job.id,stage:finalOutbox.stage,cleanup:c}});
  });
 const recoverFinishedOpenings=async()=>{
  const rows=(await input.pool.query<any>(`SELECT j.*,o.stage,o.intent_json,o.plan_json,o.before_json,o.nonce,o.status outbox_status,
   o.signed_raw,o.signed_raw_hash,o.canonical_receipt_json,o.effect_evidence_json,o.allowance_cleanup_json
   FROM deployment_live_jobs j JOIN deployment_campaigns c ON c.id=j.campaign_id
   JOIN LATERAL (SELECT * FROM deployment_live_stage_outbox WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1) o ON TRUE
   WHERE j.chain_id=4663 AND j.wallet=$1 AND j.kind='open' AND j.status='succeeded' AND c.lifecycle='opening'
   AND o.status='confirmed' AND o.allowance_cleanup_json IS NOT NULL ORDER BY j.updated_at LIMIT 101`,[input.walletAddress.toLowerCase()])).rows;
  assert(rows.length<=100,'Finished opening recovery bound exceeded');
  for(const row of rows){
   const job=liveJobFromRow(row),last=liveOutboxFromRow(row);
   const receiptHash=(last.receipt as any)?.receiptHash;if(typeof receiptHash!=='string')continue;
   const effectId=contentHash({kind:'rangekeeper_open_cleanup_complete',jobId:job.id,stage:last.stage,receiptHash});
   await completeOpeningLifecycle({effectId,job,finalOutbox:last,cleanup:last.cleanup});
  }
 };
 const prepareManagementCampaign=async({job}: {job:LiveJob})=>{
  assert(job.kind==='change_range'||job.kind==='close_retain','Unsupported managed operation kind');
  await withLiveWalletTransaction(input.pool,{chainId:4663,address:job.wallet},async db=>{
   const campaign=await campaignFor(job,db);assert(campaign.state&&campaign.stateHash,'Management campaign state is unavailable');
   assert(contentHash(job.payload)===job.payloadHash,'Frozen management job payload hash changed');
   const payload=parseRangeKeeperJson<RangeKeeperLiveManagementReviewPayload>(job.payload);
   assert(payload.operationKind===job.kind,'Management job kind differs from its frozen review');
   const effectId=contentHash({kind:'rangekeeper_management_transition',jobId:job.id,reviewHash:contentHash(job.payload)});
   const eventPayload={schemaVersion:1,kind:'rangekeeper_live_management_transition_v1',jobId:job.id,
    operationKind:job.kind,reviewHash:contentHash(job.payload),source:payload.source};
   const prior=(await db.query<any>(`SELECT kind,payload_hash FROM deployment_live_runtime_events
    WHERE campaign_id=$1 AND revision=$2 AND effect_id=$3`,[job.campaignId,job.revision,effectId])).rows[0];
   if(prior){assert(prior.kind==='mark'&&prior.payload_hash===contentHash(eventPayload),
    'Persisted management transition replay differs from its immutable job');return;}
   // Nothing is signed before this first transition, so an unusable frozen review is rejected rather than retried.
   if(job.kind==='change_range'&&payload.expiresAt*1000<=Date.now())
    throw new RangeKeeperLiveStaleManagementReviewError('Management review expired before its first stage');
   let state:RangeKeeperLiveState;
   try{state=deriveRangeKeeperLiveManagementTransition(campaign,payload);}
   catch(error){throw new RangeKeeperLiveStaleManagementReviewError(error instanceof Error?error.message:'Management review is unusable');}
   const nextHash=contentHash(JSON.parse(rangeKeeperJson(state)));
   if(nextHash===campaign.stateHash)return;
   await appendRangeKeeperLiveCampaignEventInTransaction(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,
    revision:job.revision,effectId,kind:'mark',expectedStateHash:campaign.stateHash,state,
    source:{block:String(payload.source.block),hash:payload.source.hash,timestamp:payload.source.timestamp},
    payload:eventPayload});
  });
 };
 const completeManagedLifecycle=async({effectId,job,finalOutbox,cleanup}: {
  effectId:string;job:LiveJob;finalOutbox:LiveOutbox;cleanup:unknown;
 })=>{
  assert((job.kind==='close_retain'||job.kind==='change_range')&&finalOutbox.status==='confirmed','Only a reconciled retained close can release custody');
  const c=((cleanup as any)?.cleanup??cleanup) as any,receiptHash=(finalOutbox.receipt as any)?.receiptHash;
  assert(c?.verified===true&&c.custodyState==='closed_empty'&&c.noPendingAction===true&&c.source&&
   typeof receiptHash==='string'&&/^[0-9a-f]{64}$/.test(receiptHash),'Retained close lacks terminal cleanup proof');
  await withLiveWalletTransaction(input.pool,{chainId:4663,address:job.wallet},async db=>{
   const campaign=await campaignFor(job,db);assert(campaign.state&&campaign.stateHash,'Retained close campaign state is unavailable');
   const state=deriveRangeKeeperLiveClosedState(campaign.state,c.source);
   const terminalEffect=readRangeKeeperLiveTerminalEffect(finalOutbox.effects,c.source),snapshot=terminalEffect?.snapshot;
   const terminalSnapshot=snapshot?buildRangeKeeperLiveTerminalSnapshot(campaign,snapshot,c):null;
   const referenceValuation=terminalEffect?.referenceValuation??null;
   const positionFeeEvidence=terminalEffect?.positionFeeEvidence??null;
   const terminalValuation={schemaVersion:1,kind:'rangekeeper_live_valuation_mark_v1',campaignId:campaign.id,revision:campaign.revision,
    stateRevision:campaign.stateRevision+1,runtimeStateHash:contentHash(JSON.parse(rangeKeeperJson(state))),
    profileId:campaign.profileId,profileHash:campaign.profileHash,configHash:campaign.configHash.slice(2),
    allocationId:campaign.allocation.allocationId,allocationHash:campaign.allocation.allocationHash,source:c.source,
    snapshot:terminalSnapshot,allocation:{liquidByTokenAddress:Object.fromEntries(Object.entries(campaign.allocation.liquidByTokenAddress)
     .map(([address,amount])=>[address,amount.toString()])),nativeSpendWei:String(campaign.allocation.nativeSpendWei),
     exitReserveWei:String(campaign.allocation.exitReserveWei),nftTokenIds:campaign.allocation.nftTokenIds},
    referenceValuation:referenceValuation?{status:'available',...referenceValuation}:
     {status:'unavailable',source:c.source,missing:['receipt_source_reference_unavailable']},
    positionFeeEvidence,accountingState:{phase:state.phase,epoch:state.recenters,initial0:state.initial0,initial1:state.initial1,
     initialNativeWei:state.initialNativeWei,initialStrategyValue:state.initialStrategyValue,
     initialCapitalValue:rangeKeeperLiveInitialCapitalValueX18(state,campaign.reviewPayload),collectedFee0:state.collectedFee0,
     collectedFee1:state.collectedFee1,gasSpentWei:state.gasSpentWei,costEvents:state.costEvents}};
   await appendRangeKeeperLiveCampaignEventInTransaction(db,{chainId:4663,address:job.wallet,campaignId:job.campaignId,
    revision:job.revision,effectId,kind:'closed',expectedStateHash:campaign.stateHash,state,source:c.source,
    receiptHash:`0x${receiptHash}` as Hex,payload:{schemaVersion:1,kind:'rangekeeper_live_retained_close_complete_v1',
     jobId:job.id,stage:finalOutbox.stage,receiptHash,cleanup:c,terminalValuation}});
  });
  await releaseLiveWalletAllocation(input.pool,{chainId:4663,address:job.wallet,allocationId:job.allocationId});
 };
 const recoverFinishedManagement=async()=>{
  // A crash between queue.finish and the terminal campaign event leaves a succeeded retained exit (a close job, or a
  // recenter that settled into one) whose campaign is still active: replay the idempotent lifecycle completion.
  const unfinished=(await input.pool.query<any>(`SELECT j.*,o.stage,o.intent_json,o.plan_json,o.before_json,o.nonce,o.status outbox_status,
   o.signed_raw,o.signed_raw_hash,o.canonical_receipt_json,o.effect_evidence_json,o.allowance_cleanup_json
   FROM deployment_live_jobs j JOIN deployment_campaigns c ON c.id=j.campaign_id
   JOIN LATERAL (SELECT * FROM deployment_live_stage_outbox WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1) o ON TRUE
   WHERE j.chain_id=4663 AND j.wallet=$1 AND j.kind IN('close_retain','change_range') AND j.status='succeeded' AND c.lifecycle='active'
    AND o.status='confirmed' AND o.allowance_cleanup_json->>'custodyState'='closed_empty'
    AND NOT EXISTS(SELECT 1 FROM deployment_live_runtime_events e WHERE e.campaign_id=j.campaign_id AND e.revision=j.revision
     AND e.kind='closed' AND e.payload->>'jobId'=j.id::text)
   ORDER BY j.updated_at LIMIT 101`,[input.walletAddress.toLowerCase()])).rows;
  assert(unfinished.length<=100,'Finished retained-close terminal recovery bound exceeded');
  for(const row of unfinished){
   const job=liveJobFromRow(row),last=liveOutboxFromRow(row),receiptHash=(last.receipt as any)?.receiptHash;
   if(typeof receiptHash!=='string')continue;
   await completeManagedLifecycle({effectId:contentHash({kind:`rangekeeper_${job.kind}_cleanup_complete`,jobId:job.id,stage:last.stage,receiptHash}),
    job,finalOutbox:last,cleanup:last.cleanup});
  }
  const rows=(await input.pool.query<any>(`SELECT j.chain_id,j.wallet,j.allocation_id FROM deployment_live_jobs j
   JOIN deployment_campaigns c ON c.id=j.campaign_id JOIN deployment_live_allocations a ON a.id=j.allocation_id
   WHERE j.chain_id=4663 AND j.wallet=$1 AND j.kind IN('close_retain','change_range') AND j.status='succeeded'
    AND c.lifecycle='closed' AND a.state<>'released' AND EXISTS(
     SELECT 1 FROM deployment_live_runtime_events e WHERE e.campaign_id=j.campaign_id AND e.revision=j.revision
      AND e.kind='closed' AND e.payload->>'jobId'=j.id::text)
    ORDER BY j.updated_at LIMIT 101`,[input.walletAddress.toLowerCase()])).rows;
  assert(rows.length<=100,'Finished retained-close recovery bound exceeded');
  for(const row of rows)await releaseLiveWalletAllocation(input.pool,{chainId:4663,address:row.wallet,allocationId:row.allocation_id});
 };
 const settleManagementStage=({job,error}:{job:LiveJob;error:unknown})=>settleRangeKeeperLiveManagementStage(input.pool,{job,error,
  readSnapshot:async(campaign,source)=>new RangeKeeperChain(input.client,marketProfileSchema.parse(campaign.profile).pool,campaign.config.zeroAllowances)
   .snapshot(source,campaign.wallet,campaign.state!.activeTokenId)});
 const workerAdapters:RangeKeeperLiveWorkerAdapters={initializeOpeningCampaign,nextStage,
  advanceCampaignEffect:async({job,outbox})=>{await withLiveWalletTransaction(input.pool,{chainId:4663,address:job.wallet},
   async db=>{await applyRangeKeeperLiveReceiptEffectInTransaction(db,{job,outbox});});},
  verifyPreparedIntent:preparedVerifier,sourceMaxObservationGapSeconds:async({job})=>{
   const db=await input.pool.connect();try{
    const campaign=await campaignFor(job,db);
    const gap=campaign.config.limits.maxObservationGapSeconds;
    assert(Number.isSafeInteger(gap)&&gap>0,'Frozen campaign observation gap is invalid');return gap;
   }finally{db.release();}
  },completeOpeningLifecycle,prepareManagementCampaign,settleManagementStage,completeManagedLifecycle,
  // A stage must be authorized against a source younger than the frozen observation gap. After a wait, a block or a
  // restart the persisted wallet source may have aged past it, so re-anchor it first (content-unchanged only).
  refreshWalletSnapshot:async()=>{
   if(!input.refreshWalletSnapshot)return;
   const state=await readWalletState(input.pool,{chainId:4663,address:input.walletAddress.toLowerCase()});
   if(state.source&&Math.floor(Date.now()/1000)-state.source.timestamp<=45)return;
   await input.refreshWalletSnapshot();
  },
  recoverFinishedOpenings,recoverFinishedManagement,waitForCanonicalReceipt,hasCanonicalReceipt};
 /** Observation and admission writers may run beside queued and campaign-local blocked work; they never run beside
  * an in-flight job or an unresolved transaction, so a blocked campaign cannot starve a sibling's exit. */
 const managementObservationReady=async()=>{
  const wallet=input.walletAddress.toLowerCase();
  const ready=(await input.pool.query<any>(`SELECT EXISTS(SELECT 1 FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1
   AND status='available') AS wallet_ready`,[wallet])).rows[0]?.wallet_ready===true;
  if(!ready)return false;
  const lane=await readLiveWalletLane(input.pool,{chainId:4663,address:wallet});
  return !lane.inflight&&!lane.unresolved;
 };
 return Object.assign(workerAdapters,{queueAdapters,managementObservationReady,
  ...(input.observeAndEnqueueManagement?{observeAndEnqueueManagement:input.observeAndEnqueueManagement}:{})});
}

/** Fully compose the guarded queue and worker. Both irreversible callbacks are
 * absent from this construction, so defaults can only review or resume reads. */
export function createRangeKeeperLiveWalletRuntime(input:Parameters<typeof createRangeKeeperLiveWalletWorkerAdapters>[0]&{
 options?:RangeKeeperLiveWorkerOptions;testHooks?:{enabled:true;fork:PaperFork;
  signIntent:(intent:import('../live-pilot/journal.js').PilotIntent)=>Promise<Hex>;
  mineConfirmations?:64;failAckAfterPublishOnce?:boolean}}){
 const adapters=createRangeKeeperLiveWalletWorkerAdapters(input),wallet:LiveWalletIdentity={chainId:4663,address:input.walletAddress.toLowerCase()},
  queue=new LiveWalletQueue(input.pool,adapters.queueAdapters),worker=createRangeKeeperLiveWalletWorker({queue,wallet,adapters,options:input.options});
 if(input.testHooks){
  assert(input.testHooks.enabled===true,'Runtime test hooks require explicit opt-in');
  assertOwnedPaperFork(input.testHooks.fork);
  const local=createPublicClient({chain:robinhoodChain,transport:http(input.testHooks.fork.localUrl,{retryCount:0,timeout:5000})});
  const verifyLocalTarget=async()=>{
   assertOwnedPaperFork(input.testHooks!.fork);
   assert.equal(await local.getChainId(),4663,'Local test publisher is on the wrong chain');
   await local.getBlockNumber();
  };
  adapters.signIntent=async intent=>{await verifyLocalTarget();return input.testHooks!.signIntent(intent);};
  let dropAck=input.testHooks.failAckAfterPublishOnce===true;
  adapters.publishRaw=async raw=>{await verifyLocalTarget();
   const hash=await (local as any).request({method:'eth_sendRawTransaction',params:[raw]}) as Hex;
   if(input.testHooks!.mineConfirmations===64){
    const receiptDeadline=Date.now()+20_000;let included=false;
    while(Date.now()<receiptDeadline){
     await verifyLocalTarget();
     const receipt=await (local as any).request({method:'eth_getTransactionReceipt',params:[hash]});
     if(receipt!==null){
      assert.equal(String((receipt as any).transactionHash).toLowerCase(),hash.toLowerCase(),
       'Owned fork returned a receipt for another transaction');
      included=true;break;
     }
     await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(included,'Owned fork transaction was not mined before the confirmation test window');
    await verifyLocalTarget();
    await input.testHooks!.fork.rpc('anvil_mine',['0x40','0x0']);}
   if(dropAck){dropAck=false;throw new Error('injected_owned_fork_publish_ack_loss');}
   return hash;};
 }
 return {queue,worker,adapters};
}
