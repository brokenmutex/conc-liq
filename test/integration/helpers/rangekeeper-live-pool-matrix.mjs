// Profile-matrix and shared-wallet concurrency drivers for the owned-fork
// RangeKeeper worker harness (rangekeeper-live-worker-fork.mjs).
//
// Everything here runs against the objects the harness builds around ONE owned
// loopback Anvil fork: HTTP command server, persisted reviews, the shared-wallet
// queue, the worker, the management observer. Nothing in this module can reach
// an upstream node, a real signer or the production database; it receives only
// the harness context. Allowance/approval-specific assertions are NOT made
// here: they are delegated to rangekeeper-live-allowance-policy.mjs.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseAbi} from 'viem';
import {readRangeKeeperLiveCampaign} from '../../../src/deployments/rangekeeper-live-campaign-store.ts';
import {readCommitments,readWalletState} from '../../../src/deployments/live-wallet-store.ts';
import {readLiveWalletLane} from '../../../src/deployments/live-wallet-queue.ts';
import {rangeKeeperLiveSetupPreflightInput} from '../../../src/deployments/rangekeeper-live-setup-preflight.ts';
import * as allowancePolicy from './rangekeeper-live-allowance-policy.mjs';

/** Default structural matrix: one registered profile per structural class (quote side x fee tier).
 * GOOGL carries both token1-quote classes because SPY/QQQ reference prices are not eligible while the
 * equity market is closed (their feeds stop updating before the latest session closes). AAPL 10000 is the
 * only 10000 profile and runs last (it inherits AAPL inventory retained by AAPL 500). */
export const DEFAULT_MATRIX=['AAPL:500','NVDA:3000','GOOGL:500','GOOGL:3000','AAPL:10000'];
/** Concurrency triple: AAPL 500 + AAPL 3000 share a risky token, GOOGL 500 has
 * USDG as token1; all three share USDG. */
export const DEFAULT_CONCURRENCY=['AAPL:500','AAPL:3000','GOOGL:500'];

const positionsAbi=parseAbi(['function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
 'function ownerOf(uint256 tokenId) view returns (address)']);
const lower=value=>String(value).toLowerCase();
const redact=text=>String(text).replace(/https?:\/\/\S+/gi,'[redacted-url]');
export const shortError=error=>redact(error instanceof Error?(error.stack??error.message):String(error)).slice(0,900);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function describeProfile(row){
 const p=row.profile.pool,quoteToken=p.quoteToken,riskyReference=quoteToken===0?p.reference1:p.reference0;
 return {id:row.id,symbol:String(riskyReference).split('/')[0],pair:`${p.reference0}|${p.reference1}`,quoteSide:`token${quoteToken}`,
  fee:p.fee,tickSpacing:p.tickSpacing,pool:p.pool,token0:p.token0,token1:p.token1,decimals:[p.decimals0,p.decimals1]};
}

/** Resolve `SYMBOL:FEE` selectors (or a full id / >=8 char id prefix) to REAL registered profile rows. */
export function selectProfiles(rows,selectors){
 const views=rows.map(row=>({row,view:describeProfile(row)}));
 return selectors.map(selector=>{
  const text=String(selector).trim(),bySymbol=/^([A-Za-z0-9]+):(\d+)$/.exec(text);
  const matches=bySymbol?views.filter(item=>item.view.symbol.toUpperCase()===bySymbol[1].toUpperCase()&&item.view.fee===Number(bySymbol[2])):
   views.filter(item=>item.row.id===text||text.length>=8&&item.row.id.startsWith(text));
  assert.equal(matches.length,1,`Profile selector "${selector}" matched ${matches.length} registered profiles`);
  return matches[0];
 });
}

/** Even widths in tick-spacing units, narrowest first, aiming at roughly 1-4% of
 * price for fee 500, widening for the thinner fee tiers. A genuine liquidity or
 * deployment-feasibility rejection retries the next width; every attempt is reported. */
export function defaultWidthLadder(tickSpacing){
 if(tickSpacing<=10)return [20,40,80];
 if(tickSpacing<=60)return [8,20,40];
 return [4,10,20];
}

const WIDTH_SENSITIVE=[/^rangekeeper_candidate_unavailable:/,/^rangekeeper_liquidity_share_limit$/,
 /^rangekeeper_measured_cost_admission_failed/,/^owned_fork_feasibility_unavailable$/];
const MARKET_ONLY=[/^pool_independent_reference_deviation$/,/^independent_reference_unavailable$/];
const FIXTURE=[/^fresh_source_stale$/,/^owned_fork_candidate_confirmation_expired$/,/^wallet_strategy_inventory_empty$/,
 /^native_gas_allocation_shortfall$/,/^reviewed_source_replay_mismatch$/];
const INFRA=[/^fresh_canonical_pool_frame_unavailable$/,/^live_wallet_snapshot_unavailable$/,/^fresh_gas_price_unavailable$/];
const any=(patterns,reason)=>patterns.some(pattern=>pattern.test(reason));
/** Classify a preflight `missing[0]` reason. `market` blocks are genuine pool/liquidity/oracle
 * conditions; `fixture` blocks are harness timing/inventory conditions; `infra` blocks are
 * transient read failures; everything else is a structural product/harness failure. */
export function classifyPreflightBlock(reason){
 const text=String(reason??'unknown');
 if(any(WIDTH_SENSITIVE,text))return 'market_width_sensitive';
 if(any(MARKET_ONLY,text))return 'market';
 if(any(FIXTURE,text))return 'fixture';
 if(any(INFRA,text))return 'infra';
 return 'structural';
}
const WORKER_MARKET=[/Current swap quote is unavailable or too costly/,/Current swap would leave the approved range/,
 /Current quote cannot fund approved range/,/Frozen mint range no longer contains price/,/Repriced mint misses deployment bounds/];
export function classifyWorkerBlock(reason){return WORKER_MARKET.some(pattern=>pattern.test(String(reason)))?'market':'structural';}

/** Context accessors shared by all drivers. */
const identityOf=ctx=>ctx.identity;
async function http(ctx,path,body){
 const response=await fetch(ctx.commandUrl+path,{method:'POST',headers:ctx.commandHeaders,body:JSON.stringify(body??{})});
 let json=null;try{json=await response.json();}catch{json=null;}
 return {status:response.status,body:json};
}
async function getJson(ctx,path){
 const response=await fetch(ctx.commandUrl+path);let json=null;try{json=await response.json();}catch{json=null;}
 return {status:response.status,body:json};
}

/** Make the next preflight's confirmed source fresh: mine one block at wall-clock
 * time followed by 64 more at the same timestamp, so the block 64 behind head
 * carries a current timestamp. Local blocks only; nothing reaches the upstream. */
export async function refreshLocalSource(ctx){
 const latest=await ctx.local.getBlock();
 const now=Math.floor(Date.now()/1000),next=Math.max(now,Number(latest.timestamp));
 await ctx.fork.rpc('anvil_setNextBlockTimestamp',[next]);
 await ctx.fork.rpc('anvil_mine',['0x41','0x0']);
}

async function assertQuiescent(ctx,label){
 const lane=await readLiveWalletLane(ctx.db,identityOf(ctx));
 const open=(await ctx.db.query(`SELECT id,status,kind FROM deployment_live_jobs WHERE chain_id=4663 AND wallet=$1
  AND status NOT IN('succeeded','rejected','cancelled')`,[ctx.wallet])).rows;
 assert(!lane.inflight&&!lane.unresolved&&open.length===0,
  `${label}: shared wallet queue is not quiescent: ${JSON.stringify({lane,open})}`);
 const nonce=await ctx.local.getTransactionCount({address:ctx.wallet}),pending=await ctx.local.getTransactionCount({address:ctx.wallet,blockTag:'pending'});
 assert.equal(nonce,pending,`${label}: wallet has an unmined transaction`);
 return {nonce};
}

async function walletTokenMap(ctx){
 const state=await readWalletState(ctx.db,identityOf(ctx));
 return new Map(state.tokens.map(token=>[token.address.toLowerCase(),BigInt(token.balanceRaw)]));
}

async function readStages(ctx,jobId){
 const rows=(await ctx.db.query(`SELECT stage,status,nonce,signed_raw_hash,canonical_receipt_json,effect_evidence_json,allowance_cleanup_json,plan_json,created_at
  FROM deployment_live_stage_outbox WHERE job_id=$1 ORDER BY created_at,stage`,[jobId])).rows;
 return {all:rows,live:rows.filter(row=>row.status!=='cancelled'),cancelled:rows.filter(row=>row.status==='cancelled').length};
}
function receiptRows(ctx,stages){
 return stages.map(row=>{const receipt=row.canonical_receipt_json?.receipt;
  return {stage:row.stage,kind:ctx.decodeBigints(row.plan_json).kind,status:row.status,nonce:String(row.nonce),
   txHash:row.signed_raw_hash,block:receipt?.blockNumber===undefined?null:String(receipt.blockNumber),
   gasUsed:receipt?.gasUsed===undefined?null:String(receipt.gasUsed)};});
}

async function readPosition(ctx,positionManager,tokenId){
 const [position,owner]=await Promise.all([
  ctx.local.readContract({address:positionManager,abi:positionsAbi,functionName:'positions',args:[BigInt(tokenId)]}),
  ctx.local.readContract({address:positionManager,abi:positionsAbi,functionName:'ownerOf',args:[BigInt(tokenId)]}).catch(()=>null)]);
 return {position,owner};
}

/** Everything about one campaign that a sibling's lifecycle must never change. */
async function campaignFingerprint(ctx,campaignId){
 const campaign=await readRangeKeeperLiveCampaign(ctx.db,{...identityOf(ctx),campaignId});
 const commitments=await readCommitments(ctx.db,identityOf(ctx));
 const tokenId=campaign.state?.activeTokenId===null||campaign.state?.activeTokenId===undefined?null:String(campaign.state.activeTokenId);
 let chain=null;
 if(tokenId!==null){const {position,owner}=await readPosition(ctx,campaign.config.pool.positionManager,tokenId);
  chain={owner:owner===null?null:lower(owner),tuple:position.map(String)};}
 return {pool:campaign.config.pool,status:campaign.status,phase:campaign.state?.phase??null,stateHash:campaign.stateHash,tokenId,
  allocation:commitments.allocations.find(row=>row.campaignId===campaignId)??null,
  nftCustody:commitments.nftCustody.filter(row=>row.campaignId===campaignId),chain};
}
function assertFingerprintUnchanged(before,after,label){
 assert.equal(after.stateHash,before.stateHash,`${label}: campaign state hash changed`);
 assert.equal(after.status,before.status,`${label}: campaign status changed`);
 assert.equal(after.phase,before.phase,`${label}: campaign phase changed`);
 assert.deepEqual(after.allocation,before.allocation,`${label}: campaign allocation changed`);
 assert.deepEqual(after.nftCustody,before.nftCustody,`${label}: campaign NFT custody changed`);
 assert.equal(after.tokenId,before.tokenId,`${label}: campaign NFT identity changed`);
 assert.deepEqual(after.chain,before.chain,`${label}: campaign NFT position changed on chain`);
}

/** Run worker turns until every listed job is succeeded. Verifies on every turn that
 * at most one job owns the wallet (single-queue invariant). Never swallows a block. */
export async function driveJobs(ctx,runtime,jobIds,{label,maxTurns=160}={}){
 const pending=new Set(jobIds),turns=[];
 for(let turn=0;turn<maxTurns;turn++){
  for(const id of [...pending]){
   const row=(await ctx.db.query('SELECT status FROM deployment_live_jobs WHERE id=$1',[id])).rows[0];
   if(row?.status==='succeeded')pending.delete(id);
  }
  if(!pending.size)return {ok:true,turns};
  // An opening job is authorized against the persisted wallet snapshot and must start within the frozen
  // observation gap of it. Production re-anchors that snapshot between jobs in its observation turns; the
  // fork has no block production, so do the same before a job's first stage (never mid-job).
  if(turn===0||turns.at(-1)?.status!=='reconciled'){
   const state=await readWalletState(ctx.db,identityOf(ctx));
   if(!state.source||Math.floor(Date.now()/1000)-state.source.timestamp>30){
    try{await refreshLocalSource(ctx);await ctx.observer.refreshWallet();ctx.emit('matrix_wallet_snapshot_refreshed',{label,turn});}
    catch(error){ctx.emit('matrix_wallet_snapshot_refresh_failed',{label,turn,error:shortError(error)});}
   }
  }
  const result=await runtime.worker.execute();
  const inflight=Number((await ctx.db.query(`SELECT count(*)::int n FROM deployment_live_jobs WHERE chain_id=4663 AND wallet=$1
   AND status IN('preflighting','executing','confirming','reconciling')`,[ctx.wallet])).rows[0].n);
  turns.push({turn,status:result.status,jobId:result.jobId??null,stage:result.stage??null,
   reason:result.reason?redact(result.reason).slice(0,300):null,inflightJobs:inflight,
   maintenance:result.maintenanceErrors?.map(item=>redact(item).slice(0,160))});
  ctx.emit('matrix_worker_turn',{label,...turns.at(-1)});
  if(inflight>1)return {ok:false,kind:'queue_invariant',reason:`${inflight} jobs own the wallet at once`,turns};
  if(['blocked','disabled'].includes(result.status))
   return {ok:false,kind:classifyWorkerBlock(result.reason),reason:redact(result.reason??result.status).slice(0,600),jobId:result.jobId??null,turns};
  if(result.status==='idle')return {ok:false,kind:'structural',reason:'worker went idle with unfinished jobs',turns};
 }
 return {ok:false,kind:'structural',reason:'worker turn limit reached',turns};
}

/** The first preflight of a pool pays for its cold state reads through the bounded upstream proxy and can
 * outlive the 90-second candidate or 180-second source window; the fork then holds that state in memory,
 * so the same width is retried (twice at most) before the block is reported as a fixture timing block. */
const TIMING_BLOCKS=[/^owned_fork_candidate_confirmation_expired$/,/^fresh_source_stale$/];
async function preflightLadder(ctx,selected,options,label){
 const {row,view}=selected,attempts=[];
 const widths=options.widths?.length?options.widths:defaultWidthLadder(view.tickSpacing);
 let index=0,warmRetries=0;
 while(index<widths.length){
  const width=widths[index];
  await refreshLocalSource(ctx);
  const started=Date.now();
  const input=rangeKeeperLiveSetupPreflightInput.parse({profileId:row.id,capitalQuoteRaw:String(options.capitalQuoteRaw),
   fullWidthSpacings:width,limits:ctx.preflightLimits});
  const response=await http(ctx,'/api/deployments/rangekeeper/live-setup-preflight',input);
  if(response.status!==200){attempts.push({width,httpStatus:response.status,ms:Date.now()-started,class:'structural',
   missing:[`http_${response.status}`]});break;}
  const body=response.body;
  if(body.status==='indicative'){
   const persisted=body.reviewPersistence;
   attempts.push({width,status:'indicative',ms:Date.now()-started,reviewPersistence:persisted?.status,admissionAvailable:body.admissionAvailable});
   assert.equal(body.executionEligible,false,`${label}: preflight claimed execution eligibility`);
   assert.equal(body.admissionAvailable,true,`${label}: HTTP admission is not available`);
   return {body,width,attempts};
  }
  const reason=String(body.missing?.[0]??'unknown'),klass=classifyPreflightBlock(reason);
  attempts.push({width,status:body.status,missing:body.missing,class:klass,ms:Date.now()-started});
  ctx.emit('matrix_preflight_block',{label,width,reason,class:klass,ms:Date.now()-started});
  if(klass==='fixture'&&TIMING_BLOCKS.some(pattern=>pattern.test(reason))&&warmRetries<2){warmRetries++;continue;}
  if(klass!=='market_width_sensitive')break;
  index++;
 }
 return {body:null,attempts};
}

async function admitReview(ctx,persisted){
 const input={reviewId:persisted.reviewId,reviewHash:persisted.reviewHash,requestId:randomUUID()};
 const first=await http(ctx,'/api/deployments/rangekeeper/live-setup-admit',input);
 assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(first.body.status,'queued');
 const replay=await http(ctx,'/api/deployments/rangekeeper/live-setup-admit',input);
 assert.equal(replay.status,200,JSON.stringify(replay.body));assert.deepEqual(replay.body,{...first.body,replayed:true});
 return first.body;
}

/** The reserved allocation must be exactly what the review required, and the
 * wallet's free inventory must have dropped by exactly that much. */
function assertReservation(ctx,{freeBefore,freeAfter,commitments,campaignId,requirements,view,label}){
 const allocation=commitments.allocations.find(row=>row.campaignId===campaignId);
 assert(allocation,`${label}: allocation was not reserved`);
 const amountOf=address=>{const row=allocation.tokens.find(token=>lower(token.address)===lower(address));return row?BigInt(row.allocatedRaw)+BigInt(row.pendingSpendRaw):0n;};
 assert.equal(amountOf(view.token0),BigInt(requirements.token0Raw),`${label}: token0 reservation differs from review`);
 assert.equal(amountOf(view.token1),BigInt(requirements.token1Raw),`${label}: token1 reservation differs from review`);
 const nativeReserved=BigInt(allocation.nativeSpendWei)+BigInt(allocation.pendingNativeSpendWei)+BigInt(allocation.exitReserveWei);
 assert.equal(nativeReserved,BigInt(requirements.nativeWei),`${label}: native reservation differs from review`);
 for(const [address,freeRaw] of Object.entries(freeBefore.tokens)){
  assert.equal(BigInt(freeRaw)-BigInt(freeAfter.tokens[address]??'0'),amountOf(address),`${label}: free token inventory not conserved for ${address}`);
 }
 assert.equal(BigInt(freeBefore.nativeWei)-BigInt(freeAfter.nativeWei),nativeReserved,`${label}: free native inventory not conserved`);
 return {allocationId:allocation.allocationId,tokens:allocation.tokens,nativeReservedWei:String(nativeReserved)};
}

/** Verify an opened campaign against the frozen review and canonical chain state. */
async function verifyOpened(ctx,runtime,{campaignId,jobId,body,view,tokensBefore,involvedTokens,freeAfterAdmission,label,activePools,initialNonzero,checkAllowances=true}){
 let campaign=await readRangeKeeperLiveCampaign(ctx.db,{...identityOf(ctx),campaignId,revision:1});
 for(let attempt=0;attempt<2&&campaign.status==='opening';attempt++){
  // Queue finish and the campaign handoff are separate idempotent effects.
  await runtime.worker.execute();campaign=await readRangeKeeperLiveCampaign(ctx.db,{...identityOf(ctx),campaignId,revision:1});
 }
 assert.equal(campaign.status,'active',`${label}: campaign did not become active`);
 assert.equal(campaign.state?.phase,'holding',`${label}: campaign is not holding`);assert(campaign.state?.activeTokenId,`${label}: no active NFT`);
 const stages=await readStages(ctx,jobId),live=stages.live;
 assert(live.length>0&&live.every(row=>row.status==='confirmed'&&row.canonical_receipt_json&&row.effect_evidence_json),
  `${label}: every submitted stage needs canonical receipt evidence`);
 assert.equal(new Set(live.map(row=>row.signed_raw_hash)).size,live.length,`${label}: stage transaction hashes must be unique`);
 const kinds=allowancePolicy.summarizeStagePolicy(live,{decode:ctx.decodeBigints});
 assert(kinds.economic.includes('mint'),`${label}: no mint stage: ${kinds.kinds.join(',')}`);
 if(body.candidate.swap)assert(kinds.economic.includes('swap'),`${label}: reviewed swap was never executed: ${kinds.kinds.join(',')}`);
 const state=campaign.state,costHashes=state.costEvents.map(cost=>String(cost.hash).toLowerCase());
 assert.equal(costHashes.length,live.length,`${label}: every canonical stage receipt must be charged exactly once`);
 assert.equal(new Set(costHashes).size,costHashes.length,`${label}: receipt economics were replayed`);
 assert.deepEqual(new Set(costHashes),new Set(live.map(row=>String(row.signed_raw_hash).toLowerCase())));
 const pool=campaign.config.pool,{position,owner}=await readPosition(ctx,pool.positionManager,state.activeTokenId);
 assert.equal(lower(owner),ctx.wallet,`${label}: NFT is not held by the shared wallet`);
 assert(position[7]>0n,`${label}: minted position has no liquidity`);
 assert.equal(lower(position[2]),lower(view.token0));assert.equal(lower(position[3]),lower(view.token1));assert.equal(position[4],view.fee);
 assert.equal(position[5],body.range.tickLower,`${label}: minted tickLower differs from the reviewed range`);
 assert.equal(position[6],body.range.tickUpper,`${label}: minted tickUpper differs from the reviewed range`);
 // Single-campaign flows compare the free inventory right after admission; concurrent flows
 // (freeAfterAdmission null) compare the free inventory after every campaign opened instead.
 if(freeAfterAdmission)assert.deepEqual(await ctx.readFreeCapital(),freeAfterAdmission,`${label}: opening changed free wallet capital outside the campaign allocation`);
 const involved=involvedTokens??new Set([lower(view.token0),lower(view.token1)]);
 const afterTokens=await walletTokenMap(ctx);
 for(const [address,balance] of afterTokens){
  if(involved.has(address))continue;
  assert.equal(balance,tokensBefore.get(address),`${label}: unrelated registered token balance changed: ${address}`);
 }
 // The wallet-wide allowance state corresponds to the proof of the LAST job that ran, so concurrent
 // jobs are checked once, by the caller, against the final executed job.
 const allowance=checkAllowances?await allowancePolicy.assertAllowancePolicyAfterJob(ctx,{label:`${label}:open`,stages:live,activePools:activePools??[pool]}):null;
 // A single job is shape-checked here; concurrent jobs are checked together, in execution order, by the caller.
 const approvalShape=initialNonzero?allowancePolicy.assertOpenApprovalShapes([{label,stages:live,pool,candidate:body.candidate}],
  {decode:ctx.decodeBigints,initialNonzero})[0]:null;
 return {campaign,pool,rawStages:live,tokenId:String(state.activeTokenId),liquidity:String(position[7]),tickLower:position[5],tickUpper:position[6],
  stages:receiptRows(ctx,live),cancelledStages:stages.cancelled,stageKinds:kinds,allowance,approvalShape,stageCount:live.length,costHashes};
}

/** Why a campaign's latest valuation mark is not usable by the projection: reference status, missing reasons
 * and every stale/unfresh flag inside the stored reference proof. Diagnostic only. */
export async function diagnoseLatestMark(db,campaignId,decode){
 const row=(await db.query(`SELECT payload,source_block FROM deployment_live_runtime_events WHERE campaign_id=$1 AND kind IN('mark','closed')
  ORDER BY sequence DESC LIMIT 1`,[campaignId])).rows[0];
 if(!row)return {mark:null};
 const stored=decode(row.payload),payload=stored.terminalValuation??stored,refs=payload.referenceValuation??{},stale=[];
 const visit=(value,path)=>{
  if(Array.isArray(value))return value.forEach((entry,index)=>visit(entry,`${path}[${index}]`));
  if(!value||typeof value!=='object')return;
  for(const [key,entry] of Object.entries(value)){
   if(key==='priceFresh'&&entry!==true||key==='fresh'&&entry===false)stale.push(`${path}.${key}=${entry}`);
   visit(entry,`${path}.${key}`);
  }
 };
 visit(refs.evidence?.referenceProof,'referenceProof');
 return {kind:payload.kind,referenceStatus:refs.status,missing:payload.missing,referenceMissing:refs.missing,
  hasPosition:payload.snapshot?.position!=null,positionFeeEvidenceKind:payload.positionFeeEvidence?.kind??payload.positionFeeEvidence?.status??null,
  positionFeeMissing:payload.positionFeeEvidence?.missing,staleFlags:stale.slice(0,12),
  proofSource:refs.source,markSource:payload.source,evidenceKind:refs.evidence?.kind};
}

/** The independent reference was eligible for the strategy (latest-equity-session policy accepts a closed-market
 * price) but its oracle is past its feed heartbeat (`priceFresh=false`), which the Positions accounting
 * deliberately refuses to value. That is a market-session state, not a lifecycle defect. */
export const marketClosedStaleReference=diagnostic=>diagnostic?.referenceStatus==='available'&&
 Array.isArray(diagnostic.staleFlags)&&diagnostic.staleFlags.length>0&&diagnostic.staleFlags.every(flag=>/priceFresh=false$/.test(flag));

/** Dashboard projections of a holding campaign (Positions API). Reported as a soft check. */
async function checkHoldingProjection(ctx,campaignIds){
 const marketBlocked=[];
 const response=await getJson(ctx,'/api/positions');
 assert.equal(response.status,200,JSON.stringify(response.body));
 const holdings=response.body.positions.filter(position=>campaignIds.includes(position.deployment?.campaignId));
 assert.equal(holdings.length,campaignIds.length,'Actual Positions API omitted a live campaign');
 for(const position of holdings){
  if(position.accounting!=='recorded'){
   const diagnostic=await diagnoseLatestMark(ctx.db,position.deployment.campaignId,ctx.decodeBigints);
   if(marketClosedStaleReference(diagnostic)){marketBlocked.push({campaignId:position.deployment.campaignId,reasons:position.reasons,staleFlags:diagnostic.staleFlags});continue;}
   throw new Error(`Holding economics unavailable for ${position.deployment?.campaignId}: ${JSON.stringify(position.reasons)} mark=${JSON.stringify(diagnostic)}`);
  }
  assert([position.navQuote,position.feesQuote,position.gasQuote,position.holdQuote].every(value=>typeof value==='string'),
   `Holding economics remain unavailable: ${JSON.stringify(position)}`);
 }
 return {campaigns:holdings.length,marketBlocked:marketBlocked.length?marketBlocked:undefined};
}
async function checkClosedProjection(ctx,campaignId){
 const response=await getJson(ctx,`/api/positions/live-dep-${campaignId}?hours=0`);
 assert.equal(response.status,200);const detail=response.body;
 assert.equal(detail.position.status,'closed');
 if(detail.position.accounting!=='recorded'){
  const diagnostic=await diagnoseLatestMark(ctx.db,campaignId,ctx.decodeBigints);
  if(marketClosedStaleReference(diagnostic))return {marketBlocked:{reasons:detail.position.reasons,staleFlags:diagnostic.staleFlags}};
  throw new Error(`Terminal economics unavailable: ${JSON.stringify(detail.position.reasons)} mark=${JSON.stringify(diagnostic)}`);
 }
 assert(typeof detail.position.navQuote==='string'&&typeof detail.position.gasQuote==='string','Terminal economics were not retained');
 assert(detail.performance?.markCount>=2&&detail.performance?.rows?.some(row=>typeof row.netPnlQuote==='string'),
  `Live history remains unavailable: ${JSON.stringify(detail.performance)}`);
 return {navQuote:detail.position.navQuote,gasQuote:detail.position.gasQuote,markCount:detail.performance.markCount};
}

/** HTTP retained close of one campaign beside optional active siblings. */
export async function retainClose(ctx,runtime,{campaignId,label,openCostEvents,siblingIds=[],phase}){
 const evidence={campaignId};
 const nonzeroBefore=await allowancePolicy.readNonzeroAllowanceKeys(ctx);
 await refreshLocalSource(ctx);
 const observed=await ctx.observer.observeHoldingCampaigns();
 assert.equal(observed.status,'observed',JSON.stringify(observed));
 assert.deepEqual(observed.missing,[],`${label}: holding observation was incomplete`);
 const holding=Number((await ctx.db.query(`SELECT count(*)::int n FROM deployment_campaigns c JOIN deployment_live_campaign_runtime m
  ON m.campaign_id=c.id AND m.revision=c.current_revision WHERE c.chain_id=4663 AND lower(c.wallet)=$1 AND c.mode='live' AND c.lifecycle='active'`,[ctx.wallet])).rows[0].n);
 assert.equal(observed.recorded,holding,`${label}: not every holding campaign was marked: ${JSON.stringify(observed)}`);
 evidence.holdingMarksRecorded=observed.recorded;
 evidence.holdingProjection=await phase('dashboard_holding',()=>checkHoldingProjection(ctx,[campaignId,...siblingIds]),{soft:true});
 const siblingsBefore=new Map();
 for(const id of siblingIds)siblingsBefore.set(id,await campaignFingerprint(ctx,id));
 const positionBefore=await campaignFingerprint(ctx,campaignId);
 await refreshLocalSource(ctx);
 const preview=await http(ctx,`/api/deployments/${campaignId}/live/retain-preview`,{});
 assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.status,'indicative',JSON.stringify(preview.body));
 assert.equal(preview.body.actionAvailable,true,JSON.stringify(preview.body));assert.equal(preview.body.executionEligible,false);
 const input={previewId:preview.body.previewId,contentDigest:preview.body.contentDigest,expectedRevision:preview.body.expectedRevision,idempotencyKey:randomUUID()};
 const path=`/api/deployments/${campaignId}/live/retain-operations`;
 const retained=await http(ctx,path,input);assert.equal(retained.status,202,JSON.stringify(retained.body));
 const replayBefore=await http(ctx,path,input);
 assert.equal(replayBefore.status,200);assert.equal(replayBefore.body.jobId,retained.body.jobId);
 evidence.jobId=retained.body.jobId;
 const driven=await driveJobs(ctx,runtime,[retained.body.jobId],{label:`${label}:retain`});
 evidence.turns=driven.turns.length;
 if(!driven.ok){evidence.blocked=driven;return {ok:false,evidence,driven};}
 let closed;
 for(let attempt=0;attempt<3;attempt++){
  closed=(await ctx.db.query(`SELECT c.lifecycle,r.state_json,r.state_hash FROM deployment_campaigns c
   JOIN deployment_live_campaign_runtime r ON r.campaign_id=c.id AND r.revision=c.current_revision WHERE c.id=$1`,[campaignId])).rows[0];
  if(closed?.lifecycle==='closed')break;
  await runtime.worker.execute();
 }
 assert.equal(closed?.lifecycle,'closed',`${label}: campaign did not close`);
 const closedState=ctx.decodeBigints(closed.state_json);
 assert.equal(closedState.phase,'closed');assert.equal(closedState.activeTokenId,null);
 const stages=await readStages(ctx,retained.body.jobId);
 const siblingPools=[...siblingsBefore.values()].map(item=>item.pool);
 evidence.closeShape=allowancePolicy.assertRetainStagePlans(stages.live,{decode:ctx.decodeBigints,label,nonzeroBefore,
  closingPool:positionBefore.pool,siblingPools});
 assert.equal(closedState.costEvents.length,openCostEvents+stages.live.length,`${label}: retain receipt costs were omitted or duplicated`);
 assert.equal(new Set(closedState.costEvents.map(event=>event.hash)).size,closedState.costEvents.length);
 assert.equal((await ctx.db.query('SELECT state FROM deployment_live_allocations WHERE campaign_id=$1',[campaignId])).rows[0]?.state,'released',
  `${label}: allocation was not released`);
 const commitments=await readCommitments(ctx.db,identityOf(ctx));
 assert(!commitments.allocations.some(row=>row.campaignId===campaignId),`${label}: released allocation is still a wallet commitment`);
 const retiredRow=commitments.nftCustody.find(row=>row.tokenId===positionBefore.tokenId);
 assert.equal(retiredRow?.status,'retired_empty',`${label}: closed campaign NFT is not retired_empty`);
 assert.equal(BigInt(retiredRow.liquidity),0n);
 evidence.allowance=await allowancePolicy.assertAllowancePolicyAfterClose(ctx,{label:`${label}:close`,retainStages:stages.live,siblingPools});
 for(const [id,before] of siblingsBefore)assertFingerprintUnchanged(before,await campaignFingerprint(ctx,id),`${label}: sibling ${id}`);
 const replayAfter=await http(ctx,path,input);
 assert.equal(replayAfter.status,200);assert.equal(replayAfter.body.jobId,retained.body.jobId,`${label}: closed campaign retry created a new job`);
 evidence.closedProjection=await phase('dashboard_closed',()=>checkClosedProjection(ctx,campaignId),{soft:true});
 evidence.siblingsUnchanged=siblingIds;
 evidence.stages=receiptRows(ctx,stages.live);evidence.stageCount=stages.live.length;evidence.cancelledStages=stages.cancelled;
 return {ok:true,evidence};
}

/** The whole HTTP lifecycle of ONE registered profile, one campaign on the shared wallet. */
export async function runProfileLifecycle(ctx,selected,options){
 const {view}=selected,label=`${view.symbol}:${view.fee}`;
 const rec={label,profile:view,capitalQuoteRaw:String(options.capitalQuoteRaw),width:null,attempts:[],phases:{},softFailures:[],
  outcome:'running',reason:null,failurePhase:null,admitted:false,closed:false,openStages:[],closeStages:[]};
 const phase=async(name,fn,{soft=false}={})=>{
  const started=Date.now();ctx.emit('matrix_phase_start',{label,phase:name});
  try{const result=await fn();rec.phases[name]={ok:true,ms:Date.now()-started};ctx.emit('matrix_phase_done',{label,phase:name,ms:Date.now()-started});return result;}
  catch(error){
   rec.phases[name]={ok:false,ms:Date.now()-started,error:shortError(error)};ctx.emit('matrix_phase_failed',{label,phase:name,error:shortError(error)});
   if(soft){rec.softFailures.push({phase:name,error:shortError(error)});return {failed:true,error:shortError(error)};}
   error.matrixPhase=name;throw error;
  }
 };
 try{
  const quiet=await phase('quiescent',()=>assertQuiescent(ctx,label));rec.walletNonceBefore=quiet.nonce;
  const ladder=await phase('preflight',()=>preflightLadder(ctx,selected,options,label));
  rec.attempts=ladder.attempts;
  if(!ladder.body){
   const last=ladder.attempts.at(-1),klass=last?.class??'structural';
   rec.reason=String(last?.missing?.[0]??'preflight_unavailable');rec.failurePhase='preflight';
   rec.outcome=klass.startsWith('market')?'MARKET_BLOCK':klass==='fixture'?'FIXTURE_BLOCK':klass==='infra'?'INFRA_BLOCK':'FAIL';
   return rec;
  }
  const body=ladder.body;rec.width=ladder.width;
  // The preflight persisted the first wallet snapshot (when none existed): inventory baseline for this profile.
  const tokensBefore=await walletTokenMap(ctx);
  const persisted=body.reviewPersistence;assert.equal(persisted?.status,'persisted',JSON.stringify(persisted));
  rec.review={source:body.source,requirements:body.requirements,range:body.range,
   swap:body.candidate.swap?{token:body.candidate.swap.token,amountIn:body.candidate.swap.amountIn}:null,
   liquidity:body.candidate.liquidity,deployedValue:body.candidate.deployedValue,
   costs:{actionGasWei:body.costs.actionGasWei,managementGasReserveWei:body.costs.managementGasReserveWei,exitReserveWei:body.costs.exitReserveWei}};
  const freeBefore=await ctx.readFreeCapital();
  const initialNonzero=await allowancePolicy.readNonzeroAllowanceKeys(ctx);
  const admission=await phase('admission',()=>admitReview(ctx,persisted));
  rec.admitted=true;rec.campaignId=admission.campaignId;rec.jobId=admission.jobId;
  const freeAfterAdmission=await ctx.readFreeCapital();
  rec.reservation=await phase('reservation',async()=>assertReservation(ctx,{freeBefore,freeAfter:freeAfterAdmission,
   commitments:await readCommitments(ctx.db,identityOf(ctx)),campaignId:admission.campaignId,requirements:body.requirements,view,label}));
  const opened=await phase('open',async()=>{
   const driven=await driveJobs(ctx,ctx.worker,[admission.jobId],{label:`${label}:open`});
   if(!driven.ok){const error=new Error(`open_worker_${driven.kind}: ${driven.reason}`);error.workerBlock=driven;throw error;}
   return verifyOpened(ctx,ctx.worker,{campaignId:admission.campaignId,jobId:admission.jobId,body,view,tokensBefore,freeAfterAdmission,label,initialNonzero});
  });
  rec.openStages=opened.stages;rec.openStageKinds=opened.stageKinds.kinds;rec.tokenId=opened.tokenId;rec.liquidity=opened.liquidity;
  rec.minted={tickLower:opened.tickLower,tickUpper:opened.tickUpper};rec.cancelledOpenStages=opened.cancelledStages;
  rec.allowanceObservations=[opened.allowance];rec.openApprovalShape=opened.approvalShape;
  rec.nonzeroApproveProbe=await phase('nonzero_approve_probe',()=>allowancePolicy.probeNonzeroToNonzeroApprove(ctx));
  const closeResult=await phase('retain_close',async()=>{
   const result=await retainClose(ctx,ctx.worker,{campaignId:admission.campaignId,label,openCostEvents:opened.stageCount,phase});
   if(!result.ok){const error=new Error(`retain_worker_${result.driven.kind}: ${result.driven.reason}`);error.workerBlock=result.driven;throw error;}
   return result;
  });
  rec.closeStages=closeResult.evidence.stages;rec.closeApprovalShape=closeResult.evidence.closeShape;rec.closeEvidence={jobId:closeResult.evidence.jobId,turns:closeResult.evidence.turns,
   holdingProjection:closeResult.evidence.holdingProjection,closedProjection:closeResult.evidence.closedProjection};
  rec.allowanceObservations.push(closeResult.evidence.allowance);
  rec.closed=true;
  const afterTokens=await walletTokenMap(ctx);
  rec.retainedInventory={};
  for(const address of [lower(view.token0),lower(view.token1)])
   rec.retainedInventory[address]={before:String(tokensBefore.get(address)??0n),after:String(afterTokens.get(address)??0n)};
  rec.outcome=rec.softFailures.length?'FAIL':'PASS';
  if(rec.softFailures.length){rec.failurePhase=rec.softFailures[0].phase;rec.reason=`dashboard projection: ${rec.softFailures[0].phase}`;}
  return rec;
 }catch(error){
  rec.failurePhase=error.matrixPhase??rec.failurePhase??'unknown';
  rec.error=shortError(error);
  const block=error.workerBlock;
  if(block&&block.kind==='market'){rec.outcome='MARKET_BLOCK';rec.reason=block.reason;}
  else{rec.outcome='FAIL';rec.reason=redact(error.message).slice(0,500);}
  // After admission a failure leaves a reserved allocation or an unfinished job on the wallet.
  rec.dirty=rec.admitted&&!rec.closed;
  return rec;
 }
}

/** Run the selected profiles in order. A failure after admission leaves the shared
 * wallet dirty, so the remaining profiles are reported as not_run unless asked to continue. */
export async function runProfileMatrix(ctx,selections,options){
 const results=[];let dirty=null;
 for(const selected of selections){
  const label=`${selected.view.symbol}:${selected.view.fee}`;
  if(dirty&&!options.continueAfterFailure){
   results.push({label,profile:selected.view,outcome:'NOT_RUN',reason:`shared wallet left dirty by ${dirty}`});continue;
  }
  const rec=await runProfileLifecycle(ctx,selected,{...options,widths:options.widthOverrides?.get(label)});
  results.push(rec);ctx.emit('matrix_profile_result',{label,outcome:rec.outcome,reason:rec.reason,width:rec.width});
  if(rec.dirty)dirty=label;
 }
 return results;
}

/** Concurrency scenarios (a)-(d) on one wallet.
 *  (a) three campaigns on different pools sharing USDG, admitted back to back, executed by the single queue
 *  (b) two fee tiers sharing the same risky token
 *  (c) closing one campaign while the others stay active and unchanged
 *  (d) insufficient combined native gas blocks the next admission with a concrete shortfall */
export async function runConcurrencyScenarios(ctx,selections,options){
 assert.equal(selections.length,3,'Concurrency scenarios need exactly three profiles');
 const labels=selections.map(({view})=>`${view.symbol}:${view.fee}`);
 const out={profiles:labels,members:[],checks:{},softFailures:[]};
 const phase=async(name,fn,{soft=false}={})=>{
  const started=Date.now();ctx.emit('concurrency_phase_start',{phase:name});
  try{const result=await fn();ctx.emit('concurrency_phase_done',{phase:name,ms:Date.now()-started});return result;}
  catch(error){ctx.emit('concurrency_phase_failed',{phase:name,error:shortError(error)});
   if(soft){out.softFailures.push({phase:name,error:shortError(error)});return {failed:true};}
   error.matrixPhase=name;throw error;}
 };
 try{
  const quiet=await phase('quiescent',()=>assertQuiescent(ctx,'concurrency'));out.walletNonceBefore=quiet.nonce;
  // Calibrate native gas: one non-admitted probe preflight per member gives its exact reservation.
  const widths=[],requirements=[];
  const probes=[];
  for(const [index,selected] of selections.entries()){
   const probe=await phase(`probe_${labels[index]}`,()=>preflightLadder(ctx,selected,{...options,widths:options.widthOverrides?.get(labels[index])},labels[index]));
   assert(probe.body,`${labels[index]}: probe preflight blocked: ${JSON.stringify(probe.attempts)}`);
   widths.push(probe.width);requirements.push(BigInt(probe.body.requirements.nativeWei));probes.push(probe.attempts);
  }
  // Probes persisted the first wallet snapshot: inventory baseline for the unrelated-token check.
  const tokensBefore=await walletTokenMap(ctx);
  const minimum=requirements.reduce((a,b)=>a<b?a:b),total=requirements.reduce((a,b)=>a+b,0n);
  // Free native for exactly three reservations plus 40% of the smallest one: a fourth must be refused.
  const nativeTarget=total+minimum*4n/10n;
  out.nativeCalibration={perMemberReservationWei:requirements.map(String),combinedWei:String(total),walletNativeWei:String(nativeTarget)};
  await ctx.fork.rpc('anvil_setBalance',[ctx.wallet,`0x${nativeTarget.toString(16)}`]);
  const nonceBeforeAdmissions=await ctx.local.getTransactionCount({address:ctx.wallet});
  const initialNonzeroKeys=await allowancePolicy.readNonzeroAllowanceKeys(ctx);
  // (a) back-to-back admissions: preflight -> persisted review -> HTTP admission, no worker turns between.
  const admitted=[];
  for(const [index,selected] of selections.entries()){
   const label=labels[index],view=selected.view;
   const ladder=await phase(`preflight_${label}`,()=>preflightLadder(ctx,selected,{...options,widths:[widths[index]]},label));
   assert(ladder.body,`${label}: preflight blocked after native calibration: ${JSON.stringify(ladder.attempts)}`);
   const persisted=ladder.body.reviewPersistence;assert.equal(persisted?.status,'persisted',JSON.stringify(persisted));
   const freeBefore=await ctx.readFreeCapital();
   const admission=await phase(`admission_${label}`,()=>admitReview(ctx,persisted));
   const freeAfter=await ctx.readFreeCapital();
   const reservation=assertReservation(ctx,{freeBefore,freeAfter,commitments:await readCommitments(ctx.db,identityOf(ctx)),
    campaignId:admission.campaignId,requirements:ladder.body.requirements,view,label});
   admitted.push({label,view,body:ladder.body,width:ladder.width,admission,reservation,freeAfter});
   out.members.push({label,width:ladder.width,campaignId:admission.campaignId,jobId:admission.jobId,allocationId:admission.allocationId,
    requirements:ladder.body.requirements,quoteSide:view.quoteSide,fee:view.fee,tickSpacing:view.tickSpacing});
  }
  const commitmentsAfterAdmissions=await readCommitments(ctx.db,identityOf(ctx));
  const allocationIds=admitted.map(item=>item.admission.allocationId);
  assert.equal(new Set(allocationIds).size,3,'Concurrent campaigns share an allocation');
  assert.equal(new Set(admitted.map(item=>item.admission.campaignId)).size,3);
  assert.equal(commitmentsAfterAdmissions.allocations.filter(row=>admitted.some(item=>item.admission.campaignId===row.campaignId)).length,3);
  const quote=lower(ctx.operatorConfig.pool.token0);
  for(const item of admitted){
   const row=commitmentsAfterAdmissions.allocations.find(entry=>entry.campaignId===item.admission.campaignId);
   assert(row.tokens.some(token=>lower(token.address)===quote&&BigInt(token.allocatedRaw)>0n),`${item.label}: USDG is not independently allocated`);
  }
  out.checks.backToBackAdmissions={admitted:3,distinctAllocations:3,sharedQuoteToken:quote,
   freeAfterAdmissions:admitted.at(-1).freeAfter};
  // (d) the next admission blocks with a concrete native-gas shortfall.
  const shortfallSelection=selections[0],shortfallLabel=`${labels[0]}#4`;
  const freeBeforeShortfall=await ctx.readFreeCapital();
  const campaignsBefore=Number((await ctx.db.query(`SELECT count(*)::int n FROM deployment_campaigns WHERE chain_id=4663 AND lower(wallet)=$1`,[ctx.wallet])).rows[0].n);
  await refreshLocalSource(ctx);
  const shortInput=rangeKeeperLiveSetupPreflightInput.parse({profileId:shortfallSelection.row.id,capitalQuoteRaw:String(options.capitalQuoteRaw),
   fullWidthSpacings:widths[0],limits:ctx.preflightLimits});
  const short=await phase('native_shortfall_preflight',async()=>http(ctx,'/api/deployments/rangekeeper/live-setup-preflight',shortInput));
  assert.equal(short.status,200,JSON.stringify(short.body));
  assert.equal(short.body.status,'unavailable',`${shortfallLabel}: a fourth campaign was not blocked: ${JSON.stringify(short.body.missing)}`);
  assert.equal(short.body.missing?.[0],'native_gas_allocation_shortfall',`${shortfallLabel}: unexpected block reason ${JSON.stringify(short.body.missing)}`);
  assert.notEqual(short.body.reviewPersistence?.status,'persisted',`${shortfallLabel}: a blocked preflight persisted a review`);
  const campaignsAfter=Number((await ctx.db.query(`SELECT count(*)::int n FROM deployment_campaigns WHERE chain_id=4663 AND lower(wallet)=$1`,[ctx.wallet])).rows[0].n);
  assert.equal(campaignsAfter,campaignsBefore,'The blocked fourth admission created a campaign');
  const freeAfterShortfall=await ctx.readFreeCapital();
  assert.equal(freeAfterShortfall.nativeWei,freeBeforeShortfall.nativeWei,'The blocked admission changed free native inventory');
  const neededNative=requirements[0];
  assert(BigInt(freeAfterShortfall.nativeWei)<neededNative,'Free native gas is not actually below one more reservation');
  out.checks.nativeGasShortfall={reason:short.body.missing[0],freeNativeWei:freeAfterShortfall.nativeWei,
   requiredNativeWei:String(neededNative),shortfallWei:String(neededNative-BigInt(freeAfterShortfall.nativeWei)),
   campaignCountUnchanged:true,freeInventoryUnchanged:true};
  // Execute all three through the single wallet queue.
  const driven=await phase('execute_queue',()=>driveJobs(ctx,ctx.worker,admitted.map(item=>item.admission.jobId),{label:'concurrency:open',maxTurns:400}));
  if(!driven.ok){const error=new Error(`concurrent_open_${driven.kind}: ${driven.reason}`);error.workerBlock=driven;throw error;}
  const nonceRows=(await ctx.db.query(`SELECT o.nonce,o.status,o.job_id,o.stage,o.created_at FROM deployment_live_stage_outbox o
   WHERE o.chain_id=4663 AND o.wallet=$1 AND o.status<>'cancelled' ORDER BY o.nonce`,[ctx.wallet])).rows;
  const nonces=nonceRows.map(row=>Number(row.nonce));
  assert.equal(new Set(nonces).size,nonces.length,'Wallet-wide transaction nonces collided');
  nonces.forEach((nonce,i)=>assert.equal(nonce,nonceBeforeAdmissions+i,'Wallet nonces are not one contiguous queue sequence'));
  const byCreation=[...nonceRows].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
  const order=[];for(const row of byCreation)if(order.at(-1)!==row.job_id)order.push(row.job_id);
  const interleaved=order.length!==new Set(order).size;
  out.checks.singleQueueExecution={jobs:3,stages:nonces.length,firstNonce:nonces[0],lastNonce:nonces.at(-1),nonceUnique:true,nonceContiguous:true,
   neverMoreThanOneInflightJob:driven.turns.every(turn=>turn.inflightJobs<=1),jobOrder:order.map(id=>admitted.find(item=>item.admission.jobId===id)?.label),
   stageInterleavingAcrossJobs:interleaved,turns:driven.turns.length};
  const opened=[];
  const involvedTokens=new Set(admitted.flatMap(item=>[lower(item.view.token0),lower(item.view.token1)]));
  const activePools=[];
  for(const item of admitted)activePools.push((await readRangeKeeperLiveCampaign(ctx.db,{...identityOf(ctx),campaignId:item.admission.campaignId})).config.pool);
  for(const item of admitted){
   const verified=await phase(`verify_open_${item.label}`,()=>verifyOpened(ctx,ctx.worker,{campaignId:item.admission.campaignId,jobId:item.admission.jobId,
    body:item.body,view:item.view,tokensBefore,involvedTokens,freeAfterAdmission:null,label:item.label,activePools,checkAllowances:false}));
   opened.push({...item,verified});
  }
  // Approval counts per job, replayed in execution order from the wallet's allowance state before the jobs ran.
  const ordered=[...opened].sort((a,b)=>new Date(a.verified.rawStages[0].created_at)-new Date(b.verified.rawStages[0].created_at));
  out.checks.walletAllowancesAfterOpens=await allowancePolicy.assertAllowancePolicyAfterJob(ctx,{label:'concurrency:opens',
   stages:ordered.at(-1).verified.rawStages,activePools});
  out.checks.openApprovalShapes=allowancePolicy.assertOpenApprovalShapes(ordered.map(item=>({label:item.label,stages:item.verified.rawStages,
   pool:item.verified.pool,candidate:item.body.candidate})),{decode:ctx.decodeBigints,initialNonzero:initialNonzeroKeys});
  out.checks.nonzeroApproveProbe=await phase('nonzero_approve_probe',()=>allowancePolicy.probeNonzeroToNonzeroApprove(ctx));
  out.members=out.members.map(member=>{const item=opened.find(entry=>entry.label===member.label);
   return {...member,tokenId:item.verified.tokenId,liquidity:item.verified.liquidity,openStages:item.verified.stages,openStageKinds:item.verified.stageKinds.kinds};});
  assert.deepEqual(await ctx.readFreeCapital(),admitted.at(-1).freeAfter,'Concurrent opens spent capital outside their reserved allocations');
  // Independent NFTs and per-token attribution across campaigns sharing a risky token.
  const commitments=await readCommitments(ctx.db,identityOf(ctx));
  const activeNfts=commitments.nftCustody.filter(row=>row.status==='active');
  assert.equal(activeNfts.length,3,'Three active campaign NFTs are not represented in wallet custody');
  assert.equal(new Set(opened.map(item=>item.verified.tokenId)).size,3,'Campaigns reused one NFT token ID');
  for(const item of opened)assert(activeNfts.some(row=>row.tokenId===item.verified.tokenId&&row.campaignId===item.admission.campaignId),`${item.label}: NFT custody not attributed`);
  const balances=await walletTokenMap(ctx);
  const sharedRisky=new Map();
  for(const item of opened){const riskyAddress=lower(item.view.quoteSide==='token0'?item.view.token1:item.view.token0);
   sharedRisky.set(riskyAddress,[...(sharedRisky.get(riskyAddress)??[]),item.label]);}
  const attribution={};
  for(const [address,members] of sharedRisky){
   const allocated=commitments.allocations.reduce((sum,row)=>sum+row.tokens.filter(t=>lower(t.address)===address).reduce((s,t)=>s+BigInt(t.allocatedRaw)+BigInt(t.pendingSpendRaw),0n),0n);
   const walletBalance=balances.get(address)??0n;
   assert(allocated<=walletBalance,`Allocated risky inventory exceeds the wallet balance for ${address}`);
   attribution[address]={campaigns:members,allocatedRaw:String(allocated),walletBalanceRaw:String(walletBalance)};
  }
  const sharedRiskyAddress=[...sharedRisky.entries()].find(([,members])=>members.length>1);
  assert(sharedRiskyAddress,'No two campaigns share a risky token');
  const positions=[];
  for(const item of opened){
   const campaign=await readRangeKeeperLiveCampaign(ctx.db,{...identityOf(ctx),campaignId:item.admission.campaignId});
   const {position}=await readPosition(ctx,campaign.config.pool.positionManager,item.verified.tokenId);
   positions.push({label:item.label,pool:campaign.config.pool.pool,fee:position[4],tokenId:item.verified.tokenId});
  }
  assert.equal(new Set(positions.map(position=>lower(position.pool))).size,3,'Concurrent campaigns are not on three different pools');
  out.checks.sharedRiskyToken={token:sharedRiskyAddress[0],campaigns:sharedRiskyAddress[1],attribution,positions,independentNfts:3};
  out.checks.allocationIndependence={allocationIds,quoteTokenShared:quote};
  // (c) close one campaign while the others stay active; then close the rest, always beside the survivors.
  const closeOrder=[1,0,2];out.closes=[];
  const remaining=new Set(opened.map(item=>item.admission.campaignId));
  const costEvents=new Map(opened.map(item=>[item.admission.campaignId,item.verified.stageCount]));
  for(const index of closeOrder){
   const item=opened[index],siblings=[...remaining].filter(id=>id!==item.admission.campaignId);
   const result=await phase(`retain_close_${item.label}`,async()=>{
    const closed=await retainClose(ctx,ctx.worker,{campaignId:item.admission.campaignId,label:item.label,
     openCostEvents:costEvents.get(item.admission.campaignId),siblingIds:siblings,phase});
    if(!closed.ok){const error=new Error(`retain_worker_${closed.driven.kind}: ${closed.driven.reason}`);error.workerBlock=closed.driven;throw error;}
    return closed;
   });
   remaining.delete(item.admission.campaignId);
   out.closes.push({label:item.label,campaignId:item.admission.campaignId,stages:result.evidence.stages,closeShape:result.evidence.closeShape,
    siblingsActiveAndUnchanged:siblings.length,
    holdingMarks:result.evidence.holdingMarksRecorded});
  }
  out.checks.closeWhileOthersActive={order:closeOrder.map(index=>opened[index].label),firstCloseSiblingsUnchanged:true};
  out.checks.finalState={allocationsReleased:true,
   activeAllocations:(await readCommitments(ctx.db,identityOf(ctx))).allocations.length};
  assert.equal(out.checks.finalState.activeAllocations,0,'Allocations remain after every campaign closed');
  out.allowanceObservations=[await allowancePolicy.observeAllowances(ctx,'concurrency:final')];
  out.outcome=out.softFailures.length?'FAIL':'PASS';
 }catch(error){
  out.outcome=error.workerBlock?.kind==='market'?'MARKET_BLOCK':'FAIL';
  out.failurePhase=error.matrixPhase??'unknown';out.reason=redact(error.message).slice(0,500);out.error=shortError(error);
 }
 return out;
}
