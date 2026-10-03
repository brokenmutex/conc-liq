import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {consumeReviewAndReserve,readWalletState,readCommitments,recordReview,recordWalletSnapshot,releaseLiveWalletAllocation} from '../../src/deployments/live-wallet-store.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {readLiveWalletCommitments} from '../../src/deployments/live-wallet-commitments.ts';
import {initialRangeKeeperState,parseRangeKeeperConfig,rangeKeeperConfigHash} from '../../src/strategy/rangekeeper/config.ts';
import {liveSetupEvidenceHash} from '../../src/deployments/rangekeeper-live-setup-simulation.ts';
import {applyRangeKeeperLiveReceiptEffectInTransaction} from '../../src/deployments/rangekeeper-live-campaign-effects.ts';
import {rangeKeeperJson} from '../../src/strategy/rangekeeper/live-domain.ts';
import {readRangeKeeperLiveCampaign,initializeRangeKeeperLiveCampaign,appendRangeKeeperLiveCampaignEvent,
 recordRangeKeeperNftCustodySnapshotInTransaction,persistRangeKeeperLiveStageAuthorizationInTransaction} from '../../src/deployments/rangekeeper-live-campaign-store.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL explicitly; this test creates and removes an isolated schema only');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4}),admin=await pool.connect();
const schema=`live_wallet_test_${randomUUID().replaceAll('-','')}`;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 const db=new pg.Pool({connectionString:url.toString(),max:4});
 try{
  const wallet='0x1111111111111111111111111111111111111111',token0='0x2222222222222222222222222222222222222222',token1='0x3333333333333333333333333333333333333333';
  const profileId=randomUUID(),referencePolicy={token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000},
   registeredProfile={pool:{chainId:4663,factory:'0x6666666666666666666666666666666666666666',pool:'0x4444444444444444444444444444444444444444',
    token0,token1,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:'0x7777777777777777777777777777777777777777',
    router:'0x8888888888888888888888888888888888888888',quoter:'0x9999999999999999999999999999999999999999',poolCodeHash:`0x${'a'.repeat(64)}`,
    token0CodeHash:`0x${'a'.repeat(64)}`,token1CodeHash:`0x${'a'.repeat(64)}`,managerCodeHash:`0x${'a'.repeat(64)}`,
    quoterCodeHash:`0x${'a'.repeat(64)}`,reference0:'TOKEN0/USD',reference1:'TOKEN1/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy},
   profileHash=contentHash(registeredProfile),source={block:'78211393',hash:`0x${'a'.repeat(64)}`,timestamp:Math.floor(Date.now()/1000)};
  await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
   VALUES($1,4663,$2,$3,$4,18,6,1,3000,60,$5,'{}',$6,clock_timestamp())`,[profileId,'0x4444444444444444444444444444444444444444',token0,token1,registeredProfile,profileHash]);
  const emptyFingerprint=liveWalletCommitmentFingerprint({wallet:{chainId:4663,address:wallet},allocations:[],nftCustody:[]});
  await recordWalletSnapshot(db,{chainId:4663,address:wallet,source,nonce:'17',pendingNonce:'17',nativeBalanceWei:'1000',
   tokens:[{address:token1,balanceRaw:'100'},{address:token0,balanceRaw:'500'}],commitmentsHash:emptyFingerprint});
  const nftManager='0x5555555555555555555555555555555555555555',custodyClient=await db.connect();
  try{
   await custodyClient.query('BEGIN');
   const nftSnapshot=await recordRangeKeeperNftCustodySnapshotInTransaction(custodyClient,{chainId:4663,address:wallet,
    positionManager:nftManager,source,completeEvidence:{kind:'complete_position_manager_nft_custody',status:'available',targetStrategyId:'rangekeeper_v1',
     operator:wallet,positionManager:nftManager,source:{...source,confirmed:true},enumerationComplete:true,tokenIds:[],
     balanceOfCount:{status:'available',value:'0'},knownOwners:[],missing:[]},positions:[],retiredEmptyTokenIds:[]});
   assert.deepEqual(nftSnapshot.ownedTokenIds,[]);await custodyClient.query('COMMIT');
  }catch(error){await custodyClient.query('ROLLBACK');throw error;}finally{custodyClient.release();}
  const storedEmpty=(await db.query(`SELECT owned_token_ids,positions,retired_empty_token_ids FROM deployment_live_nft_custody_snapshots
   WHERE chain_id=4663 AND wallet=$1 AND position_manager=$2`,[wallet,nftManager])).rows[0];
  assert.deepEqual(storedEmpty.owned_token_ids,[]);assert.deepEqual(storedEmpty.positions,[]);assert.deepEqual(storedEmpty.retired_empty_token_ids,[]);
  const makeReview=async({requestId,token0Raw,token1Raw,nativeSpendWei='10',exitReserveWei='5',genOffset=0,commitmentsHash:givenHash}={})=>{
   const state=await readWalletState(db,{chainId:4663,address:wallet}),hash=givenHash??state.commitmentsHash;
   const parameters={tickLower:-60,tickUpper:60},parsedConfig=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
    operator:wallet,pool:{chainId:4663,factory:'0x6666666666666666666666666666666666666666',pool:'0x4444444444444444444444444444444444444444',
     token0,token1,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:'0x7777777777777777777777777777777777777777',
     router:'0x8888888888888888888888888888888888888888',quoter:'0x9999999999999999999999999999999999999999',
     poolCodeHash:`0x${'a'.repeat(64)}`,token0CodeHash:`0x${'a'.repeat(64)}`,token1CodeHash:`0x${'a'.repeat(64)}`,
     managerCodeHash:`0x${'a'.repeat(64)}`,quoterCodeHash:`0x${'a'.repeat(64)}`,reference0:'TOKEN0/USD',reference1:'TOKEN1/USD',nativeReference:'ETH/USD',numeraire:'USD'},
    limits:{fullWidthSpacings:120,maxDeploymentValue:'800',minDeploymentPpm:1,maxSwapInputValue:'10',maxSwapInputPpm:1,maxSwapShortfallValue:'1',
     maxSlippageBps:50,maxActionCost:'100',maxRollingCost:'100',maxCampaignCost:'100',maxExposurePpm:1,maxLossValue:'100',maxDrawdownPpm:1,
     maxRecenters:0,maxLiquiditySharePpm:1_000_000,maxObservationGapSeconds:90,exitReserveWei:'1'},signer:null,walletCode:{kind:'eoa'},
    zeroAllowances:[],legacyRetiredTokenIds:[],campaignScope:{maxDurationSeconds:43200,maxEconomicActions:2},
    referencePolicy,
    campaignValue:'1000',strategyFundingValue:'900',nativeFundingValue:'100'}),config=JSON.parse(JSON.stringify(parsedConfig,(_,v)=>typeof v==='bigint'?String(v):v)),configHash=rangeKeeperConfigHash(parsedConfig).slice(2),
    revisionConfig={...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1},revisionConfigHash=contentHash(revisionConfig),payload={
    schemaVersion:1,kind:'rangekeeper_live_setup_preflight',status:'indicative',mode:'live',profileId,profileHash,
    binding:{buildId:'b'.repeat(64),reviewHash:'c'.repeat(64)},source,
    wallet:{commitmentsHash:hash},policy:{config,configHash,parameters,parametersHash:contentHash(parameters)},
    requirements:{token0Raw:String(token0Raw),token1Raw:String(token1Raw),nativeWei:String(BigInt(nativeSpendWei)+BigInt(exitReserveWei))},
    references:{price0:'1',price1:'1',proofHash:'d'.repeat(64)},
   };
   const payloadHash=contentHash(payload),review=await recordReview(db,{chainId:4663,address:wallet,payload,payloadHash,buildId:'b'.repeat(64),source,
    expiresAt:new Date(Date.now()+120_000),walletGeneration:state.generation+genOffset,commitmentsHash:hash});
   return {review,payload,payloadHash,state,config:revisionConfig,configHash:revisionConfigHash};
  };
  const reserve=async({requestId,token0Raw,token1Raw,nativeSpendWei='10',exitReserveWei='5',review=undefined,verifySource=async()=>{}}={})=>{
   const prepared=review??await makeReview({requestId,token0Raw,token1Raw,nativeSpendWei,exitReserveWei});
   return consumeReviewAndReserve(db,{chainId:4663,address:wallet,requestId,requestDigest:contentHash({requestId,token0Raw,token1Raw,nativeSpendWei,exitReserveWei}),
    reviewId:prepared.review.reviewId,reviewHash:prepared.payloadHash,campaign:{wallet,marketProfileId:profileId,mode:'live',strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
     allocation:{token0Raw:String(token0Raw),token1Raw:String(token1Raw),nativeWei:String(BigInt(nativeSpendWei)+BigInt(exitReserveWei))},config:prepared.config,configHash:prepared.configHash,
     baseline:{requirements:prepared.payload.requirements,references:prepared.payload.references,source},source},
    allocation:{tokens:[{address:token0,amountRaw:String(token0Raw)},{address:token1,amountRaw:String(token1Raw)}],nativeSpendWei,exitReserveWei,nftTokenIds:[]},payload:prepared.payload,buildId:'b'.repeat(64),verifySource});
  };
  const first=await reserve({requestId:'first',token0Raw:'100',token1Raw:'70'});
  assert.equal(first.status,'queued');assert.equal(first.replayed,false);
  const liveCampaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1});
  const now=Math.floor(Date.now()/1000),liveSource={block:source.block,hash:source.hash,timestamp:source.timestamp};
  const runtimeSnapshot={source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},operator:wallet,
   wallet0:500n,wallet1:100n,nativeWei:1000n,nonce:17n,nftCount:0n,tick:0,sqrtPriceX96:1n,unlocked:true,
   poolLiquidity:0n,allowances:[],position:null};
  const runtimeState={version:1,id:first.campaignId,operator:wallet,configHash:liveCampaign.configHash,buildId:'b'.repeat(64),
   phase:'entry',desired:'running',haltReason:null,createdAt:now,expiresAt:now+43200,economicActions:0,recenters:0,
   policy:initialRangeKeeperState(liveCampaign.config,'b'.repeat(64)),last:runtimeSnapshot,activeTokenId:null,retiredTokenIds:[],legacyNftCount:0n,
   reserve0:0n,reserve1:0n,reserveNativeWei:0n,initial0:100n,initial1:70n,initialNativeWei:15n,initialStrategyValue:900n,
   candidate:null,swapDone:false,swapConfirmedAt:null,withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,
   collectedFee0:0n,collectedFee1:0n,gasSpentWei:0n,costEvents:[],highWaterValue:0n,activeSeconds:0,outsideSeconds:0,
   lastMarkTimestamp:now,lastReason:'opening_initialized',closedAt:null};
  const initialized=await initializeRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-initialize',kind:'initialized',expectedStateHash:null,state:runtimeState,source:liveSource,payload:{kind:'worker_open_initialize'},
   initial:{profileId:liveCampaign.profileId,profileHash:liveCampaign.profileHash,profile:liveCampaign.profile,config:liveCampaign.config,
    configHash:liveCampaign.configHash,revisionConfigHash:liveCampaign.revisionConfigHash,allocationId:first.allocationId,
    initialToken0Raw:'100',initialToken1Raw:'70',initialNativeWei:'15',baseline:liveCampaign.baseline}});
  assert.equal(initialized.replayed,false);
  assert.equal((await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId:first.campaignId})).state?.phase,'entry');
  // Apply the exact same persisted receipt twice: canonical economics are added once, from receipt-source references.
  const effectStage='approve:receipt-test',plan={kind:'approve',token:0,spender:'router',amount:1n},txHash=`0x${'9'.repeat(64)}`,
   receiptSource={block:String(BigInt(source.block)+1n),hash:`0x${'b'.repeat(64)}`,timestamp:source.timestamp+1},
   txReceipt={transactionHash:txHash,status:'success',gasUsed:'2',effectiveGasPrice:'5',blockNumber:receiptSource.block,blockHash:receiptSource.hash},
   txReceiptHash=liveSetupEvidenceHash(txReceipt),
   afterPool={...runtimeSnapshot,source:{block:BigInt(receiptSource.block),hash:receiptSource.hash,timestamp:receiptSource.timestamp},nonce:51n,nativeWei:990n};
  const intent={chainId:4663,operator:wallet,nonce:50,sourceBlock:source.block,sourceHash:source.hash,gas:'130',maxFeePerGas:'2',
   maxPriorityFeePerGas:'0',to:registeredProfile.pool.router,data:'0x1234',value:'0',action:'approve'};
  const beforeImage=JSON.parse(rangeKeeperJson({wallet:{source,operator:wallet,nonce:50,pendingNonce:50,nativeWei:'1000',tokens:{[token0]:'500',[token1]:'100'},nftTokenIds:[]},
   snapshot:{...runtimeSnapshot,nonce:50n},allocation:{}})),effectImage={receiptHash:txReceiptHash,proofHash:'e'.repeat(64),source:receiptSource,nonce:51,gasWei:'10',
    afterWallet:{nftTokenIds:[]},afterPool:JSON.parse(rangeKeeperJson(afterPool)),effects:null,
    referenceValuation:{source:receiptSource,proofHash:'f'.repeat(64),evidence:{fixture:true},price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'3000000000000000000'}};
  await db.query(`INSERT INTO deployment_live_stage_outbox(job_id,stage,chain_id,wallet,intent_json,plan_json,before_json,nonce,signed_raw,signed_raw_hash,status,
   canonical_receipt_json,effect_evidence_json) VALUES($1,$2,4663,$3,$4,$5,$6,50,'0x01',$7,'confirmed',$8,$9)`,
   [first.jobId,effectStage,wallet,JSON.stringify(intent),rangeKeeperJson(plan),JSON.stringify(beforeImage),txHash,
    JSON.stringify({receipt:txReceipt,receiptHash:txReceiptHash,proofHash:'e'.repeat(64),source:receiptSource}),JSON.stringify(effectImage)]);
  const auth={schemaVersion:1,kind:'rangekeeper_live_owned_stage_v1',campaignId:first.campaignId,allocationId:first.allocationId,revision:1,
   stage:effectStage,buildId:'b'.repeat(64),profileId:liveCampaign.profileId,profileHash:liveCampaign.profileHash,
   allocationHash:liveCampaign.allocation.allocationHash,configHash:liveCampaign.configHash.slice(2),source,
   referenceProofHash:'d'.repeat(64),planHash:liveSetupEvidenceHash(plan),calldataHash:'1'.repeat(64),
   gasUsed:'2',gasUnitsBound:'2',maxFeePerGasWei:'5',costValue:'1',forkReceiptHash:`0x${'3'.repeat(64)}`,evidenceHash:'4'.repeat(64),
   prices:{price0:'7000000000000000000',price1:'9000000000000000000',nativePrice:'99000000000000000000'}};
  const authDb=await db.connect();try{await authDb.query('BEGIN');await persistRangeKeeperLiveStageAuthorizationInTransaction(authDb,
   {jobId:first.jobId,chainId:4663,wallet,campaign:liveCampaign,stage:effectStage,authorized:{authorization:auth}});await authDb.query('COMMIT');
  }catch(error){await authDb.query('ROLLBACK');throw error;}finally{authDb.release();}
  const savedAuthorization=(await db.query(`SELECT calldata_hash,authorization_json FROM deployment_live_stage_authorizations
   WHERE job_id=$1 AND stage=$2`,[first.jobId,effectStage])).rows[0];
  assert.equal(savedAuthorization.calldata_hash,`0x${auth.calldataHash}`,'SQL column retains its prefixed digest format');
  assert.equal(savedAuthorization.authorization_json.calldataHash,auth.calldataHash,'Frozen capability retains its bare digest format');
  const reducerInput={job:{id:first.jobId,chainId:4663,wallet,campaignId:first.campaignId,revision:1,allocationId:first.allocationId,
   reviewId:'00000000-0000-4000-8000-000000000001',kind:'open',status:'reconciling',priority:0,payload:{},payloadHash:'',buildId:'b'.repeat(64),idempotencyKey:'first',requestDigest:'',
   leaseToken:null,leaseUntil:null,attempt:1,resumeStage:effectStage},outbox:{jobId:first.jobId,stage:effectStage,intent,plan,before:{},nonce:'50',status:'confirmed',
    raw:'0x01',hash:txHash,receipt:null,effects:null,cleanup:null}};
  const effectClient=await db.connect();let applied,replayed;try{await effectClient.query('BEGIN');
   applied=await applyRangeKeeperLiveReceiptEffectInTransaction(effectClient,reducerInput);
   replayed=await applyRangeKeeperLiveReceiptEffectInTransaction(effectClient,reducerInput);
   await effectClient.query('COMMIT');}catch(error){await effectClient.query('ROLLBACK');throw error;}finally{effectClient.release();}
  assert.equal(applied.replayed,false);assert.equal(replayed.replayed,true);assert.equal(applied.state.gasSpentWei,10n);
  assert.equal(applied.state.costEvents.at(-1).gasValue,30n);
  await db.query(`UPDATE deployment_live_stage_outbox SET effect_evidence_json=jsonb_set(effect_evidence_json,'{referenceValuation,price0}','"2000000000000000000"')
   WHERE job_id=$1 AND stage=$2`,[first.jobId,effectStage]);
  const alteredEffectClient=await db.connect();try{await assert.rejects(()=>applyRangeKeeperLiveReceiptEffectInTransaction(alteredEffectClient,reducerInput),/Receipt replay payload changed/);
  }finally{alteredEffectClient.release();}
  await db.query(`UPDATE deployment_live_stage_outbox SET effect_evidence_json=$3 WHERE job_id=$1 AND stage=$2`,[first.jobId,effectStage,JSON.stringify(effectImage)]);
  const afterEffectState=applied.state;
  const receiptEffect=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-stage-receipt',kind:'stage_receipt',expectedStateHash:applied.stateHash,state:afterEffectState,source:receiptSource,
   receiptHash:`0x${'1'.repeat(64)}`,payload:{stage:'mint',status:'confirmed'}});
  const receiptReplay=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-stage-receipt',kind:'stage_receipt',expectedStateHash:applied.stateHash,state:afterEffectState,source:receiptSource,
   receiptHash:`0x${'1'.repeat(64)}`,payload:{stage:'mint',status:'confirmed'}});
  assert.equal(receiptEffect.replayed,false);assert.equal(receiptReplay.replayed,true);
  assert.equal((await db.query('SELECT status FROM deployment_live_campaign_runtime WHERE campaign_id=$1',[first.campaignId])).rows[0].status,'starting');
  await assert.rejects(()=>appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-stage-receipt',kind:'stage_receipt',expectedStateHash:applied.stateHash,state:afterEffectState,source:receiptSource,
   receiptHash:`0x${'1'.repeat(64)}`,payload:{stage:'mint',status:'changed'}}),/replay payload changed/);
  const revertedState={...afterEffectState,phase:'halted',gasSpentWei:20n,costEvents:[...afterEffectState.costEvents,{hash:`0x${'2'.repeat(64)}`,block:BigInt(source.block),timestamp:source.timestamp,
   gasWei:10n,gasValue:3n,swapFeeValue:0n,swapShortfallValue:0n}],lastReason:'stage_reverted_gas_recorded'};
  const revertedEffect=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'reverted-stage-with-gas',kind:'stage_receipt',expectedStateHash:receiptEffect.stateHash,state:revertedState,source:receiptSource,
   receiptHash:`0x${'2'.repeat(64)}`,payload:{stage:'swap',status:'reverted',gasWei:'10'}});
  const revertedReplay=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'reverted-stage-with-gas',kind:'stage_receipt',expectedStateHash:receiptEffect.stateHash,state:revertedState,source:receiptSource,
   receiptHash:`0x${'2'.repeat(64)}`,payload:{stage:'swap',status:'reverted',gasWei:'10'}});
  assert.equal(revertedEffect.replayed,false);assert.equal(revertedReplay.replayed,true);
  assert.equal(revertedEffect.state.gasSpentWei,20n);
  const holdingState={...revertedState,phase:'holding',activeTokenId:999n,lastReason:'complete_open_reconciled'};
  const opened=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-cleanup-complete',kind:'opened',expectedStateHash:revertedEffect.stateHash,state:holdingState,source:receiptSource,
   receiptHash:`0x${'1'.repeat(64)}`,payload:{cleanup:{noPendingAction:true,custodyState:'managed'}}});
  const openedReplay=await appendRangeKeeperLiveCampaignEvent(db,{chainId:4663,address:wallet,campaignId:first.campaignId,revision:1,
   effectId:'open-cleanup-complete',kind:'opened',expectedStateHash:revertedEffect.stateHash,state:holdingState,source:receiptSource,
   receiptHash:`0x${'1'.repeat(64)}`,payload:{cleanup:{noPendingAction:true,custodyState:'managed'}}});
  assert.equal(opened.replayed,false);assert.equal(openedReplay.replayed,true);
  const activeCampaign=await readRangeKeeperLiveCampaign(db,{chainId:4663,address:wallet,campaignId:first.campaignId});
  assert.equal(activeCampaign.status,'active');assert.equal(activeCampaign.state?.phase,'holding');
  const tamperClient=await db.connect();try{await tamperClient.query('BEGIN');
   await tamperClient.query(`UPDATE deployment_live_campaign_runtime SET state_json=jsonb_set(state_json,'{economicActions}','1') WHERE campaign_id=$1`,[first.campaignId]);
   await assert.rejects(()=>readRangeKeeperLiveCampaign(tamperClient,{chainId:4663,address:wallet,campaignId:first.campaignId}),/state hash mismatch/);
   await tamperClient.query('ROLLBACK');
  }catch(error){await tamperClient.query('ROLLBACK');throw error;}finally{tamperClient.release();}
  const firstSnapshot=await readWalletState(db,{chainId:4663,address:wallet});
  const projected=await readLiveWalletCommitments(db,wallet,{source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},verifySource:async()=>{}});
  assert.equal(projected.status,'available');assert.equal(projected.rows[0]?.known,true);
  const firstRetry=await reserve({requestId:'first',token0Raw:'100',token1Raw:'70'});
  assert.equal(firstRetry.campaignId,first.campaignId);assert.equal(firstRetry.jobId,first.jobId);assert.equal(firstRetry.replayed,true);
  await assert.rejects(()=>reserve({requestId:'first',token0Raw:'99',token1Raw:'70'}),/IDEMPOTENCY_CONFLICT/);
  const failedCanonicalReview=await makeReview({token0Raw:'1',token1Raw:'1'});
  await assert.rejects(()=>reserve({requestId:'bad-source',token0Raw:'1',token1Raw:'1',review:failedCanonicalReview,verifySource:async()=>{throw Error('source reorg');}}),/source reorg/);
  // Shared token1 funds are conserved across two campaigns despite reversed token enumeration.
  const second=await reserve({requestId:'second',token0Raw:'200',token1Raw:'30'});assert.equal(second.status,'queued');
  const commitments=await readCommitments(db,{chainId:4663,address:wallet});
  const t1=commitments.allocations.flatMap(a=>a.tokens).filter(t=>t.address===token1).reduce((n,t)=>n+BigInt(t.allocatedRaw),0n);
  assert.equal(t1,100n);assert.equal(commitments.allocations.length,2);
  const state=await readWalletState(db,{chainId:4663,address:wallet});assert.equal(state.generation,3);
  assert.equal(state.commitmentsHash,liveWalletCommitmentFingerprint(commitments));
  assert.notEqual(state.snapshotHash,firstSnapshot.snapshotHash);
  const projectedTwice=await readLiveWalletCommitments(db,wallet,{source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},verifySource:async()=>{}});
  assert.equal(projectedTwice.status,'available');assert.equal(projectedTwice.rows.filter(r=>r.known).length,2);
  await assert.rejects(()=>releaseLiveWalletAllocation(db,{chainId:4663,address:wallet,allocationId:first.allocationId}),/must be canonically closed/);
  const manager='0x5555555555555555555555555555555555555555';
  await db.query(`INSERT INTO deployment_live_nft_custody(chain_id,wallet,position_manager,token_id,allocation_id,campaign_id,status,liquidity,tokens_owed0,tokens_owed1,source_block,source_hash,source_timestamp)
   VALUES(4663,$1,$2,999,$3,$4,'retired_empty',0,0,0,$5,$6,$7)`,[wallet,manager,first.allocationId,first.campaignId,source.block,source.hash,source.timestamp]);
  await db.query("UPDATE deployment_live_jobs SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1",[first.jobId]);
  await db.query("UPDATE deployment_campaigns SET lifecycle='closed',closed_at=clock_timestamp() WHERE id=$1",[first.campaignId]);
  const beforeRelease=await readWalletState(db,{chainId:4663,address:wallet});
  await releaseLiveWalletAllocation(db,{chainId:4663,address:wallet,allocationId:first.allocationId});
  const afterRelease=await readWalletState(db,{chainId:4663,address:wallet}),afterReleaseCommitments=await readCommitments(db,{chainId:4663,address:wallet});
  assert.equal(afterRelease.generation,beforeRelease.generation+1);
  assert.notEqual(afterRelease.snapshotHash,beforeRelease.snapshotHash);
  assert.equal(afterRelease.commitmentsHash,liveWalletCommitmentFingerprint(afterReleaseCommitments));
  const retired=(await db.query("SELECT allocation_id,campaign_id,status FROM deployment_live_nft_custody WHERE chain_id=4663 AND wallet=$1 AND position_manager=$2 AND token_id=999",[wallet,manager])).rows[0];
  assert.equal(retired.allocation_id,first.allocationId);assert.equal(retired.campaign_id,first.campaignId);assert.equal(retired.status,'retired_empty');
  const oversubReview=await makeReview({token0Raw:'301',token1Raw:'1',nativeSpendWei:'1',exitReserveWei:'1'});
  await assert.rejects(()=>consumeReviewAndReserve(db,{chainId:4663,address:wallet,requestId:'oversub',requestDigest:contentHash('oversub'),reviewId:oversubReview.review.reviewId,
   reviewHash:oversubReview.payloadHash,campaign:{wallet,marketProfileId:profileId,mode:'live',strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
    allocation:{token0Raw:'301',token1Raw:'1',nativeWei:'2'},config:oversubReview.config,configHash:oversubReview.configHash,
    baseline:{requirements:oversubReview.payload.requirements,references:oversubReview.payload.references,source},source},
   allocation:{tokens:[{address:token0,amountRaw:'301'},{address:token1,amountRaw:'1'}],nativeSpendWei:'1',exitReserveWei:'1',nftTokenIds:[]},payload:oversubReview.payload,buildId:'b'.repeat(64),verifySource:async()=>{}}),/oversubscribed/);
  // A fresh report cannot silently drop an address that still backs an allocation.
  await assert.rejects(()=>recordWalletSnapshot(db,{chainId:4663,address:wallet,source:{...source,block:'78211394'},nonce:'17',pendingNonce:'17',nativeBalanceWei:'1000',
   tokens:[{address:token1,balanceRaw:'100'}],commitmentsHash:state.commitmentsHash}),/omitted a token/);
  await assert.rejects(()=>recordWalletSnapshot(db,{chainId:4663,address:wallet,source:{...source,block:'78211394'},nonce:'18',pendingNonce:'18',nativeBalanceWei:'1000',
   tokens:[{address:token0,balanceRaw:'500'},{address:token1,balanceRaw:'100'}],commitmentsHash:afterRelease.commitmentsHash}),/receipt-bound allocation reconciliation/);
  await db.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision)
   VALUES($1,'live',4663,$2,$3,'{}','active',1)`,[randomUUID(),wallet,profileId]);
  const unknownReview=await makeReview({token0Raw:'1',token1Raw:'1'});
  await assert.rejects(()=>reserve({requestId:'unknown-predecessor',token0Raw:'1',token1Raw:'1',review:unknownReview}),/Unknown active deployment wallet commitment/);
  const stage='mint:0123456789abcdef0123456789abcdef',authClient=await db.connect();
  const stageEvidence={schemaVersion:1,kind:'rangekeeper_live_owned_stage_v1',status:'success',campaignId:first.campaignId,
   allocationId:first.allocationId,revision:1,stage,buildId:'b'.repeat(64),source:{block:source.block,hash:source.hash,timestamp:source.timestamp},
   profileHash:liveCampaign.profileHash,allocationHash:liveCampaign.allocation.allocationHash,configHash:liveCampaign.configHash.slice(2),
   referenceProofHash:'d'.repeat(64),planHash:'e'.repeat(64),calldataHash:'1'.repeat(64),beforeHash:'f'.repeat(64),requestHash:'a'.repeat(64),
   nonce:17,gasUsed:'100',gasUnitsBound:'130',maxFeePerGasWei:'2',priorityFeePerGasWei:'0',stageGasWei:'260',costValue:'1',
   forkReceiptHash:`0x${'3'.repeat(64)}`,evidenceHash:'4'.repeat(64),syntheticNativeFunding:true,expiresAt:Date.now()+60_000,
   referenceEvidence:{source,proof:'fixture'},referenceSource:source,prices:{price0:'1',price1:'1',nativePrice:'1'},profileId:liveCampaign.profileId};
  try{
   await authClient.query('BEGIN');
   await authClient.query(`INSERT INTO deployment_live_stage_outbox(job_id,stage,chain_id,wallet,intent_json,plan_json,before_json,nonce,status)
    VALUES($1,$2,4663,$3,'{}','{}','{}',17,'prepared')`,[first.jobId,stage,wallet]);
   const persistInput={jobId:first.jobId,chainId:4663,wallet,campaign:liveCampaign,stage,authorized:{authorization:stageEvidence}};
   const persisted=await persistRangeKeeperLiveStageAuthorizationInTransaction(authClient,persistInput);
   assert.equal(persisted.replayed,false);
   assert.equal((await persistRangeKeeperLiveStageAuthorizationInTransaction(authClient,persistInput)).replayed,true);
   const changed={...persistInput,authorized:{authorization:{...stageEvidence,costValue:'2'}}};
   await assert.rejects(()=>persistRangeKeeperLiveStageAuthorizationInTransaction(authClient,changed),/replay differs/);
   await authClient.query('COMMIT');
  }catch(error){await authClient.query('ROLLBACK');throw error;}finally{authClient.release();}
  const storedAuth=(await db.query(`SELECT authorization_json,authorization_hash,reference_proof_hash FROM deployment_live_stage_authorizations
   WHERE job_id=$1 AND stage=$2`,[first.jobId,stage])).rows[0];
  assert.equal(storedAuth.authorization_json.costValue,'1');assert.equal(storedAuth.reference_proof_hash,'d'.repeat(64));
}finally{await db.end();}
}finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await pool.end();}
console.log('live-wallet allocations isolated integration passed');
