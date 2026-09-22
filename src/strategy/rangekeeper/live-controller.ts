import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {type Hex} from 'viem';
import type {RobinhoodClient} from '../../client.js';
import {pilotIntentSchema} from '../../live-pilot/journal.js';
import {rangeKeeperConfigHash,initialRangeKeeperState,assertRangeKeeperState,type RangeKeeperConfig} from './config.js';
import {RangeKeeperChain} from './chain.js';
import {rangeKeeperConfirmedSource,inspectRangeKeeperLaunch} from './live-preflight.js';
import {RangeKeeperLiveStore} from './live-store.js';
import {loadRangeKeeperSigner} from './live-signer.js';
import {rangeKeeperJson,type RangeKeeperLiveState,type RangeKeeperLiveAction,type RangeKeeperSnapshot} from './live-domain.js';
import {readRangeKeeperReferences} from './reference.js';
import {strategyBalances} from './funding.js';
import {markRangeKeeper} from './live-mark.js';
import {nextRangeKeeperStage,RangeKeeperMintUnavailableError,RangeKeeperStaleCandidateError} from './live-stage.js';
import {planRangeKeeper,rawValue} from './planner.js';
import {rangeKeeperCostEnvelope,assertRangeKeeperStageGas,rangeKeeperForkGasUnits} from './cost.js';
import {authorizeRangeKeeperTx,encodeRangeKeeperTx,type RangeKeeperTxPlan} from './calldata.js';
import {mintedRangeKeeperTokenId,reconcileRangeKeeperAction} from './live-reconcile.js';
import {simulateRangeKeeperCandidate} from './fork-simulator.js';
import {nonfungiblePositionManagerReadAbi} from '../../nft/abi.js';
import {verifyRangeKeeperWalletCode} from './wallet-code.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const sumCost=(events:RangeKeeperLiveState['costEvents'])=>events.reduce<bigint|null>((sum,e)=>
 sum===null||e.gasValue===null||e.swapFeeValue===null||e.swapShortfallValue===null?null:
 sum+e.gasValue+e.swapFeeValue+e.swapShortfallValue,0n);

export function assertUntradedRangeKeeperRearm(old:RangeKeeperLiveState,expectedCampaignId:string,
 expectedPreviousBuildId:string,nextBuildId:string,configHash:Hex,operator:string){
 assert.equal(old.id,expectedCampaignId,'Campaign ID changed');
 assert.equal(old.buildId,expectedPreviousBuildId,'Previous build ID changed');
 assert.notEqual(old.buildId,nextBuildId,'Rearm requires a new sealed build');
 assert.equal(old.configHash,configHash,'Campaign configuration changed');
 assert(same(old.operator,operator),'Campaign operator changed');
 assert(old.phase==='closed'&&old.desired==='stopped'&&old.lastReason==='complete_exit_reconciled'&&old.closedAt!==null,
  'Only a completely reconciled closed campaign may rearm');
 assert(old.economicActions===0&&old.recenters===0&&old.activeTokenId===null&&old.retiredTokenIds.length===0&&
  old.candidate===null&&!old.swapDone&&old.gasSpentWei===0n&&old.costEvents.length===0,
  'Rearm requires a campaign with no economic action or cost');
}

export function assertCostedRangeKeeperResume(old:RangeKeeperLiveState,expectedCampaignId:string,
 expectedPreviousBuildId:string,nextBuildId:string,configHash:Hex,operator:string,limits:RangeKeeperConfig['limits']){
 assert.equal(old.id,expectedCampaignId,'Campaign ID changed');
 assert.equal(old.buildId,expectedPreviousBuildId,'Previous build ID changed');
 assert.notEqual(old.buildId,nextBuildId,'Resume requires a new sealed build');
 assert.equal(old.configHash,configHash,'Campaign configuration changed');
 assert(same(old.operator,operator),'Campaign operator changed');
 assert(old.phase==='closed'&&old.desired==='stopped'&&old.lastReason==='complete_exit_reconciled'&&old.closedAt!==null,
  'Only a completely reconciled closed campaign may resume');
 assert(old.economicActions===0&&old.recenters===0&&old.activeTokenId===null&&old.retiredTokenIds.length===0&&
  old.candidate===null&&old.last.position===null&&old.last.wallet1===0n&&
  old.last.nftCount===old.legacyNftCount&&old.last.allowances.every(a=>a.amount===0n),
  'Costed resume requires a fully exited pre-mint campaign');
 assert(old.costEvents.length>0&&old.gasSpentWei>0n,'Costed resume requires retained receipt costs');
 const spent=sumCost(old.costEvents);
 assert(spent!==null&&spent<limits.maxRollingCost&&spent<limits.maxCampaignCost,
  'Existing costs exhaust the campaign budget');
}

/** The closed campaign may adopt only the operator's reviewed 200-to-40-tick
 * change. Its original config hash and stored config must both agree. */
export function assertRangeKeeperWidthMigration(oldHash:Hex,recordedConfig:unknown,next:RangeKeeperConfig){
 const prior=structuredClone(next);
 const width=(recordedConfig as {limits?:{fullWidthSpacings?:unknown}})?.limits?.fullWidthSpacings;
 assert(Number.isSafeInteger(width),'Stored campaign width is invalid');
 prior.limits.fullWidthSpacings=width as number;
 assert.deepEqual(recordedConfig,JSON.parse(rangeKeeperJson(prior)),'Campaign changed beyond range width');
 assert.equal(rangeKeeperConfigHash(prior),oldHash,'Stored campaign hash does not match prior policy');
 assert(width===next.limits.fullWidthSpacings||(width===20&&next.limits.fullWidthSpacings===4),
  'Only the reviewed 200-to-40-tick migration is allowed');
}

/** Only remove the two count stops on an open, active campaign. Every other
 * strategy, custody and loss setting stays byte-for-byte equivalent. */
export function assertRangeKeeperCountMigration(old:RangeKeeperLiveState,recordedConfig:unknown,
 next:RangeKeeperConfig,expectedCampaignId:string,expectedPreviousBuildId:string,nextBuildId:string){
 assert.equal(old.id,expectedCampaignId,'Campaign ID changed');
 assert.equal(old.buildId,expectedPreviousBuildId,'Previous build ID changed');
 assert.notEqual(old.buildId,nextBuildId,'Migration requires a new sealed build');
 assert(next.operator&&same(old.operator,next.operator),'Campaign operator changed');
 assert.equal(next.campaignScope.maxEconomicActions,0,'Next campaign must remove the action count cap');
 assert.equal(next.limits.maxRecenters,0,'Next campaign must remove the recenter count cap');
 const prior={...next,limits:{...next.limits,maxRecenters:4},
  campaignScope:{...next.campaignScope,maxEconomicActions:2}};
 assert.equal(prior.campaignScope.maxDurationSeconds,0,'Only an open-ended campaign may remove count limits');
 assert.deepEqual(recordedConfig,JSON.parse(rangeKeeperJson(prior)),
  'Campaign changed beyond the reviewed count limits');
 assert.equal(old.configHash,rangeKeeperConfigHash(prior),'Stored campaign hash does not match active policy');
 assertRangeKeeperState(old.policy,prior,old.buildId);
 assert(old.phase==='holding'&&old.desired==='running'&&old.activeTokenId!==null&&
  old.last.position?.tokenId===old.activeTokenId&&old.candidate===null&&
  !old.swapDone&&!old.withdrawDone&&old.closedAt===null&&old.haltReason===null,
  'Only a settled, actively held position may migrate');
 assert(old.economicActions>=2&&old.recenters>=1,'Campaign has not reached the action cap');
 const spent=sumCost(old.costEvents);
 assert(spent!==null&&spent<next.limits.maxRollingCost&&spent<next.limits.maxCampaignCost,
  'Existing costs exhaust the campaign budget');
}

export class RangeKeeperLiveController {
 readonly chain:RangeKeeperChain;
 constructor(readonly store:RangeKeeperLiveStore,readonly config:RangeKeeperConfig,
  readonly client:RobinhoodClient,readonly publisher:RobinhoodClient,
  readonly signer:ReturnType<typeof loadRangeKeeperSigner>,readonly buildId:string,
  readonly archiveRpcUrl:string,readonly anvilBinary:string,readonly serviceGate:()=>void){
  assert(config.operator&&same(config.operator,signer.address));
  this.chain=new RangeKeeperChain(client,config.pool,config.zeroAllowances);
 }
 private freshState(proof:Awaited<ReturnType<typeof inspectRangeKeeperLaunch>>,id:string,
  reason:string):RangeKeeperLiveState{
  const at=proof.source.timestamp;
  return {version:1,id,operator:this.signer.address,
   configHash:rangeKeeperConfigHash(this.config),buildId:this.buildId,phase:'entry',desired:'running',haltReason:null,
   createdAt:at,expiresAt:this.config.campaignScope.maxDurationSeconds===0?Number.MAX_SAFE_INTEGER:
    at+this.config.campaignScope.maxDurationSeconds,economicActions:0,recenters:0,
   policy:initialRangeKeeperState(this.config,this.buildId),last:proof.wallet,activeTokenId:null,
   retiredTokenIds:[],legacyNftCount:proof.wallet.nftCount,
   reserve0:proof.funding.reserve0,reserve1:proof.funding.reserve1,reserveNativeWei:proof.funding.reserveNativeWei,
   initial0:proof.funding.allocation.amount0,initial1:proof.funding.allocation.amount1,
   initialNativeWei:proof.funding.allocation.nativeWei,initialStrategyValue:proof.funding.bookedStrategyValue,
   candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,
   mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],
   highWaterValue:proof.funding.bookedStrategyValue,activeSeconds:0,outsideSeconds:0,lastMarkTimestamp:at,
   lastReason:reason,closedAt:null};
 }
 private assertIdentity(s:RangeKeeperLiveState){
  assert.equal(s.version,1);assert.equal(s.configHash,rangeKeeperConfigHash(this.config));
  assert.equal(s.buildId,this.buildId);assertRangeKeeperState(s.policy,this.config,this.buildId);
  assert(this.config.operator&&same(s.operator,this.config.operator));
 }
 private async oldPilotClosed(db:PoolClient){
  const row=(await db.query(`SELECT state FROM live_pilot_v1.campaigns WHERE operator=$1`,
   [this.signer.address.toLowerCase()])).rows[0];
  assert(row?.state?.phase==='closed'&&row.state.desired==='stopped'&&row.state.tokenId===null,
   'Former pilot is not proved closed and stopped');
  const pending=(await db.query(`SELECT count(*)::int AS n FROM live_pilot_v1.actions
   WHERE campaign_id=$1 AND status IN('prepared','signed')`,[row.state.id])).rows[0];
  assert.equal(pending?.n,0,'Former pilot has an unresolved transaction');
 }
 private async source(){return rangeKeeperConfirmedSource(this.client);}
 private async exactCustody(before:RangeKeeperSnapshot,after:RangeKeeperSnapshot,activeTokenId:bigint|null){
  assert(same((await this.client.getBlock({blockNumber:before.source.block})).hash,before.source.hash),
   'Accepted RangeKeeper source reorged');
  await verifyRangeKeeperWalletCode(this.client,after.source,after.operator,this.config);
  assert(same(before.operator,after.operator));
  assert.equal(after.wallet0,before.wallet0,'Unexplained token0 balance');
  assert.equal(after.wallet1,before.wallet1,'Unexplained token1 balance');
  assert.equal(after.nativeWei,before.nativeWei,'Unattributed native transfer');
  assert.equal(after.nonce,before.nonce,'Unexplained or pending wallet nonce');
  assert.equal(after.nftCount,before.nftCount,'Unexplained NFT count');
  assert.deepEqual(after.allowances,before.allowances,'Unexplained allowance change');
  if(activeTokenId!==null){
   assert(before.position&&after.position&&before.position.tokenId===activeTokenId&&after.position.tokenId===activeTokenId);
   assert.equal(after.position.liquidity,before.position.liquidity,'NFT liquidity changed outside controller');
   assert.equal(after.position.tickLower,before.position.tickLower);assert.equal(after.position.tickUpper,before.position.tickUpper);
   assert.equal(after.position.tokensOwed0,before.position.tokensOwed0);
   assert.equal(after.position.tokensOwed1,before.position.tokensOwed1);
  }else assert.equal(after.position,null);
  assert.equal(await this.client.getTransactionCount({address:after.operator,blockTag:'pending'}),after.nonce,
   'Pending nonce differs from canonical custody');
 }
 private async proveRetiredCustody(s:RangeKeeperLiveState,source:RangeKeeperSnapshot['source']){
  for(const id of [...this.config.legacyRetiredTokenIds,...s.retiredTokenIds]){
   const tokenId=BigInt(id),manager=this.config.pool.positionManager;
   const [owner,position]=await Promise.all([
    this.client.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',
     args:[tokenId],blockNumber:source.block}),
    this.client.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',
     args:[tokenId],blockNumber:source.block})]);
   assert(same(owner,s.operator)&&position[7]===0n&&position[10]===0n&&position[11]===0n,
    `Retired NFT ${id} has unresolved custody`);
  }
 }
 async start(){
  this.serviceGate();
  assert(this.config.broadcastEnabled,'Live campaign requires a private broadcast-enabled config');
  return this.store.locked(this.signer.address,async db=>{
   const previous=await this.store.current(db,this.signer.address);
   if(previous){
    const old=previous.state;
    assert(old.phase==='closed'&&old.desired==='stopped'&&old.lastReason==='complete_exit_reconciled'&&
     old.closedAt!==null&&old.activeTokenId===null&&old.last.position===null,
     'Previous RangeKeeper campaign is not reconciled and closed');
    assert(!(await this.store.pending(db,old.id)),'Previous campaign has a pending transaction');
    const unresolved=(await db.query(`SELECT count(*)::int AS n FROM ${this.store.schema}.actions
     WHERE campaign_id=$1 AND status<>'confirmed'`,[old.id])).rows[0]?.n;
    assert.equal(unresolved,0,'Previous campaign has unresolved actions');
    for(const id of old.retiredTokenIds)assert(this.config.legacyRetiredTokenIds.includes(id),
     `New campaign omits retired NFT ${id}`);
    await this.proveRetiredCustody(old,old.last.source);
   }
   await this.oldPilotClosed(db);
   const proof=await inspectRangeKeeperLaunch({client:this.client,config:this.config,buildId:this.buildId,
    rpcUrl:this.archiveRpcUrl,anvilBinary:this.anvilBinary,simulateFork:true});
   assert.equal(proof.nativeShortfallWei,0n,'Native funding is below entry, recenter, and complete-exit requirement');
   if(previous)await this.exactCustody(previous.state.last,proof.wallet,null);
   const state=this.freshState(proof,randomUUID(),'initialized');
   await this.store.create(db,state,this.config);
   await this.store.mark(db,state.id,proof.source.block,'launch_preflight',{
    source:proof.source,funding:proof.funding,candidate:proof.candidate,envelope:proof.envelope,
    nativeRequiredWei:proof.nativeRequiredWei,reference:proof.reference,forkSimulated:proof.forkSimulated});
   return state;
  });
 }
 /** A failed no-trade launch may reuse its isolated campaign row only after
  * proving the old close, empty action ledger, unchanged custody and a fresh
  * full-wallet fork. The old state remains in append-only transitions. */
 async rearmUntraded(expectedCampaignId:string,expectedPreviousBuildId:string,apply:boolean){
  this.serviceGate();
  assert(this.config.broadcastEnabled,'Live campaign requires a private broadcast-enabled config');
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row,'No RangeKeeper campaign to rearm');
   const old=row.state;
   assertUntradedRangeKeeperRearm(old,expectedCampaignId,expectedPreviousBuildId,this.buildId,
    rangeKeeperConfigHash(this.config),this.signer.address);
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${this.store.schema}.actions WHERE campaign_id=$1`,
    [old.id])).rows[0]?.n,0,'An action ledger exists for this campaign');
   assert(!(await this.store.pending(db,old.id)),'Pending RangeKeeper action exists');
   await this.oldPilotClosed(db);
   const proof=await inspectRangeKeeperLaunch({client:this.client,config:this.config,buildId:this.buildId,
    rpcUrl:this.archiveRpcUrl,anvilBinary:this.anvilBinary,simulateFork:true});
   assert.equal(proof.nativeShortfallWei,0n,'Native funding is below the complete scoped requirement');
   await this.exactCustody(old.last,proof.wallet,null);
   assert.equal(proof.funding.allocation.amount0,old.initial0,'Strategy token0 allocation changed');
   assert.equal(proof.funding.allocation.amount1,old.initial1,'Strategy token1 allocation changed');
   assert.equal(proof.funding.allocation.nativeWei,old.initialNativeWei,'Native allocation changed');
   const next=this.freshState(proof,old.id,'rearmed_untraded');
   if(!apply)return next;
   await db.query('BEGIN');
   try{
    await this.store.mark(db,old.id,proof.source.block,'untraded_rearm_preflight',{
     previousBuildId:old.buildId,previousClosedAt:old.closedAt,source:proof.source,funding:proof.funding,
     candidate:proof.candidate,envelope:proof.envelope,nativeRequiredWei:proof.nativeRequiredWei,
     reference:proof.reference,forkSimulated:proof.forkSimulated});
    await this.store.save(db,next,'untraded_rearm');
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}
   return next;
  });
 }
 /** Resume a closed pre-mint campaign without resetting its spend, passive
  * baseline, action ledger, or 12-hour expiry. */
 async resumeCosted(expectedCampaignId:string,expectedPreviousBuildId:string,apply:boolean){
  this.serviceGate();
  assert(this.config.broadcastEnabled,'Live campaign requires a private broadcast-enabled config');
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row,'No RangeKeeper campaign to resume');
   const old=row.state;
   assertRangeKeeperWidthMigration(old.configHash,row.config,this.config);
   assertCostedRangeKeeperResume(old,expectedCampaignId,expectedPreviousBuildId,this.buildId,
    old.configHash,this.signer.address,this.config.limits);
   const ledger=(await db.query(`SELECT count(*)::int AS n,
    count(*) FILTER (WHERE status<>'confirmed')::int AS unresolved FROM ${this.store.schema}.actions WHERE campaign_id=$1`,
    [old.id])).rows[0];
   assert.equal(ledger?.n,old.costEvents.length,'Receipt cost ledger differs from action history');
   assert.equal(ledger?.unresolved,0,'Unresolved RangeKeeper action exists');
   assert(!(await this.store.pending(db,old.id)),'Pending RangeKeeper action exists');
   await this.oldPilotClosed(db);
   const proof=await inspectRangeKeeperLaunch({client:this.client,config:this.config,buildId:this.buildId,
    rpcUrl:this.archiveRpcUrl,anvilBinary:this.anvilBinary,simulateFork:true});
   assert(proof.source.timestamp<old.expiresAt,'Original bounded campaign window expired');
   assert.equal(proof.nativeShortfallWei,0n,'Native funding is below the complete scoped requirement');
   await this.exactCustody(old.last,proof.wallet,null);
   assert.equal(proof.funding.reserve0,old.reserve0,'Strategy token0 reserve changed');
   assert.equal(proof.funding.reserve1,old.reserve1,'Strategy token1 reserve changed');
   assert.equal(proof.funding.reserveNativeWei,old.reserveNativeWei,'Native reserve changed');
   const next={...old,buildId:this.buildId,configHash:rangeKeeperConfigHash(this.config),
    phase:'entry' as const,desired:'running' as const,
    policy:initialRangeKeeperState(this.config,this.buildId),last:proof.wallet,candidate:null,
    swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:old.costEvents.length,
    reservedActionCost:0n,lastMarkTimestamp:proof.source.timestamp,lastReason:'resumed_costed_closed',closedAt:null};
   if(!apply)return next;
   await db.query('BEGIN');try{
    await this.store.mark(db,old.id,proof.source.block,'costed_resume_preflight',{
     previousBuildId:old.buildId,previousConfigHash:old.configHash,nextConfigHash:next.configHash,
     previousWidth:(row.config as {limits:{fullWidthSpacings:number}}).limits.fullWidthSpacings,
     nextWidth:this.config.limits.fullWidthSpacings,previousClosedAt:old.closedAt,retainedCostEvents:old.costEvents.length,
     retainedGasSpentWei:old.gasSpentWei,source:proof.source,funding:proof.funding,candidate:proof.candidate,
     envelope:proof.envelope,nativeRequiredWei:proof.nativeRequiredWei,reference:proof.reference,
     forkSimulated:proof.forkSimulated});
    await this.store.save(db,next,'costed_resume');
    const updated=await db.query(`UPDATE ${this.store.schema}.campaigns SET config=$2 WHERE id=$1`,
     [old.id,rangeKeeperJson(this.config)]);
    assert.equal(updated.rowCount,1,'Campaign config migration lost its row');
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}
   return next;
  });
 }
 /** Adopt an unlimited count policy without moving inventory or resetting any
  * receipt, cost, valuation or passive baseline. Signing remains a later tick. */
 async migrateCounts(expectedCampaignId:string,expectedPreviousBuildId:string,apply:boolean){
  this.serviceGate();
  assert(this.config.broadcastEnabled,'Live campaign requires a private broadcast-enabled config');
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row,'No RangeKeeper campaign to migrate');
   const old=row.state;
   assertRangeKeeperCountMigration(old,row.config,this.config,expectedCampaignId,expectedPreviousBuildId,this.buildId);
   assert(!(await this.store.pending(db,old.id)),'Pending RangeKeeper action exists');
   const unresolved=(await db.query(`SELECT count(*)::int AS n FROM ${this.store.schema}.actions
    WHERE campaign_id=$1 AND status IN('prepared','signed')`,[old.id])).rows[0]?.n;
   assert.equal(unresolved,0,'Unresolved RangeKeeper action exists');
   await this.oldPilotClosed(db);
   const source=await this.source();
   await this.chain.verify(source);
   const snapshot=await this.chain.snapshot(source,old.operator,old.activeTokenId);
   await this.exactCustody(old.last,snapshot,old.activeTokenId);
   assert(snapshot.unlocked,'Pool is locked');
   assert.equal(snapshot.nftCount,old.legacyNftCount+BigInt(old.retiredTokenIds.length)+1n,
    'Unexpected NFT ownership count');
   const refs=await readRangeKeeperReferences(this.client,source,this.config);
   assert(refs.eligible&&refs.price0&&refs.price1&&refs.nativePrice,
    `Independent reference unavailable: ${refs.reasons.join(',')}`);
   const mark=await markRangeKeeper(old,snapshot,this.chain,this.config,{price0:refs.price0,price1:refs.price1});
   assert(mark.netPnl!==null&&-mark.netPnl<=this.config.limits.maxLossValue,
    'Loss exit is due');
   assert(old.highWaterValue<=mark.nav||
    (old.highWaterValue-mark.nav)*1_000_000n<=old.highWaterValue*BigInt(this.config.limits.maxDrawdownPpm),
    'Drawdown exit is due');
   const poolPrice1=((1n<<192n)*10n**BigInt(this.config.pool.decimals1)*refs.price0)/
    (snapshot.sqrtPriceX96*snapshot.sqrtPriceX96*10n**BigInt(this.config.pool.decimals0));
   const deviation=poolPrice1>refs.price1?poolPrice1-refs.price1:refs.price1-poolPrice1;
   assert(deviation*1_000_000n<=refs.price1*BigInt(this.config.referencePolicy.maxPoolDeviationPpm),
    'Independent price band exit is due');
   const latest=await this.client.getBlock();assert(latest.baseFeePerGas&&latest.baseFeePerGas>0n);
   const gasPrice=await this.client.getGasPrice();assert(gasPrice>0n);
   const fee=ceil((gasPrice>latest.baseFeePerGas?gasPrice:latest.baseFeePerGas)*5n,4n);
   const u=rangeKeeperForkGasUnits;
   const actionUnits=u.withdrawCollect+u.approval*3n+u.swap+u.mint+u.cleanupApproval*4n;
   const exitUnits=u.withdrawCollect+u.approval+u.swap+u.cleanupApproval*4n;
   const exitReserve=exitUnits*fee>this.config.limits.exitReserveWei?
    exitUnits*fee:this.config.limits.exitReserveWei;
   const nativeRequiredWei=actionUnits*fee+exitReserve;
   assert(strategyBalances(snapshot,old).nativeWei>=nativeRequiredWei,
    'Strategy native balance cannot fund a next action and complete exit');
   const next={...old,buildId:this.buildId,configHash:rangeKeeperConfigHash(this.config),
    policy:{...old.policy,buildId:this.buildId,configHash:rangeKeeperConfigHash(this.config),
     exit:null,confirmation:null},last:snapshot,lastReason:'count_limits_removed'};
   const proof={previousBuildId:old.buildId,previousConfigHash:old.configHash,
    nextConfigHash:next.configHash,source,activeTokenId:String(old.activeTokenId),
    economicActions:old.economicActions,recenters:old.recenters,spent:sumCost(old.costEvents),
    nativeRequiredWei,reference:refs,valuation:mark};
   if(!apply)return {state:next,proof};
   await db.query('BEGIN');try{
    await this.store.mark(db,old.id,source.block,'count_migration_preflight',proof);
    await this.store.save(db,next,'count_limits_removed');
    const updated=await db.query(`UPDATE ${this.store.schema}.campaigns SET config=$2 WHERE id=$1`,
     [old.id,rangeKeeperJson(this.config)]);
    assert.equal(updated.rowCount,1,'Campaign config migration lost its row');
    await db.query('COMMIT');
   }catch(error){await db.query('ROLLBACK');throw error;}
   return {state:next,proof};
  });
 }
 async requestStop(){return this.store.locked(this.signer.address,async db=>{
  const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;this.assertIdentity(s);
  s.desired='stopped';if(s.phase!=='closed'&&s.phase!=='halted')s.phase='exit';
  await this.store.save(db,s,'operator_requested_stop');return s;
 });}
 async recoverExit(){return this.store.locked(this.signer.address,async db=>{
  const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;this.assertIdentity(s);
  assert(s.phase==='halted'&&s.haltReason?.startsWith('transaction_reverted:'),'Only a reconciled revert can recover into exit');
  assert(!(await this.store.pending(db,s.id)),'Signed transaction remains unresolved');
  const source=await this.source(),now=await this.chain.snapshot(source,s.operator,s.activeTokenId);
  await this.exactCustody(s.last,now,s.activeTokenId);
  s.last=now;s.phase='exit';s.desired='stopped';s.haltReason=null;s.candidate=null;s.lastReason='operator_recovered_revert_to_exit';
  await this.store.save(db,s,s.lastReason);return s;
 });}
 async recoverMint(){return this.store.locked(this.signer.address,async db=>{
  const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;this.assertIdentity(s);
  assert(s.phase==='halted'&&s.haltReason?.startsWith('transaction_reverted:')&&s.candidate,
   'No saved reverted mint proposal');
  const failed=await this.store.action(db,s.haltReason!.slice('transaction_reverted:'.length));
  assert(failed.campaignId===s.id&&failed.status==='reverted'&&failed.plan.kind==='mint',
   'Only a canonical reverted mint may retry the saved inventory');
  assert(failed.receipt,'Reverted mint has no reconciliation proof');
  assert(s.swapDone||s.candidate.swap===null,'Recovery cannot repeat an uncompleted swap');
  assert(s.activeTokenId===null&&s.mintRecoveryAttempts<3&&s.desired==='running');
  assert(!(await this.store.pending(db,s.id)));
  const source=await this.source(),now=await this.chain.snapshot(source,s.operator,null);
  await this.exactCustody(s.last,now,null);
  const refs=await readRangeKeeperReferences(this.client,source,this.config);
  assert(refs.eligible&&refs.price0&&refs.price1,'Mint recovery needs fresh independent references');
  s.last=now;s.phase=s.candidate.kind;s.haltReason=null;s.mintRecoveryAttempts++;
  s.lastReason='operator_recovered_mint_without_swap';await this.store.save(db,s,s.lastReason);return s;
 });}
 private async reconcilePending(db:PoolClient,s:RangeKeeperLiveState,action:RangeKeeperLiveAction){
  if(action.status==='prepared'){
   // The signer cannot publish. A crash before durable signing leaves no
   // possible broadcast from this controller.
   const pending=await this.client.getTransactionCount({address:s.operator,blockTag:'pending'});
   assert.equal(pending,action.intent.nonce,'Prepared nonce changed outside controller');
   await this.store.cancel(db,action.id,'unsigned_restart');return 'unsigned_cancelled';
  }
  assert(action.raw&&action.hash,'Signed outbox is incomplete');
  let receipt:Awaited<ReturnType<RobinhoodClient['getTransactionReceipt']>>|null=null;
  try{receipt=await this.client.getTransactionReceipt({hash:action.hash});}
  catch(e){if((e as Error).name!=='TransactionReceiptNotFoundError')throw e;}
  if(!receipt){
   const confirmed=await this.client.getTransactionCount({address:s.operator,blockTag:'latest'});
   assert(confirmed<=action.intent.nonce,'Nonce consumed without the signed receipt');
   // Unknown acknowledgement is retried with the same signed bytes and nonce.
   assert.equal(await this.publisher.getChainId(),this.config.pool.chainId,'Publisher chain changed');
   try{await this.publisher.sendRawTransaction({serializedTransaction:action.raw});
    await this.store.attempted(db,action.id,null);
   }catch(e){await this.store.attempted(db,action.id,(e as Error).message.slice(0,300));}
   return 'signed_pending';
  }
  const tip=await this.client.getBlock();
  if(tip.number<receipt.blockNumber+64n)return 'confirming_receipt';
  const block=await this.client.getBlock({blockNumber:receipt.blockNumber});
  assert(same(block.hash,receipt.blockHash),'Receipt block is not canonical');
  const sourceBlock=await this.client.getBlock({blockNumber:action.before.source.block});
  assert(same(sourceBlock.hash,action.before.source.hash),'Signed action source reorged');
  assert(same(receipt.from,s.operator),'Receipt sender differs from the signed intent');
  const mined=await this.client.getTransaction({hash:action.hash});
  assert.equal(mined.nonce,action.intent.nonce,'Receipt nonce differs from the signed intent');
  const source={block:block.number,hash:block.hash,timestamp:Number(block.timestamp)};
  const created=receipt.status==='success'&&action.plan.kind==='mint'
   ?mintedRangeKeeperTokenId(this.config.pool,s.operator,receipt):null;
  const after=await this.chain.snapshot(source,s.operator,created??s.activeTokenId);
  const proof=reconcileRangeKeeperAction(this.config.pool,action,receipt,after);
  let gasValue:bigint|null=null,swapFeeValue:bigint|null=0n,swapShortfallValue:bigint|null=0n;
  let refs:Awaited<ReturnType<typeof readRangeKeeperReferences>>|null=null;
  try{refs=await readRangeKeeperReferences(this.client,source,this.config);
   if(refs.nativePrice)gasValue=rawValue(proof.gasWei,refs.nativePrice,18);
  }catch{/* Persist the receipt even when external reference collection is down. */}
  if(receipt.status==='success'&&action.plan.kind==='swap'){
   if(refs?.price0&&refs.price1){
    const i=action.plan.token,p=this.config.pool;
    const inputValue=rawValue(action.plan.amountIn,i===0?refs.price0:refs.price1,i===0?p.decimals0:p.decimals1);
    const outputValue=rawValue(proof.actualSwapOutput!,i===0?refs.price1:refs.price0,i===0?p.decimals1:p.decimals0);
    swapFeeValue=inputValue*BigInt(p.fee)/1_000_000n;
    const gap=inputValue-outputValue-swapFeeValue;
    swapShortfallValue=gap>0n?gap:0n;
   }else swapFeeValue=swapShortfallValue=null;
  }
  s.gasSpentWei+=proof.gasWei;
  s.costEvents.push({hash:action.hash,block:source.block,timestamp:source.timestamp,gasWei:proof.gasWei,
   gasValue,swapFeeValue,swapShortfallValue});
  s.last=after;
  if(receipt.status==='reverted'){
   s.phase='halted';s.haltReason=`transaction_reverted:${action.id}`;
   s.lastReason=s.haltReason;
  }else if(action.plan.kind==='withdraw'){
   assert(proof.collection);
   s.collectedFee0+=proof.collection.fee0;s.collectedFee1+=proof.collection.fee1;
   s.retiredTokenIds.push(String(action.plan.tokenId));s.activeTokenId=null;s.withdrawDone=true;
   s.lastReason='withdraw_collected';
  }else if(action.plan.kind==='swap'){
   if(s.phase==='entry'||s.phase==='recenter'){s.swapDone=true;s.swapConfirmedAt=source.timestamp;}
   s.lastReason='swap_confirmed';
  }else if(action.plan.kind==='mint'){
   assert(created!==null);s.activeTokenId=created;s.economicActions++;
   if(s.phase==='recenter')s.recenters++;
   s.phase='holding';s.candidate=null;s.swapDone=false;s.swapConfirmedAt=null;s.withdrawDone=false;
   s.reservedActionCost=0n;s.lastReason='mint_confirmed';
  }else s.lastReason='approval_confirmed';
  await this.store.finish(db,action,s,{receipt,proof},receipt.status==='success'?'confirmed':'reverted');
  return s.lastReason;
 }
 private async submit(db:PoolClient,s:RangeKeeperLiveState,snapshot:RangeKeeperSnapshot,plan:RangeKeeperTxPlan,
  prices:{price0:bigint;price1:bigint;nativePrice:bigint}){
  this.serviceGate();
  assert(this.config.broadcastEnabled&&prices.nativePrice>0n);
  assert.equal(await this.publisher.getChainId(),this.config.pool.chainId,'Publisher chain changed');
  assert.equal(await this.client.getTransactionCount({address:s.operator,blockTag:'pending'}),snapshot.nonce);
  assert.equal(await this.publisher.getTransactionCount({address:s.operator,blockTag:'pending'}),snapshot.nonce,
   'Publisher sees a conflicting pending nonce');
  const funds=strategyBalances(snapshot,s);
  let futureApprovalCap=0n;
  if(plan.kind==='approve'&&plan.amount>(plan.token===0?funds.amount0:funds.amount1)){
   const sw=s.candidate?.swap;
   assert((s.phase==='entry'||s.phase==='recenter')&&!s.swapDone&&sw&&
    plan.spender==='positionManager'&&plan.token!==sw.token,
    'Future approval lacks a frozen acquisition');
   const price=plan.token===0?prices.price0:prices.price1;
   const decimals=plan.token===0?this.config.pool.decimals0:this.config.pool.decimals1;
   assert(price>0n);
   const maxRaw=this.config.limits.maxDeploymentValue*10n**BigInt(decimals)/price;
   futureApprovalCap=maxRaw;
   assert(plan.amount<=maxRaw,'Future approval exceeds LP value cap');
  }
  authorizeRangeKeeperTx(this.config.pool,{...snapshot,position:snapshot.position?{...snapshot.position,tokenId:snapshot.position.tokenId!}:null,
   wallet0:funds.amount0,wallet1:funds.amount1,
   timestamp:snapshot.source.timestamp},plan,this.config.limits.maxSlippageBps,this.config.limits.fullWidthSpacings,
   futureApprovalCap);
  const tx=encodeRangeKeeperTx(this.config.pool,s.operator,plan);
  const latest=await this.client.getBlock();
  assert(latest.baseFeePerGas&&latest.baseFeePerGas>0n);
  const latestCustody=await this.chain.snapshot({block:latest.number,hash:latest.hash,
   timestamp:Number(latest.timestamp)},s.operator,s.activeTokenId);
  await this.exactCustody(snapshot,latestCustody,s.activeTokenId);
  assert(Number(latest.timestamp)-snapshot.source.timestamp<=240,'Confirmed observation too old to submit');
  if('deadline' in plan)assert(BigInt(latest.timestamp)<plan.deadline,'Stage deadline expired');
  const market=await this.client.getGasPrice();
  const unitPrice=ceil((market>latest.baseFeePerGas?market:latest.baseFeePerGas)*5n,4n);
  await this.client.call({account:s.operator,to:tx.to,data:tx.data,blockNumber:snapshot.source.block});
  const estimated=await this.client.estimateGas({account:s.operator,to:tx.to,data:tx.data,value:0n});
  const gas=ceil(estimated*6n,5n);
  const kind=plan.kind==='approve'?(plan.amount===0n?'cleanupApproval':'approval'):
   plan.kind==='withdraw'?'withdrawCollect':plan.kind;
  assertRangeKeeperStageGas(kind,gas);
  const remainingExitUnits=()=>{
   const u=rangeKeeperForkGasUnits;
   if(plan.kind==='withdraw')return u.approval+u.swap+u.cleanupApproval*4n;
   if(plan.kind==='swap')return u.cleanupApproval*4n;
   if(plan.kind==='approve'&&plan.amount>0n)return u.swap+u.cleanupApproval*4n;
   if(plan.kind==='approve')return u.cleanupApproval*BigInt(snapshot.allowances.filter(a=>a.amount>0n).length-1);
   return 0n;
  };
  const reserve=s.phase==='exit'?remainingExitUnits()*unitPrice:this.config.limits.exitReserveWei;
  const available=funds.nativeWei;
  assert(available>=gas*unitPrice+reserve,'Native exit reserve would be invaded');
  const spent=sumCost(s.costEvents);
  assert(spent!==null,'Cost history lacks independent valuation');
  let nextCost=rawValue(gas*unitPrice,prices.nativePrice,18);
  if(plan.kind==='swap'){
   const i=plan.token,p=this.config.pool;
   const input=rawValue(plan.amountIn,i===0?prices.price0:prices.price1,i===0?p.decimals0:p.decimals1);
   const minimum=rawValue(plan.minOut,i===0?prices.price1:prices.price0,i===0?p.decimals1:p.decimals0);
   if(input>minimum)nextCost+=input-minimum;
  }
  if(s.phase!=='exit'){
   assert(spent+nextCost<=this.config.limits.maxCampaignCost,'Campaign cost cap would be exceeded');
   assert(spent+nextCost<=this.config.limits.maxRollingCost,'Rolling cost cap would be exceeded');
   const actionCost=sumCost(s.costEvents.slice(s.actionStartCostIndex));
   assert(actionCost!==null&&actionCost+nextCost<=this.config.limits.maxActionCost,
    'Complete action cost cap would be exceeded');
  }
  const intent=pilotIntentSchema.parse({id:randomUUID(),chainId:this.config.pool.chainId,operator:s.operator,
   action:`rangekeeper_${s.phase}_${plan.kind}`,nonce:snapshot.nonce,to:tx.to,data:tx.data,value:'0',
   gas:String(gas),maxFeePerGas:String(unitPrice),maxPriorityFeePerGas:'0',
   sourceBlock:String(snapshot.source.block),sourceHash:snapshot.source.hash});
  const prepared=await this.store.prepare(db,s,intent,plan,snapshot);
  const signed=await this.signer.signIntent(intent);
  const persisted=await this.store.signed(db,prepared,signed.raw);
  assert.equal(persisted.hash,signed.hash);
  try{await this.publisher.sendRawTransaction({serializedTransaction:signed.raw});
   await this.store.attempted(db,prepared.id,null);
  }catch(e){await this.store.attempted(db,prepared.id,(e as Error).message.slice(0,300));}
  return {action:plan.kind,hash:signed.hash,nonce:intent.nonce};
 }
 async tick(){return this.store.locked(this.signer.address,async db=>{
  const row=await this.store.current(db,this.signer.address);assert(row,'RangeKeeper campaign is not initialized');
  const s=row.state;this.assertIdentity(s);
  const pending=await this.store.pending(db,s.id);
  if(pending)return {status:await this.reconcilePending(db,s,pending),state:s};
  if(s.phase==='closed'||s.phase==='halted')return {status:s.phase,state:s};
  await this.oldPilotClosed(db);
  const source=await this.source(),snapshot=await this.chain.snapshot(source,s.operator,s.activeTokenId);
  await this.exactCustody(s.last,snapshot,s.activeTokenId);
  assert.equal(snapshot.nftCount,s.legacyNftCount+BigInt(s.retiredTokenIds.length)+(s.activeTokenId===null?0n:1n),
   'Unexpected NFT ownership count');
  const refs=await readRangeKeeperReferences(this.client,source,this.config);
  if(!refs.eligible||!refs.price0||!refs.price1||!refs.nativePrice){
   await this.store.monitor(db,s.id,refs.reasons);return {status:'reference_unavailable',state:s};
  }
  const prices={price0:refs.price0,price1:refs.price1},funds=strategyBalances(snapshot,s);
  const mark=await markRangeKeeper(s,snapshot,this.chain,this.config,prices);
  const dt=Math.max(0,source.timestamp-s.lastMarkTimestamp);
  if(s.activeTokenId!==null&&snapshot.position?.liquidity){
   s.activeSeconds+=dt;
   if(snapshot.tick<snapshot.position.tickLower||snapshot.tick>=snapshot.position.tickUpper)s.outsideSeconds+=dt;
  }
  s.lastMarkTimestamp=source.timestamp;
  if(mark.nav>s.highWaterValue)s.highWaterValue=mark.nav;
  s.last=snapshot;
  await this.store.mark(db,s.id,source.block,'valuation',{...mark,reference:refs});
  const loss=mark.netPnl!==null&&-mark.netPnl>this.config.limits.maxLossValue;
  const drawdown=s.highWaterValue>mark.nav&&
   (s.highWaterValue-mark.nav)*1_000_000n>s.highWaterValue*BigInt(this.config.limits.maxDrawdownPpm);
  const poolPrice1=((1n<<192n)*10n**BigInt(this.config.pool.decimals1)*refs.price0)/
   (snapshot.sqrtPriceX96*snapshot.sqrtPriceX96*10n**BigInt(this.config.pool.decimals0));
  const deviation=poolPrice1>refs.price1?poolPrice1-refs.price1:refs.price1-poolPrice1;
  const detached=deviation*1_000_000n>refs.price1*BigInt(this.config.referencePolicy.maxPoolDeviationPpm);
  if(s.desired==='stopped'||source.timestamp>=s.expiresAt||loss||drawdown||detached||!snapshot.unlocked){
   s.phase='exit';s.desired='stopped';s.candidate=null;
   s.lastReason=loss?'loss_limit':drawdown?'drawdown_limit':detached?'independent_price_band':
    !snapshot.unlocked?'pool_locked':source.timestamp>=s.expiresAt?'scope_expired':'operator_stop';
  }
  if((s.phase==='holding'||(s.phase==='entry'&&s.candidate===null))&&
   (this.config.campaignScope.maxEconomicActions===0||s.economicActions<this.config.campaignScope.maxEconomicActions)&&
   (this.config.limits.maxRecenters===0||s.recenters<this.config.limits.maxRecenters)&&
   source.timestamp<s.expiresAt){
   const observation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:snapshot.tick,
    sqrtPriceX96:snapshot.sqrtPriceX96,continuity:'canonical' as const,wallet0:funds.amount0,wallet1:funds.amount1,
    released0:mark.principal0+mark.uncollected0,released1:mark.principal1+mark.uncollected1,
    nativeWei:funds.nativeWei,requiredExitReserveWei:this.config.limits.exitReserveWei,
    price0:refs.price0,price1:refs.price1,nativePrice:refs.nativePrice,
    position:snapshot.position?.liquidity?{tokenId:String(snapshot.position.tokenId!),
     tickLower:snapshot.position.tickLower,tickUpper:snapshot.position.tickUpper,liquidity:snapshot.position.liquidity}:null,
    pending:false,entryAllowed:true,safeExitRequired:false,executionReady:snapshot.unlocked,
    liquiditySharePpm:0,actionCost:this.config.limits.maxActionCost,actionGasWei:0n,
    reservedCost:0n,rollingSpentCost:sumCost(s.costEvents)??this.config.limits.maxRollingCost,
    campaignSpentCost:sumCost(s.costEvents)??this.config.limits.maxCampaignCost,
    campaignStartValue:s.initialStrategyValue,highWaterValue:s.highWaterValue,recenters:s.recenters};
   const input={state:s.policy,observation,limits:this.config.limits,spacing:this.config.pool.tickSpacing,
    decimals0:this.config.pool.decimals0,decimals1:this.config.pool.decimals1,quoteToken:this.config.pool.quoteToken,
    maxPoolDeviationPpm:this.config.referencePolicy.maxPoolDeviationPpm,
    quote:(token:0|1,amount:bigint)=>this.chain.quote(source,token,amount,refs.price0!,refs.price1!),simulate:async()=>true};
   const preview=await planRangeKeeper(input);
   if(preview.candidate){
    const latest=await this.client.getBlock();assert(latest.baseFeePerGas);
    const envelope=rangeKeeperCostEnvelope({candidate:preview.candidate,limits:this.config.limits,
     baseFeePerGasWei:latest.baseFeePerGas,marketGasPriceWei:await this.client.getGasPrice(),
     nativePriceValue:refs.nativePrice,existingPosition:s.activeTokenId!==null,poolAddress:this.config.pool.pool});
    const activeInPool=snapshot.position&&snapshot.tick>=snapshot.position.tickLower&&
     snapshot.tick<snapshot.position.tickUpper?snapshot.position.liquidity:0n;
    const poolAfterWithdrawal=snapshot.poolLiquidity-activeInPool;
    assert(poolAfterWithdrawal>=0n);
    const share=preview.candidate.liquidity*1_000_000n/(poolAfterWithdrawal+preview.candidate.liquidity);
    const decision=await planRangeKeeper({...input,observation:{...observation,
     actionCost:envelope.actionCostValue,actionGasWei:envelope.actionGasWei,
     requiredExitReserveWei:envelope.requiredExitReserveWei,liquiditySharePpm:Number(share)},
     simulate:async candidate=>{await simulateRangeKeeperCandidate({rpcUrl:this.archiveRpcUrl,anvilBinary:this.anvilBinary,
     source,pool:this.config.pool,limits:this.config.limits,operator:s.operator,candidate,
      activeTokenId:s.activeTokenId,prices:{price0:refs.price0!,price1:refs.price1!}});return true;}});
    s.policy=decision.state;s.lastReason=decision.reason;
    if(decision.action==='safety_exit'){s.phase='exit';s.desired='stopped';}
    if(decision.action==='execute'&&decision.candidate){
     assert(s.candidate===null&&!s.swapDone&&!s.withdrawDone,
      'An in-flight economic action cannot be replaced by a new proposal');
     s.phase=decision.candidate.kind;s.candidate=decision.candidate;s.swapDone=false;s.swapConfirmedAt=null;s.withdrawDone=false;
     s.actionStartCostIndex=s.costEvents.length;s.reservedActionCost=envelope.actionCostValue;
    }
   }else{s.policy=preview.state;s.lastReason=preview.reason;
    if(preview.action==='safety_exit'){s.phase='exit';s.desired='stopped';}}
  }
  if(s.phase==='exit'||s.phase==='entry'||s.phase==='recenter'||s.phase==='holding'){
   let stage:RangeKeeperTxPlan|null;
   try{stage=await nextRangeKeeperStage(s,snapshot,this.config,this.chain,prices);}
   catch(error){
    if((error instanceof RangeKeeperStaleCandidateError||error instanceof RangeKeeperMintUnavailableError)&&
     s.phase==='entry'&&!s.swapDone&&!s.withdrawDone){
     // No swap or withdrawal changed custody. Require two fresh observations.
     s.candidate=null;s.policy.confirmation=null;s.lastReason='stale_entry_quote';
     await this.store.save(db,s,s.lastReason);return {status:s.lastReason,state:s};
    }
    if(error instanceof RangeKeeperMintUnavailableError&&s.swapDone&&s.swapConfirmedAt!==null&&s.candidate){
     const inRange=snapshot.tick>=s.candidate.range.tickLower&&snapshot.tick<s.candidate.range.tickUpper;
     if(inRange&&source.timestamp-s.swapConfirmedAt<300)s.lastReason='repriced_mint_wait';
     else{s.phase='exit';s.desired='stopped';s.candidate=null;s.lastReason='repriced_mint_exit';}
     await this.store.save(db,s,s.lastReason);return {status:s.lastReason,state:s};
    }
    throw error;
   }
   if(stage){await this.store.save(db,s,s.lastReason);return {status:'submitted',
    result:await this.submit(db,s,snapshot,stage,{...prices,nativePrice:refs.nativePrice}),state:s};}
   if(s.phase==='exit'){
    assert(s.activeTokenId===null&&snapshot.position===null,'Active position remains at exit');
    await this.proveRetiredCustody(s,source);
    s.phase='closed';s.closedAt=source.timestamp;s.lastReason='complete_exit_reconciled';
   }
  }
  await this.store.save(db,s,s.lastReason);
  return {status:s.lastReason,state:s};
 });}
}
