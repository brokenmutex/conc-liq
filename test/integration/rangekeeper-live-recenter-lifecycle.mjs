// Isolated PostgreSQL qualification of automatic RangeKeeper management completeness at the store, queue and
// campaign-effect level: a full change_range lifecycle, stale-candidate re-planning after a confirmed withdrawal,
// safety-exit priority and non-starvation, restart/lease recovery mid-recenter, and multi-campaign isolation.
//
// The real LiveWalletQueue, worker, receipt-effect reducer, management transition/settlement/lifecycle code,
// planner and allocation store run against the database. Only the chain is modelled: stage planning, owned-fork
// authorization and canonical receipt attribution are deterministic fakes over an in-memory wallet model, and the
// signer signs locally with a throwaway key. Nothing is broadcast and no RPC client exists.
// Requires TEST_DATABASE_URL naming a disposable database; it creates and drops one isolated schema only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {keccak256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {recordWalletSnapshot,readCommitments,readWalletState,recordReview} from '../../src/deployments/live-wallet-store.ts';
import {LiveWalletQueue} from '../../src/deployments/live-wallet-queue.ts';
import {recordRangeKeeperLiveManagementReview,enqueueRangeKeeperLiveManagementReview} from '../../src/deployments/rangekeeper-live-management.ts';
import {readRangeKeeperLiveCampaign,persistRangeKeeperLiveStageAuthorizationInTransaction} from '../../src/deployments/rangekeeper-live-campaign-store.ts';
import {applyRangeKeeperLiveReceiptEffectInTransaction} from '../../src/deployments/rangekeeper-live-campaign-effects.ts';
import {createRangeKeeperLiveManagementPlanner} from '../../src/deployments/rangekeeper-live-management-planner.ts';
import {createRangeKeeperLiveWalletWorker} from '../../src/deployments/rangekeeper-live-wallet-worker.ts';
import {createRangeKeeperLiveWalletWorkerAdapters,settleRangeKeeperLiveManagementStage} from '../../src/deployments/rangekeeper-live-queue-adapters.ts';
import {isRangeKeeperAwaitingReplan,isRangeKeeperRetainedExit} from '../../src/deployments/rangekeeper-live-campaign.ts';
import {liveSetupEvidenceHash} from '../../src/deployments/rangekeeper-live-setup-simulation.ts';
import {RangeKeeperStaleCandidateError} from '../../src/strategy/rangekeeper/live-stage.ts';
import {parseRangeKeeperConfig,rangeKeeperConfigHash,initialRangeKeeperState} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperJson} from '../../src/strategy/rangekeeper/live-domain.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name a disposable isolated database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema=`rk_recenter_lifecycle_${randomUUID().replaceAll('-','')}`;

// ---------------------------------------------------------------- fixture constants
const signer=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),wallet=signer.address.toLowerCase(),walletIdentity={chainId:4663,address:wallet};
const token0='0x1000000000000000000000000000000000000001',token1='0x2000000000000000000000000000000000000002',manager='0x5000000000000000000000000000000000000005';
const buildId='b'.repeat(64),profileId=randomUUID();
const addr=n=>`0x${BigInt(n).toString(16).padStart(40,'0')}`,hash=c=>`0x${c.repeat(64)}`;
const limits={maxDeploymentValue:'1000',minDeploymentPpm:1,maxSwapInputValue:'1000',maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000',
 maxSlippageBps:50,maxActionCost:'1000',maxRollingCost:'1000',maxCampaignCost:'1000',maxExposurePpm:1000000,maxLossValue:'1000',
 maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:1000000,maxObservationGapSeconds:90,exitReserveWei:'1000',fullWidthSpacings:120};
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:addr(300),pool:addr(400),token0,token1,quoteToken:0,
 decimals0:6,decimals1:18,fee:500,tickSpacing:10,positionManager:manager,router:addr(600),quoter:addr(700),
 poolCodeHash:hash('1'),token0CodeHash:hash('2'),token1CodeHash:hash('3'),managerCodeHash:hash('4'),quoterCodeHash:hash('5'),
 reference0:'USDG/USD',reference1:'TEST/USD',nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 token1:{kind:'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const profileHash=contentHash(profile);
const config=parseRangeKeeperConfig({schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',broadcastEnabled:false,
 operator:wallet,pool:profile.pool,limits,signer:null,walletCode:{kind:'eoa'},zeroAllowances:[],legacyRetiredTokenIds:[],
 campaignScope:{maxDurationSeconds:43200,maxEconomicActions:6},referencePolicy:profile.referencePolicy,
 campaignValue:'2000000000000000000',strategyFundingValue:'1000000000000000000',nativeFundingValue:'2000'});
const configHash=rangeKeeperConfigHash(config),configJson=JSON.parse(JSON.stringify(config,(_,v)=>typeof v==='bigint'?String(v):v));
const revisionConfig={...limits,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1};
const nowSec=Math.floor(Date.now()/1000);
// Canonical wallet source clock. Each modelled block advances it by one second and stays within the freshness bounds.
let clock=nowSec-30,blockNumber=78_211_000n;
const blocks=new Map();
const sourceAt=(n,ts)=>({block:String(n),hash:`0x${n.toString(16).padStart(64,'0')}`,timestamp:ts});
const registerBlock=source=>{blocks.set(BigInt(source.block),{hash:source.hash,timestamp:source.timestamp});return source;};
const source0=registerBlock(sourceAt(blockNumber,clock));
const nextSource=()=>{blockNumber+=100n;clock+=1;return registerBlock(sourceAt(blockNumber,clock));};

// ---------------------------------------------------------------- in-memory canonical wallet model
const model={nonce:5,native:100_000n,t0:1000n,t1:1000n,nfts:new Map(),active:new Map(),allowances:new Map(),nextNft:99};
const nftOf=(liquidity)=>({liquidity,owed0:0n,owed1:0n,lower:-60,upper:60});
const allowanceList=()=>[token0,token1].flatMap(token=>['positionManager'].map(spender=>({token,spender:manager,amount:model.allowances.get(`${token}:${spender}`)??0n})));
const positionOf=id=>{const n=model.nfts.get(String(id));return n?{tokenId:BigInt(id),owner:wallet,token0,token1,fee:500,tickLower:n.lower,tickUpper:n.upper,
 liquidity:n.liquidity,tokensOwed0:n.owed0,tokensOwed1:n.owed1}:null;};
const snapshotAt=(source,tokenId,unlocked=true)=>({source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},operator:wallet,
 wallet0:model.t0,wallet1:model.t1,nativeWei:model.native,nonce:BigInt(model.nonce),nftCount:BigInt(model.nfts.size),tick:0,sqrtPriceX96:1n<<96n,
 unlocked,poolLiquidity:100_000n,allowances:allowanceList(),position:tokenId===null||tokenId===undefined?null:positionOf(tokenId)});
const prices={price0:'1000000',price1:'1000000000000000000',nativePrice:'1000000000000000000'};
const refsAt=source=>({source,price0:1_000_000n,price1:10n**18n,nativePrice:10n**18n,proofHash:'d'.repeat(64),evidence:{kind:'synthetic_test_reference'}});
const fakeClient={getBlock:async args=>{
  if(args?.blockNumber!==undefined){const b=blocks.get(BigInt(args.blockNumber));if(!b)throw Error(`unknown block ${args.blockNumber}`);
   return {number:BigInt(args.blockNumber),hash:b.hash,timestamp:BigInt(b.timestamp),baseFeePerGas:1n};}
  const top=[...blocks.keys()].reduce((a,b)=>a>b?a:b);return {number:top+1000n,hash:blocks.get(top).hash,timestamp:BigInt(blocks.get(top).timestamp),baseFeePerGas:1n};},
 getGasPrice:async()=>1n};

try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);await migrateDatabase(admin);
 const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
 const db=new pg.Pool({connectionString:url.toString(),max:10});
 try{
  // ------------------------------------------------------------ seed four active campaigns on one wallet
  await db.query(`INSERT INTO deployment_market_profiles(id,chain_id,pool_address,token0_address,token1_address,token0_decimals,
   token1_decimals,quote_token,fee,tick_spacing,profile,evidence,profile_hash,verified_at)
   VALUES($1,4663,$2,$3,$4,6,18,0,500,10,$5,'{}',$6,clock_timestamp())`,[profileId,profile.pool.pool,token0,token1,profile,profileHash]);
  const emptyHash=liveWalletCommitmentFingerprint({wallet:walletIdentity,allocations:[],nftCustody:[]});
  const tokens=()=>[{address:token0,balanceRaw:String(model.t0)},{address:token1,balanceRaw:String(model.t1)}];
  await recordWalletSnapshot(db,{...walletIdentity,source:source0,nonce:'5',pendingNonce:'5',nativeBalanceWei:String(model.native),tokens:tokens(),commitmentsHash:emptyHash});
  const campaigns=[];
  for(const [label,nft] of [['A','77'],['B','88'],['C','66'],['D','55']]){
   const c={label,nft,campaignId:randomUUID(),allocationId:randomUUID(),openReviewId:randomUUID(),openJobId:randomUUID()};campaigns.push(c);
   model.nfts.set(nft,nftOf(10_000n));model.active.set(c.campaignId,nft);
   await db.query(`INSERT INTO deployment_campaigns(id,mode,chain_id,wallet,market_profile_id,allocation,lifecycle,current_revision,runtime_identity)
    VALUES($1,'live',4663,$2,$3,$4,'opening',1,$5)`,[c.campaignId,wallet,profileId,{token0Raw:'100',token1Raw:'100',nativeWei:'2000'},{buildId,source:source0}]);
   await db.query(`INSERT INTO deployment_revisions(campaign_id,revision,parent_revision,strategy_id,strategy_version,state_schema_version,config,config_hash)
    VALUES($1,1,NULL,'rangekeeper_v1','1.0.0',1,$2,$3)`,[c.campaignId,revisionConfig,contentHash(revisionConfig)]);
   await db.query(`INSERT INTO deployment_live_allocations(id,chain_id,wallet,campaign_id,revision,state,native_spend_wei,exit_reserve_wei,
    source_generation,source_hash,allocation_hash) VALUES($1,4663,$2,$3,1,'reserved',1000,1000,1,$4,$5)`,[c.allocationId,wallet,c.campaignId,source0.hash,'c'.repeat(64)]);
   await db.query(`INSERT INTO deployment_live_allocation_tokens(allocation_id,chain_id,wallet,token_address,allocated_raw)
    VALUES($1,4663,$2,$3,100),($1,4663,$2,$4,100)`,[c.allocationId,wallet,token0,token1]);
   await db.query(`INSERT INTO deployment_live_nft_custody(chain_id,wallet,position_manager,token_id,allocation_id,campaign_id,status,
    liquidity,tokens_owed0,tokens_owed1,source_block,source_hash,source_timestamp)
    VALUES(4663,$1,$2,$3,$4,$5,'active',10000,0,0,$6,$7,$8)`,[wallet,manager,nft,c.allocationId,c.campaignId,source0.block,source0.hash,source0.timestamp]);
  }
  const seededHash=liveWalletCommitmentFingerprint(await readCommitments(db,walletIdentity));
  const seeded=await recordWalletSnapshot(db,{...walletIdentity,source:source0,nonce:'5',pendingNonce:'5',nativeBalanceWei:String(model.native),tokens:tokens(),commitmentsHash:seededHash});
  const setupPayload=extra=>({schemaVersion:1,kind:'rangekeeper_live_setup_preflight',mode:'live',strategyId:'rangekeeper_v1',
   profileId,profileHash,source:source0,wallet:{address:wallet,source:source0,nonce:'5',commitmentsHash:'0'.repeat(64)},
   requirements:{token0Raw:'100',token1Raw:'100',nativeWei:'2000'},references:{price0:'1',price1:'1',nativePrice:'1',proofHash:'d'.repeat(64)},
   policy:{config:configJson,configHash:configHash.slice(2),parameters:limits},binding:{buildId},missing:[],executionEligible:false,...extra});
  for(const c of campaigns){
   const payload=setupPayload({campaignId:c.campaignId}),review=await recordReview(db,{...walletIdentity,reviewId:c.openReviewId,payload,payloadHash:contentHash(payload),
    buildId,source:source0,expiresAt:new Date(Date.now()+600_000),walletGeneration:seeded.generation,commitmentsHash:seededHash});
   await db.query(`INSERT INTO deployment_live_jobs(id,chain_id,wallet,campaign_id,revision,allocation_id,review_id,kind,status,payload,
    payload_hash,build_id,idempotency_key,request_digest,completed_at)
    VALUES($1,4663,$2,$3,1,$4,$5,'open','succeeded',$6,$7,$8,$9,$10,clock_timestamp())`,
    [c.openJobId,wallet,c.campaignId,c.allocationId,review.reviewId,payload,contentHash(payload),buildId,`fixture-open-${c.label}`,'e'.repeat(64)]);
   const state={version:1,id:c.campaignId,operator:wallet,configHash,buildId,phase:'holding',desired:'running',exitMode:null,haltReason:null,
    createdAt:source0.timestamp-1,expiresAt:source0.timestamp+43200,economicActions:1,recenters:0,policy:initialRangeKeeperState(config,buildId),
    last:snapshotAt(source0,c.nft),activeTokenId:BigInt(c.nft),retiredTokenIds:[],legacyNftCount:0n,reserve0:0n,reserve1:0n,reserveNativeWei:0n,
    initial0:100n,initial1:100n,initialNativeWei:2000n,initialStrategyValue:1n,candidate:null,swapDone:false,swapConfirmedAt:null,
    withdrawDone:false,actionStartCostIndex:0,reservedActionCost:0n,mintRecoveryAttempts:0,collectedFee0:0n,collectedFee1:0n,
    gasSpentWei:0n,costEvents:[],highWaterValue:1n,activeSeconds:1,outsideSeconds:0,lastMarkTimestamp:source0.timestamp,
    lastReason:'live_open_reserved',closedAt:null};
   const stateJson=JSON.parse(rangeKeeperJson(state));
   await db.query(`INSERT INTO deployment_live_campaign_runtime(campaign_id,revision,chain_id,wallet,profile_id,profile_hash,config_hash,
    allocation_id,state_json,state_hash,state_revision,source_block,source_hash,source_timestamp,status,initial_token0_raw,initial_token1_raw,
    initial_native_wei,initial_baseline,opened_at) VALUES($1,1,4663,$2,$3,$4,$5,$6,$7,$8,4,$9,$10,$11,'active',100,100,2000,$12,clock_timestamp())`,
    [c.campaignId,wallet,profileId,profileHash,configHash.slice(2),c.allocationId,stateJson,contentHash(stateJson),source0.block,source0.hash,source0.timestamp,
     {requirements:{nativeWei:'2000'},references:{},source:source0}]);
   await db.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[c.campaignId]);
   await db.query(`UPDATE deployment_live_allocations SET state='active' WHERE id=$1`,[c.allocationId]);
  }
  const [A,B,C,D]=campaigns;
  const campaignOf=c=>readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId:c.campaignId});
  const jobRow=async id=>(await db.query('SELECT * FROM deployment_live_jobs WHERE id=$1',[id])).rows[0];
  const stagesOf=async jobId=>(await db.query(`SELECT stage,status,nonce,signed_raw,plan_json FROM deployment_live_stage_outbox WHERE job_id=$1 ORDER BY created_at,stage`,[jobId])).rows;
  const allocationRow=async c=>(await db.query(`SELECT a.state,a.native_spend_wei,a.exit_reserve_wei,a.allocation_hash FROM deployment_live_allocations a WHERE a.id=$1`,[c.allocationId])).rows[0];
  const liquidOf=async c=>Object.fromEntries((await db.query(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1`,[c.allocationId])).rows.map(r=>[r.token_address,BigInt(r.allocated_raw)]));
  const custodyOf=async c=>(await db.query(`SELECT token_id,status,liquidity FROM deployment_live_nft_custody WHERE allocation_id=$1 ORDER BY token_id`,[c.allocationId])).rows
   .map(r=>({id:String(r.token_id),status:r.status,liquidity:BigInt(r.liquidity)}));
  const eventsOf=async c=>(await db.query(`SELECT kind,payload->>'kind' payload_kind FROM deployment_live_runtime_events WHERE campaign_id=$1 ORDER BY sequence`,[c.campaignId])).rows;

  // ------------------------------------------------------------ canonical-wallet model plumbing (fakes)
  let signCalls=0,publishCalls=0,reconcileFailures=0,failNextPublish=false,holdPublishKind=null,failBoundKind=null;
  const forceStale=new Set(),unlocked=new Map();
  const kindOfStage=async(jobId,stage)=>(await db.query(`SELECT plan_json->>'kind' kind FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2`,[jobId,stage])).rows[0]?.kind;
  const walletRow=async client=>(await client.query(`SELECT generation,nonce,pending_nonce,native_balance_wei,source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0];
  const applyToModel=(campaignId,plan)=>{
   const out={retired:[],fees:null};
   if(plan.kind==='withdraw'){const id=String(plan.tokenId),n=model.nfts.get(id);model.t0+=30n;model.t1+=40n;n.liquidity=0n;
    model.active.set(campaignId,null);out.retired=[id];out.fees={fee0:'3',fee1:'4'};}
   else if(plan.kind==='approve')model.allowances.set(`${plan.token===0?token0:token1}:${plan.spender}`,plan.amount);
   else if(plan.kind==='swap'){model.t0-=plan.amountIn;model.t1+=plan.minOut+1n;}
   else if(plan.kind==='mint'){const id=String(model.nextNft++);model.nfts.set(id,nftOf(5_000n));model.active.set(campaignId,id);model.t0-=60n;model.t1-=60n;}
   return out;
  };
  const queueAdapters={
   authorizeStage:async(client,{job,stage,intent,plan,allocation,walletState})=>{
    const campaign=await readRangeKeeperLiveCampaign(client,{...walletIdentity,campaignId:job.campaignId,revision:job.revision});
    const rows=(await client.query(`SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows;
    const allocTokens=(await client.query(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1`,[job.allocationId])).rows;
    const source={block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)};
    const authorization={schemaVersion:1,kind:'rangekeeper_live_owned_stage_v1',status:'success',campaignId:job.campaignId,allocationId:job.allocationId,
     revision:job.revision,stage,buildId,source,profileId:campaign.profileId,profileHash:campaign.profileHash,allocationHash:campaign.allocation.allocationHash,
     configHash:campaign.configHash.slice(2),referenceProofHash:'d'.repeat(64),planHash:liveSetupEvidenceHash(plan),calldataHash:'1'.repeat(64),
     beforeHash:'f'.repeat(64),requestHash:'a'.repeat(64),exitSpendAllowed:false,nonce:intent.nonce,gasUsed:'10',gasUnitsBound:'13',maxFeePerGasWei:'5',
     priorityFeePerGasWei:'0',stageGasWei:'65',costValue:'65',forkReceiptHash:hash('3'),evidenceHash:'4'.repeat(64),syntheticNativeFunding:true,
     expiresAt:Date.now()+60_000,referenceEvidence:{fixture:true},referenceSource:source,prices};
    return {intent,plan,pool:{fixture:true},authorization,before:{walletGeneration:Number(walletState.generation),
     wallet:{operator:wallet,source,nonce:Number(walletState.nonce),pendingNonce:Number(walletState.pending_nonce),nativeWei:BigInt(walletState.native_balance_wei),
      tokens:Object.fromEntries(rows.map(t=>[t.token_address,BigInt(t.balance_raw)])),nftTokenIds:[...model.nfts.keys()].sort(),allowances:allowanceList()},
     allocation:{campaignId:job.campaignId,liquidByTokenAddress:Object.fromEntries(allocTokens.map(t=>[t.token_address,BigInt(t.allocated_raw)])),
      nativeSpendWei:BigInt(allocation.native_spend_wei),exitReserveWei:BigInt(allocation.exit_reserve_wei),nftTokenIds:campaign.allocation.nftTokenIds},
     snapshot:snapshotAt(source,campaign.state.activeTokenId)}};
   },
   persistStageAuthorization:async(client,{job,outbox,authorized})=>{
    const campaign=await readRangeKeeperLiveCampaign(client,{...walletIdentity,campaignId:job.campaignId,revision:job.revision});
    await persistRangeKeeperLiveStageAuthorizationInTransaction(client,{jobId:job.id,chainId:4663,wallet,campaign,stage:outbox.stage,authorized});
   },
   reconcile:async(client,{job,outbox,allocation})=>{
    if(reconcileFailures>0){reconcileFailures--;throw Error('HTTP 503 independent reference outage');}
    const plan=outbox.plan,before={t0:model.t0,t1:model.t1};
    const allocated=Object.fromEntries(allocation.tokens.map(t=>[t.token_address,BigInt(t.allocated_raw)]));
    const effect=applyToModel(job.campaignId,plan);model.nonce+=1;model.native-=50n;
    const source=nextSource(),activeAfter=model.active.get(job.campaignId)??null;
    const tokenForSnapshot=effect.retired.length?effect.retired[0]:activeAfter;
    const receipt={transactionHash:outbox.hash,status:'success',gasUsed:'10',effectiveGasPrice:'5',blockNumber:source.block,blockHash:source.hash};
    const afterWallet={operator:wallet,source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},nonce:model.nonce,pendingNonce:model.nonce,
     nativeWei:model.native,tokens:{[token0]:model.t0,[token1]:model.t1},nftTokenIds:[...model.nfts.keys()].sort(),allowances:allowanceList()};
    return {receipt,receiptHash:liveSetupEvidenceHash(receipt),proofHash:'e'.repeat(64),effects:effect.fees,gasWei:50n,status:'success',
     source:afterWallet.source,afterWallet,afterPool:snapshotAt(source,tokenForSnapshot),
     referenceValuation:{source,proofHash:'f'.repeat(64),evidence:{fixture:true},...prices},
     nextLiquidByTokenAddress:{[token0]:allocated[token0]+model.t0-before.t0,[token1]:allocated[token1]+model.t1-before.t1},
     nextNativeSpendWei:BigInt(allocation.native_spend_wei)-50n,nextExitReserveWei:BigInt(allocation.exit_reserve_wei),
     nextNftTokenIds:activeAfter?[activeAfter]:[],retiredNftTokenIds:effect.retired,positionManager:manager,
     position:activeAfter?positionOf(activeAfter):null};
   },
   afterReceipt:async(client,args)=>{await applyRangeKeeperLiveReceiptEffectInTransaction(client,args);},
   verifyCleanup:async(client,{job,allocation,walletState})=>{
    const campaign=await readRangeKeeperLiveCampaign(client,{...walletIdentity,campaignId:job.campaignId,revision:job.revision});
    const closed=job.kind.startsWith('close_')||isRangeKeeperRetainedExit(campaign.state);
    return {allowances:[{token:token0,spender:manager,amount:'0'}],allocationHash:allocation.allocation_hash,
     source:{block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)},
     noPendingAction:true,custodyState:closed?'closed_empty':'managed'};
   },
  };
  const queue=new LiveWalletQueue(db,queueAdapters);

  // Stage planning: withdraw -> approve -> swap -> mint -> cleanup (recenter); withdraw -> cleanup (exit).
  const nextStage=async({job})=>{
   const campaign=await campaignOf({campaignId:job.campaignId}),s=campaign.state;
   if(isRangeKeeperAwaitingReplan(s))return {kind:'wait',reason:'awaiting_replan'};
   if(forceStale.has(job.campaignId)&&s.phase==='recenter'&&s.withdrawDone&&!s.swapDone&&s.activeTokenId===null&&s.candidate){
    forceStale.delete(job.campaignId);throw new RangeKeeperStaleCandidateError('Current swap would leave the approved range');
   }
   const allowed=(token,key)=>(model.allowances.get(`${token}:${key}`)??0n)>0n;
   let plan=null;
   if(s.phase==='recenter'||s.phase==='exit'){
    if(s.activeTokenId!==null)plan={kind:'withdraw',tokenId:s.activeTokenId,liquidity:model.nfts.get(String(s.activeTokenId)).liquidity,min0:0n,min1:0n,deadline:BigInt(clock+300)};
    else if(s.phase==='recenter'&&s.candidate){
     if(!allowed(token0,'positionManager'))plan={kind:'approve',token:0,spender:'positionManager',amount:100n};
     else if(s.candidate.swap&&!s.swapDone)plan={kind:'swap',token:0,amountIn:20n,minOut:18n,deadline:BigInt(clock+300)};
     else plan={kind:'mint',candidate:s.candidate,deadline:BigInt(clock+300)};
    }else if(s.phase==='exit'&&allowed(token0,'positionManager'))plan={kind:'approve',token:0,spender:'positionManager',amount:0n};
   }else if(s.phase==='holding'&&allowed(token0,'positionManager'))plan={kind:'approve',token:0,spender:'positionManager',amount:0n};
   if(!plan)return {kind:'complete'};
   if(failBoundKind===plan.kind){failBoundKind=null;throw Error('Stage would invade reserved exit gas');}
   const row=await walletRow(db);
   const intent={id:randomUUID(),chainId:4663,operator:wallet,action:plan.kind,nonce:Number(row.nonce),to:manager,data:'0x1234',value:'0',gas:'200000',
    maxFeePerGas:'5',maxPriorityFeePerGas:'0',sourceBlock:String(row.source_block),sourceHash:row.source_hash};
   return {kind:'stage',value:{stage:`${plan.kind}:${campaign.stateRevision}:${job.id.slice(0,8)}`,intent,plan}};
  };
  const buildWorker=(options={})=>{
   const real=createRangeKeeperLiveWalletWorkerAdapters({pool:db,client:{},walletAddress:wallet,transferStore:{},loadProfiles:async()=>[],
    rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused'});
   const adapters={...real,nextStage,verifyPreparedIntent:async()=>true,waitForCanonicalReceipt:async()=>{},
    hasCanonicalReceipt:async({job,stage})=>!(holdPublishKind&&await kindOfStage(job.id,stage)===holdPublishKind),
    signIntent:async intent=>{signCalls++;return signer.signTransaction({type:'eip1559',chainId:4663,nonce:intent.nonce,to:intent.to,data:intent.data,value:0n,
     gas:BigInt(intent.gas),maxFeePerGas:BigInt(intent.maxFeePerGas),maxPriorityFeePerGas:BigInt(intent.maxPriorityFeePerGas)});},
    publishRaw:async raw=>{publishCalls++;if(failNextPublish){failNextPublish=false;throw Error('HTTP 503 publisher unavailable');}return keccak256(raw);},
    settleManagementStage:({job,error})=>settleRangeKeeperLiveManagementStage(db,{job,error,
     readSnapshot:async(campaign,source)=>snapshotAt({block:String(source.block),hash:source.hash,timestamp:source.timestamp},campaign.state.activeTokenId)})};
   return {real,adapters,worker:createRangeKeeperLiveWalletWorker({queue,wallet:walletIdentity,adapters,options:{signerEnabled:true,publisherEnabled:true,
    leaseMs:60_000,blockRetryMs:0,...options}})};
  };
  let {real,worker}=buildWorker();
  // Blocked jobs retry on a lease timer and parked jobs on a short fuse; collapse both so tests do not sleep.
  const release=async()=>{
   await db.query(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE status='blocked' AND lease_token IS NOT NULL`);
   await db.query(`UPDATE deployment_live_jobs SET updated_at=updated_at-interval '2 minutes' WHERE status='queued' AND attempt>0`);
  };
  const exec=async()=>{await release();return worker.execute();};

  // ------------------------------------------------------------ management review helpers
  const frozenCosts=(source,gas='400',value='900')=>({status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:gas,actionGasWei:gas,
   actionCostValue:value,gasValueUsdX18:gas});
  const positionValuation=id=>({tokenId:String(id),liquidityRaw:String(positionOf(id).liquidity),principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',
   uncollected1Raw:'0',inventory0Raw:'100',inventory1Raw:'100'});
  const deps={buildId,verifyPinned:async()=>true,pool:db,enqueue:job=>queue.enqueue(job)};
  const enqueueRecenter=async c=>{
   const campaign=await campaignOf(c),wstate=await readWalletState(db,walletIdentity),source=wstate.source;
   const candidate={kind:'recenter',range:{tickLower:-30,tickUpper:30},swap:{token:0,amountIn:20n,quotedOut:19n,minOut:18n,priceAfter:1n<<96n,feeValue:0n,shortfallValue:1n},
    amount0Desired:60n,amount1Desired:60n,amount0Min:59n,amount1Min:59n,liquidity:5000n,deployedValue:100n,sourceBlock:BigInt(source.block),
    sourceHash:source.hash,expiresAt:source.timestamp+90};
   const policy={...initialRangeKeeperState(config,buildId),lastEligible:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp}};
   const review=await recordRangeKeeperLiveManagementReview(db,{wallet:walletIdentity,campaign,operationKind:'change_range',source,snapshot:snapshotAt(source,c.nft),
    references:refsAt(source),position:positionValuation(c.nft),decision:{reason:'confirmed_outside_range',observationHash:'f'.repeat(64)},candidate,policy,
    costs:frozenCosts(source),expiresAt:source.timestamp+90},{buildId,verifyPinned:async()=>true});
   assert.equal(review.status,'indicative',JSON.stringify(review));
   return enqueueRangeKeeperLiveManagementReview({wallet:walletIdentity,campaignId:c.campaignId,previewId:review.previewId,contentDigest:review.contentDigest,
    expectedRevision:1,idempotencyKey:`recenter-${c.label}-${randomUUID()}`,expectedOperationKind:'change_range'},deps);
  };

  // ------------------------------------------------------------ planner with fake observation and owned fork
  const synthetic=(campaign)=>{
   const last=campaign.state.last.source,pass=campaign.state.policy.confirmation?2:1;
   // The first fresh observation must clear the planner's 30 s decision interval after the
   // last eligible decision; the second stays inside the 90 s confirmation window.
   return registerBlock(sourceAt(last.block+BigInt(pass*10),last.timestamp+(pass===1?31:62)));
  };
  const observer={
   observeForManagement:async campaign=>{
    const state=campaign.state,isLocked=unlocked.get(campaign.id??campaign.campaignId)===false;
    if(state.phase==='recenter'){
     const source=synthetic(campaign);
     return {source,snapshot:snapshotAt(source,state.activeTokenId,!isLocked),references:refsAt(source),position:state.activeTokenId===null?null:positionValuation(state.activeTokenId),
      decision:{reason:'fixture',observationHash:'f'.repeat(64)},costs:null,expiresAt:source.timestamp+90};
    }
    const wsource=(await readWalletState(db,walletIdentity)).source;
    return {source:wsource,snapshot:snapshotAt(wsource,state.activeTokenId,!isLocked),references:refsAt(wsource),position:positionValuation(state.activeTokenId),
     decision:{reason:'fixture',observationHash:'f'.repeat(64)},costs:null,expiresAt:wsource.timestamp+90};
   },
   observe:async campaign=>{
    const wsource=(await readWalletState(db,walletIdentity)).source;
    return {source:wsource,snapshot:snapshotAt(wsource,campaign.state.activeTokenId),references:refsAt(wsource),position:positionValuation(campaign.state.activeTokenId),
     decision:{reason:'retain_only_preview',observationHash:'f'.repeat(64)},costs:frozenCosts(wsource,'200','200'),missing:[],expiresAt:wsource.timestamp+90};
   },
   verifyPinned:async()=>true,
  };
  let forkRuns=0;
  const planner=createRangeKeeperLiveManagementPlanner({pool:db,client:fakeClient,wallet:walletIdentity,rpcUrl:'http://127.0.0.1:1',anvilBinary:'/unused',buildId,
   enabled:true,observer,queueReady:()=>real.managementObservationReady(),enqueue:job=>queue.enqueue(job),
   runFork:async input=>{forkRuns++;return {source:input.source,createdTokenId:99n,gasByStage:[
    {phase:'entry',kind:'approve',gasUsed:50n,estimatedGas:50n},{phase:'entry',kind:'mint',gasUsed:100n,estimatedGas:100n},
    {phase:'exit',kind:'withdraw',gasUsed:100n,estimatedGas:100n}]};}});

  // ============================================================ S0: admission beside queued sibling work
  const jobA=await enqueueRecenter(A);assert.equal(jobA.status,'queued',JSON.stringify(jobA));
  const jobD=await enqueueRecenter(D);
  assert.equal(jobD.status,'queued','a second campaign is admitted while a sibling recenter is queued');
  assert.equal((await jobRow(jobA.jobId)).status,'queued');
  const lane=await real.managementObservationReady();assert.equal(lane,true,'queued work alone does not stop observation or admission');

  // ============================================================ S1: A withdraws, then its candidate goes stale
  const frozenBefore=await Promise.all([B,C].map(async c=>({c,hash:(await campaignOf(c)).stateHash,liquid:await liquidOf(c),alloc:await allocationRow(c)})));
  let r=await exec();
  assert.equal(r.status,'reconciled',JSON.stringify(r));assert.equal(r.jobId,jobA.jobId,'oldest campaign is served first');assert.match(r.stage,/^withdraw:/);
  let a=(await campaignOf(A)).state;
  assert.equal(a.phase,'recenter');assert.equal(a.activeTokenId,null);assert.equal(a.withdrawDone,true);assert.deepEqual(a.retiredTokenIds,['77']);
  assert.equal(a.costEvents.length,1,'the withdraw receipt is attributed once');
  assert.deepEqual((await custodyOf(A)).map(n=>[n.id,n.status,n.liquidity]),[['77','retired_empty',0n]],'the retired NFT is recorded in custody');
  forceStale.add(A.campaignId);
  r=await exec();
  assert.deepEqual([r.status,r.reason],['blocked','stale_recenter_replan'],JSON.stringify(r));
  a=(await campaignOf(A)).state;
  assert.equal(isRangeKeeperAwaitingReplan(a),true);assert.equal(a.candidate,null);assert.equal(a.withdrawDone,true);assert.equal(a.costEvents.length,1);
  assert.equal((await jobRow(jobA.jobId)).status,'blocked');
  assert.equal((await stagesOf(jobA.jobId)).filter(s=>s.plan_json.kind==='withdraw').length,1,'the confirmed withdrawal is never repeated');

  // ============================================================ S2: planner observes every campaign; exit admitted beside a blocked sibling
  unlocked.set(B.campaignId,false);
  const pass1=await planner.observeAndEnqueueManagement();
  assert.equal(pass1.status,'observed');assert(pass1.processed>=3,`planner observed all active campaigns: ${JSON.stringify(pass1.results)}`);
  const aAfterPass1=(await campaignOf(A)).state;
  assert(aAfterPass1.policy.confirmation,'the stale recenter gets its first fresh confirmation');assert.equal(aAfterPass1.candidate,null);
  const exitJobs=(await db.query(`SELECT id,status FROM deployment_live_jobs WHERE campaign_id=$1 AND kind='close_retain'`,[B.campaignId])).rows;
  assert.equal(exitJobs.length,1,'the safety exit is enqueued although a sibling job is blocked and another is queued');assert.equal(exitJobs[0].status,'queued');
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_jobs WHERE campaign_id=$1 AND kind='close_retain'`,[C.campaignId])).rows[0].n,0,'a campaign inside its range is left alone');
  const dJob=await jobRow(jobD.jobId);assert.equal(dJob.status,'queued','a campaign with its own queued job is not re-planned');

  // ============================================================ S3: exit priority; blocked sibling yields; sibling receipts do not touch A, C
  const aHashBeforeExit=(await campaignOf(A)).stateHash;
  r=await exec();
  assert.equal(r.jobId,exitJobs[0].id,'the exit runs before the older queued discretionary recenter and the blocked one');assert.equal(r.status,'reconciled');
  assert.equal((await jobRow(jobA.jobId)).status,'queued','the blocked recenter yielded the active slot');
  r=await exec();assert.equal(r.status,'completed',JSON.stringify(r));assert.equal(r.jobId,exitJobs[0].id);
  assert.equal((await db.query(`SELECT lifecycle FROM deployment_campaigns WHERE id=$1`,[B.campaignId])).rows[0].lifecycle,'closed');
  assert.equal((await allocationRow(B)).state,'released');
  assert.equal((await campaignOf(A)).stateHash,aHashBeforeExit,"a sibling exit's receipts never touch an unrelated campaign");
  for(const f of frozenBefore.filter(x=>x.c===C))assert.deepEqual(await liquidOf(f.c),f.liquid,'the holding campaign keeps its exact allocation');

  // ============================================================ S4: D withdraws and also goes stale
  r=await exec();
  assert.equal(r.jobId,jobD.jobId,'next discretionary campaign is served (the blocked one is parked behind it)');assert.match(r.stage,/^withdraw:/);
  forceStale.add(D.campaignId);
  r=await exec();assert.deepEqual([r.status,r.reason],['blocked','stale_recenter_replan']);

  // ============================================================ S5: planner re-plans A and converts D's recenter to a retained exit
  unlocked.set(D.campaignId,false);
  const forksBefore=forkRuns;
  await planner.observeAndEnqueueManagement();
  const aReplanned=(await campaignOf(A)).state;
  assert.equal(aReplanned.candidate?.kind,'recenter','the second confirmation installs a fresh, fork-simulated candidate');
  assert.equal(aReplanned.swapDone,false);assert.equal(aReplanned.withdrawDone,true);assert.equal(aReplanned.reservedActionCost,390n);
  assert.equal(isRangeKeeperAwaitingReplan(aReplanned),false);assert(forkRuns>forksBefore);assert.equal(aReplanned.policy.confirmation,null);
  const dConverted=(await campaignOf(D)).state;
  assert.equal(isRangeKeeperRetainedExit(dConverted),true,'a safety exit outranks the recenter in progress');
  assert.equal(dConverted.activeTokenId,null);assert.deepEqual(dConverted.retiredTokenIds,['55']);assert.equal(dConverted.candidate,null);
  const aEvents=(await eventsOf(A)).map(e=>e.payload_kind);
  assert(aEvents.includes('rangekeeper_live_management_transition_v1')&&aEvents.includes('rangekeeper_live_management_settle_v1')&&
   aEvents.includes('rangekeeper_live_management_replan_v1'),`campaign A records its transition, settlement and replan: ${aEvents}`);

  // ============================================================ S6: A resumes; gas bound; blocked A yields to D's converted exit
  // The re-planned candidate needs no swap in this fixture, so after the approval the next stage is the mint.
  r=await exec();
  assert.equal(r.jobId,jobA.jobId);assert.match(r.stage,/^approve:/,'A continues with its approval, not another withdrawal');
  failBoundKind='mint';
  r=await exec();assert.equal(r.status,'blocked');assert.match(r.reason,/^stage_gas_or_cost_bound_exceeded: Stage would invade reserved exit gas/);
  assert.equal((await stagesOf(jobA.jobId)).some(s=>s.plan_json.kind==='mint'),false,'a bound failure persists no stage');
  const boundJob=await jobRow(jobA.jobId);assert.equal(boundJob.status,'blocked');
  assert((await db.query(`SELECT lease_until>clock_timestamp()+interval '60 seconds' AS slow FROM deployment_live_jobs WHERE id=$1`,[jobA.jobId])).rows[0].slow,
   'a deterministic bound retries slowly instead of looping');
  // A's blocked recenter yields to D, whose converted exit finishes first: its cleanup clears the wallet-wide allowance A had
  // granted (cleanup is wallet-wide by design), then it closes and releases like any retained close.
  r=await exec();assert.equal(r.jobId,jobD.jobId,'a blocked campaign does not starve another campaign');
  assert.equal(r.status,'reconciled',JSON.stringify(r));assert.match(r.stage,/^approve:/);assert.equal((await jobRow(jobA.jobId)).status,'queued');
  r=await exec();assert.equal(r.status,'completed',JSON.stringify(r));assert.equal(r.jobId,jobD.jobId);
  assert.equal((await db.query(`SELECT lifecycle FROM deployment_campaigns WHERE id=$1`,[D.campaignId])).rows[0].lifecycle,'closed');
  assert.equal((await allocationRow(D)).state,'released','a converted recenter closes and releases like a retained close');
  assert.equal((await jobRow(jobD.jobId)).status,'succeeded');
  assert.equal((await eventsOf(D)).some(e=>e.kind==='closed'),true);
  assert.equal((await stagesOf(jobD.jobId)).filter(x=>x.plan_json.kind==='withdraw').length,1,'the converted exit never repeats D\'s withdrawal');

  // ============================================================ S7: A re-grants the cleared allowance; publish loss, restart and reference outage at the mint
  r=await exec();assert.equal(r.jobId,jobA.jobId);assert.equal(r.status,'reconciled');assert.match(r.stage,/^approve:/);
  holdPublishKind='mint';failNextPublish=true;
  const signedBefore=signCalls;
  r=await exec();assert.equal(r.status,'blocked',JSON.stringify(r));assert.match(r.reason,/publisher unavailable/);
  let stages=await stagesOf(jobA.jobId);const mintStage=stages.find(x=>x.plan_json.kind==='mint');
  assert.equal(mintStage.status,'signed','the signed bytes are durable after an unacknowledged publish');assert.equal(signCalls,signedBefore+1);
  const costsBeforeRestart=(await campaignOf(A)).state.costEvents.length,generationBefore=(await readWalletState(db,walletIdentity)).generation;
  // Restart: a fresh worker, the lease already expired, the transaction now mined, and the independent references unavailable.
  ({real,worker}=buildWorker());holdPublishKind=null;reconcileFailures=1;
  r=await exec();assert.equal(r.status,'blocked');assert.match(r.reason,/reference outage/);
  stages=await stagesOf(jobA.jobId);assert.equal(stages.find(x=>x.plan_json.kind==='mint').status,'signed','a failed attribution rolls back completely');
  assert.equal((await campaignOf(A)).state.costEvents.length,costsBeforeRestart);assert.equal((await readWalletState(db,walletIdentity)).generation,generationBefore);
  assert.equal(signCalls,signedBefore+1,'persisted signed bytes are reused, never re-signed');
  r=await exec();assert.equal(r.status,'reconciled',JSON.stringify(r));assert.match(r.stage,/^mint:/);
  assert.equal(signCalls,signedBefore+1);assert.equal(publishCalls,1,'a mined transaction is never republished');
  assert.equal((await campaignOf(A)).state.costEvents.length,costsBeforeRestart+1,'the mined mint is attributed exactly once');
  assert.equal((await campaignOf(A)).state.phase,'holding');assert.equal((await campaignOf(A)).state.activeTokenId,99n);
  r=await exec();assert.equal(r.status,'reconciled');assert.match(r.stage,/^approve:/,'allowance cleanup completes the action');
  r=await exec();assert.equal(r.status,'completed',JSON.stringify(r));assert.equal(r.jobId,jobA.jobId);

  // ============================================================ final assertions
  const aFinal=await campaignOf(A),s=aFinal.state;
  assert.equal(s.phase,'holding');assert.equal(s.activeTokenId,99n);assert.equal(s.recenters,1,'epoch advances once');assert.equal(s.economicActions,2);
  assert.deepEqual(s.retiredTokenIds,['77']);assert.equal(s.candidate,null);assert.equal(s.swapDone,false);assert.equal(s.withdrawDone,false);
  assert.equal(s.costEvents.length,5);assert.equal(s.gasSpentWei,250n);
  assert(s.costEvents.every(e=>e.gasValue===50n),'every receipt is valued from its own receipt-block references');
  assert.deepEqual(aFinal.allocation.nftTokenIds,['99']);
  assert.deepEqual((await custodyOf(A)).map(n=>[n.id,n.status]),[['77','retired_empty'],['99','active']]);
  assert.deepEqual(await liquidOf(A),{[token0]:70n,[token1]:80n},'withdraw and mint settle into the campaign allocation exactly once');
  assert.equal(BigInt((await allocationRow(A)).native_spend_wei),750n);
  assert.deepEqual((await stagesOf(jobA.jobId)).map(x=>x.plan_json.kind),['withdraw','approve','approve','mint','approve']);
  assert((await stagesOf(jobA.jobId)).every(x=>x.status==='confirmed'));
  assert.equal((await jobRow(jobA.jobId)).status,'succeeded');
  assert.equal((await db.query(`SELECT lifecycle FROM deployment_campaigns WHERE id=$1`,[A.campaignId])).rows[0].lifecycle,'active');
  // The unrelated holding campaign is untouched by every sibling receipt and exit.
  const cFinal=await campaignOf(C);
  assert.equal(cFinal.state.phase,'holding');assert.equal(cFinal.state.activeTokenId,66n);assert.equal(cFinal.state.costEvents.length,0);
  assert.deepEqual(await liquidOf(C),{[token0]:100n,[token1]:100n});assert.deepEqual((await custodyOf(C)).map(n=>[n.id,n.status,n.liquidity]),[['66','active',10000n]]);
  assert.equal(BigInt((await allocationRow(C)).native_spend_wei),1000n);
  assert((await eventsOf(C)).every(e=>e.kind==='mark'||e.kind==='initialized'||e.kind==='opened'),'only management observations touch the holding campaign');
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_jobs WHERE campaign_id=$1 AND kind<>'open'`,[C.campaignId])).rows[0].n,0);
  // Wallet-level conservation: the persisted snapshot equals the modelled canonical wallet, commitments are consistent, nothing is unresolved.
  const wfinal=await readWalletState(db,walletIdentity);
  assert.equal(wfinal.status,'available');assert.equal(wfinal.nonce,String(model.nonce));assert.equal(wfinal.nativeBalanceWei,String(model.native));
  assert.deepEqual(Object.fromEntries(wfinal.tokens.map(t=>[t.address,t.balanceRaw])),{[token0]:String(model.t0),[token1]:String(model.t1)});
  assert.equal(wfinal.commitmentsHash,liveWalletCommitmentFingerprint(await readCommitments(db,walletIdentity)));
  assert.equal((await real.managementObservationReady()),true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE status IN('prepared','signed','blocked')`)).rows[0].n,0);
  console.log('RangeKeeper live recenter lifecycle isolated PostgreSQL integration passed');
 }finally{await db.end();}
}finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await root.end();}
