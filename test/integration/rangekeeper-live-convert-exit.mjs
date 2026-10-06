// Isolated PostgreSQL qualification of the operator-initiated live CONVERT exit (withdraw, then sell the non-quote leg back into
// the quote token): the review/preview contract, digest and fresh-source admission, the real shared wallet queue and worker,
// the receipt-effect reducer, the terminal close, and the two recoverable fallbacks (a sale that cannot be planned within the
// bounded wait, and a sale that reverts on chain) that degrade the exit to a retained close instead of leaving the campaign blocked.
//
// The real LiveWalletQueue, worker, receipt-effect reducer, management transition/settlement/lifecycle code and allocation
// store run against the database. Only the chain is modelled: stage planning, owned-fork authorization and canonical receipt
// attribution are deterministic fakes over an in-memory wallet model, and the signer signs locally with a throwaway key.
// Nothing is broadcast and no RPC client exists. Requires TEST_DATABASE_URL naming a disposable database; it creates and
// drops one isolated schema only.
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
import {recordRangeKeeperLiveManagementReview,enqueueRangeKeeperLiveManagementReview,createRangeKeeperLiveManagementRuntime} from '../../src/deployments/rangekeeper-live-management.ts';
import {readRangeKeeperLiveCampaign,persistRangeKeeperLiveStageAuthorizationInTransaction} from '../../src/deployments/rangekeeper-live-campaign-store.ts';
import {applyRangeKeeperLiveReceiptEffectInTransaction} from '../../src/deployments/rangekeeper-live-campaign-effects.ts';
import {createRangeKeeperLiveWalletWorker} from '../../src/deployments/rangekeeper-live-wallet-worker.ts';
import {createRangeKeeperLiveWalletWorkerAdapters,settleRangeKeeperLiveManagementStage,readRangeKeeperAllowanceScope,
 rangeKeeperAllowanceCleanupProof} from '../../src/deployments/rangekeeper-live-queue-adapters.ts';
import {allowancePolicyFromUses,readRangeKeeperWalletAllowanceUses} from '../../src/deployments/live-wallet-allowance-scope.ts';
import {allowancePairKey,persistentAllowanceGrant} from '../../src/strategy/rangekeeper/allowance-policy.ts';
import {isRangeKeeperAwaitingReplan,isRangeKeeperRetainedExit,isRangeKeeperManagedExit,isRangeKeeperConvertExit} from '../../src/deployments/rangekeeper-live-campaign.ts';
import {liveSetupEvidenceHash} from '../../src/deployments/rangekeeper-live-setup-simulation.ts';
import {RangeKeeperExitConversionUnavailableError} from '../../src/strategy/rangekeeper/live-stage.ts';
import {RANGEKEEPER_CONVERT_WAIT_SECONDS} from '../../src/deployments/rangekeeper-live-management-recovery.ts';
import {parseRangeKeeperConfig,rangeKeeperConfigHash,initialRangeKeeperState} from '../../src/strategy/rangekeeper/config.ts';
import {rangeKeeperJson,parseRangeKeeperJson} from '../../src/strategy/rangekeeper/live-domain.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL must name a disposable isolated database');
const root=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:5}),admin=await root.connect();
const schema=`rk_convert_exit_${randomUUID().replaceAll('-','')}`;

// ---------------------------------------------------------------- fixture constants
const signer=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),wallet=signer.address.toLowerCase(),walletIdentity={chainId:4663,address:wallet};
const token0='0x1000000000000000000000000000000000000001',token1='0x2000000000000000000000000000000000000002',manager='0x5000000000000000000000000000000000000005';
// Campaigns are opened under buildId; every management preview/admission/execution below runs under the later managerBuildId.
const buildId='b'.repeat(64),managerBuildId='9'.repeat(64),profileId=randomUUID();
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
const spenderAddress={router:profile.pool.router,positionManager:manager};
const allowanceList=()=>[token0,token1].flatMap(token=>['router','positionManager'].map(spender=>({token,spender:spenderAddress[spender],amount:model.allowances.get(`${token}:${spender}`)??0n})));
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
  for(const [label,nft] of [['A','77'],['B','88'],['C','66'],['D','55'],['E','44']]){
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
  const [A,B,C,D,E]=campaigns;
  const campaignOf=c=>readRangeKeeperLiveCampaign(db,{...walletIdentity,campaignId:c.campaignId});
  const jobRow=async id=>(await db.query('SELECT * FROM deployment_live_jobs WHERE id=$1',[id])).rows[0];
  const stagesOf=async jobId=>(await db.query(`SELECT stage,status,nonce,signed_raw,plan_json FROM deployment_live_stage_outbox WHERE job_id=$1 ORDER BY created_at,stage`,[jobId])).rows;
  const allocationRow=async c=>(await db.query(`SELECT a.state,a.native_spend_wei,a.exit_reserve_wei,a.allocation_hash FROM deployment_live_allocations a WHERE a.id=$1`,[c.allocationId])).rows[0];
  const liquidOf=async c=>Object.fromEntries((await db.query(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1`,[c.allocationId])).rows.map(r=>[r.token_address,BigInt(r.allocated_raw)]));
  const custodyOf=async c=>(await db.query(`SELECT token_id,status,liquidity FROM deployment_live_nft_custody WHERE allocation_id=$1 ORDER BY token_id`,[c.allocationId])).rows
   .map(r=>({id:String(r.token_id),status:r.status,liquidity:BigInt(r.liquidity)}));
  const eventsOf=async c=>(await db.query(`SELECT kind,payload->>'kind' payload_kind FROM deployment_live_runtime_events WHERE campaign_id=$1 ORDER BY sequence`,[c.campaignId])).rows;

  // ------------------------------------------------------------ canonical-wallet model plumbing (fakes)
  let failComplete=false,signCalls=0,publishCalls=0,reconcileFailures=0,failNextPublish=false,holdPublishKind=null,failBoundKind=null,tamperCaps=false;
  const revertKind=new Map(),convertUnavailable=new Set();
  const kindOfStage=async(jobId,stage)=>(await db.query(`SELECT plan_json->>'kind' kind FROM deployment_live_stage_outbox WHERE job_id=$1 AND stage=$2`,[jobId,stage])).rows[0]?.kind;
  const walletRow=async client=>(await client.query(`SELECT generation,nonce,pending_nonce,native_balance_wei,source_block,source_hash,source_timestamp FROM deployment_live_wallets WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows[0];
  const applyToModel=(campaignId,plan)=>{
   const out={retired:[],fees:null};
   if(plan.kind==='withdraw'){const id=String(plan.tokenId),n=model.nfts.get(id);model.t0+=30n;model.t1+=40n;n.liquidity=0n;
    model.active.set(campaignId,null);out.retired=[id];out.fees={fee0:'3',fee1:'4'};}
   else if(plan.kind==='approve')model.allowances.set(`${plan.token===0?token0:token1}:${plan.spender}`,plan.amount);
   else if(plan.kind==='swap'){if(plan.token===1){model.t1-=plan.amountIn;model.t0+=plan.minOut+1n;}else{model.t0-=plan.amountIn;model.t1+=plan.minOut+1n;}}
   else if(plan.kind==='mint'){const id=String(model.nextNft++);model.nfts.set(id,nftOf(5_000n));model.active.set(campaignId,id);model.t0-=60n;model.t1-=60n;
    // The position manager pulls through its allowance, which therefore depletes exactly like the canonical token.
    for(const token of [token0,token1]){const key=`${token}:positionManager`,current=model.allowances.get(key)??0n;if(current>=60n)model.allowances.set(key,current-60n);}}
   return out;
  };
  const queueAdapters={
   authorizeStage:async(client,{job,stage,intent,plan,allocation,walletState})=>{
    const campaign=await readRangeKeeperLiveCampaign(client,{...walletIdentity,campaignId:job.campaignId,revision:job.revision});
    const rows=(await client.query(`SELECT token_address,balance_raw FROM deployment_live_wallet_tokens WHERE chain_id=4663 AND wallet=$1`,[wallet])).rows;
    const allocTokens=(await client.query(`SELECT token_address,allocated_raw FROM deployment_live_allocation_tokens WHERE allocation_id=$1`,[job.allocationId])).rows;
    const source={block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)};
    const authorization={schemaVersion:1,kind:'rangekeeper_live_owned_stage_v1',status:'success',campaignId:job.campaignId,allocationId:job.allocationId,
     revision:job.revision,stage,buildId:job.buildId,source,profileId:campaign.profileId,profileHash:campaign.profileHash,allocationHash:campaign.allocation.allocationHash,
     configHash:campaign.configHash.slice(2),referenceProofHash:'d'.repeat(64),planHash:liveSetupEvidenceHash(plan),calldataHash:'1'.repeat(64),
     beforeHash:'f'.repeat(64),requestHash:'a'.repeat(64),exitSpendAllowed:job.kind.startsWith('close_')||isRangeKeeperManagedExit(campaign.state),
     exitConvert:isRangeKeeperConvertExit(campaign.state),nonce:intent.nonce,gasUsed:'10',gasUnitsBound:'13',maxFeePerGasWei:'5',
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
    const reverted=revertKind.get(job.campaignId)===plan.kind;
    const effect=reverted?{retired:[],fees:null}:applyToModel(job.campaignId,plan);model.nonce+=1;model.native-=50n;
    const source=nextSource(),activeAfter=model.active.get(job.campaignId)??null;
    const tokenForSnapshot=effect.retired.length?effect.retired[0]:activeAfter;
    const receipt={transactionHash:outbox.hash,status:reverted?'reverted':'success',gasUsed:'10',effectiveGasPrice:'5',blockNumber:source.block,blockHash:source.hash};
    const afterWallet={operator:wallet,source:{block:BigInt(source.block),hash:source.hash,timestamp:source.timestamp},nonce:model.nonce,pendingNonce:model.nonce,
     nativeWei:model.native,tokens:{[token0]:model.t0,[token1]:model.t1},nftTokenIds:[...model.nfts.keys()].sort(),allowances:allowanceList()};
    return {receipt,receiptHash:liveSetupEvidenceHash(receipt),proofHash:'e'.repeat(64),effects:effect.fees,gasWei:50n,status:reverted?'reverted':'success',
     source:afterWallet.source,afterWallet,afterPool:snapshotAt(source,tokenForSnapshot),
     referenceValuation:{source,proofHash:'f'.repeat(64),evidence:{fixture:true},...prices},
     nextLiquidByTokenAddress:{[token0]:allocated[token0]+model.t0-before.t0,[token1]:allocated[token1]+model.t1-before.t1},
     nextNativeSpendWei:BigInt(allocation.native_spend_wei)-50n,nextExitReserveWei:BigInt(allocation.exit_reserve_wei),
     nextNftTokenIds:activeAfter?[activeAfter]:[],retiredNftTokenIds:effect.retired,positionManager:manager,
     position:activeAfter?positionOf(activeAfter):null};
   },
   afterReceipt:async(client,args)=>{await applyRangeKeeperLiveReceiptEffectInTransaction(client,args);},
   // The real wallet allowance scope (PostgreSQL) and cleanup invariant; only the chain read is modelled.
   verifyCleanup:async(client,{job,allocation,walletState})=>{
    const campaign=await readRangeKeeperLiveCampaign(client,{...walletIdentity,campaignId:job.campaignId,revision:job.revision});
    const closed=job.kind.startsWith('close_')||isRangeKeeperRetainedExit(campaign.state);
    const scope=await readRangeKeeperAllowanceScope(client,wallet,[profile],closed?job.campaignId:undefined);
    const allowances=allowanceList().map(a=>({token:a.token,spender:a.spender,amount:String(a.amount)}));
    const proof=rangeKeeperAllowanceCleanupProof(allowances,scope);
    return {allowances,allowancePolicy:tamperCaps?{...proof,caps:[]}:proof,allocationHash:allocation.allocation_hash,
     source:{block:String(walletState.source_block),hash:walletState.source_hash,timestamp:Number(walletState.source_timestamp)},
     noPendingAction:true,custodyState:closed?'closed_empty':'managed'};
   },
  };
  const queue=new LiveWalletQueue(db,queueAdapters);

  // Stage planning under persistent_capped_v1 for an exit: withdraw -> (convert only) approve the router for the risky leg and sell
  // it into the quote token -> zero only the pairs no sibling uses. The policy comes from the real wallet allowance scope.
  const SPENDERS=['router','positionManager'];
  const nextStage=async({job})=>{
   const campaign=await campaignOf({campaignId:job.campaignId}),s=campaign.state;
   const policy=allowancePolicyFromUses(await readRangeKeeperWalletAllowanceUses(db,wallet),job.campaignId);
   const zeroUnused=()=>{
    for(const [index,token] of [token0,token1].entries())for(const spender of SPENDERS)
     if((model.allowances.get(`${token}:${spender}`)??0n)>0n&&!policy.retain.has(allowancePairKey(token,spenderAddress[spender])))
      return {kind:'approve',token:index,spender,amount:0n};
    return null;
   };
   let plan=null;
   if(s.phase==='exit'){
    if(s.activeTokenId!==null)plan={kind:'withdraw',tokenId:s.activeTokenId,liquidity:model.nfts.get(String(s.activeTokenId)).liquidity,min0:0n,min1:0n,deadline:BigInt(clock+300)};
    else{
     const risky=BigInt((await liquidOf({allocationId:job.allocationId}))[token1]);
     if(s.exitMode==='convert'&&risky>0n){
      if(convertUnavailable.has(job.campaignId))throw new RangeKeeperExitConversionUnavailableError('Exit pool/reference deviation');
      const approved=model.allowances.get(`${token1}:router`)??0n;
      plan=approved>=risky?{kind:'swap',token:1,amountIn:risky,minOut:risky-risky/100n,deadline:BigInt(clock+300)}:
       {kind:'approve',token:1,spender:'router',amount:persistentAllowanceGrant({current:approved,needed:risky,exposure:policy.exposure[1]})};
     }else plan=zeroUnused();
    }
   }
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
   const adapters={...real,nextStage,verifyPreparedIntent:async()=>true,
    completeManagedLifecycle:async a=>{if(failComplete){failComplete=false;throw Error('injected crash before the terminal campaign event');}return real.completeManagedLifecycle(a);},waitForCanonicalReceipt:async()=>{},
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


  // ------------------------------------------------------------ convert review helpers
  const convertCosts=(source,over={},conv={})=>({status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'400',actionGasWei:'400',
   gasValueUsdX18:'400',actionCostValue:'900',swapCostValue:'500',...over,conversion:{mode:'convert',swapRequired:true,withdrawn0:'30',withdrawn1:'40',
    maxSlippageBps:50,maxSwapShortfallValue:'1000',quoteIndex:0,decimals0:6,decimals1:18,quoteToken:token0,riskyToken:token1,
    route:{kind:'direct_exact_input_single',router:profile.pool.router,fee:500},token:1,amountIn:'140',minOut:'139',expectedOut:'139',rehearsedOut:'139',
    feeValue:'100',shortfallValue:'400',...conv}});
  const positionValuation=id=>({tokenId:String(id),liquidityRaw:String(positionOf(id).liquidity),principal0Raw:'100',principal1Raw:'100',uncollected0Raw:'0',
   uncollected1Raw:'0',inventory0Raw:'100',inventory1Raw:'100'});
  const walletSource=async()=>(await readWalletState(db,walletIdentity)).source;
  const recordConvert=async(c,costs,kind='close_convert')=>{
   const campaign=await campaignOf(c),source=await walletSource(),id=model.active.get(c.campaignId);
   return recordRangeKeeperLiveManagementReview(db,{wallet:walletIdentity,campaign,operationKind:kind,source,snapshot:snapshotAt(source,id),
    references:refsAt(source),position:positionValuation(id),decision:{reason:kind==='close_convert'?'convert_exit_preview':'retain_only_preview',observationHash:'f'.repeat(64)},
    candidate:null,policy:null,costs:costs??convertCosts(source),expiresAt:source.timestamp+90},{buildId:managerBuildId,verifyPinned:async()=>true});
  };
  let freshChecks=0,freshResult=true;
  const deps={buildId:managerBuildId,pool:db,verifyPinned:async()=>true,verifyConvertFresh:async()=>{freshChecks++;return freshResult;},enqueue:job=>queue.enqueue(job)};
  const request=(c,review,key,expectedOperationKind='close_convert',overrides={},d=deps)=>enqueueRangeKeeperLiveManagementReview({wallet:walletIdentity,campaignId:c.campaignId,
   previewId:review.previewId,contentDigest:review.contentDigest,expectedRevision:1,idempotencyKey:key,expectedOperationKind,...overrides},d);
  const jobsOf=async c=>(await db.query(`SELECT id,kind,status FROM deployment_live_jobs WHERE campaign_id=$1 AND kind<>'open' ORDER BY created_at`,[c.campaignId])).rows;
  const lifecycleOf=async c=>(await db.query(`SELECT lifecycle FROM deployment_campaigns WHERE id=$1`,[c.campaignId])).rows[0].lifecycle;
  const finalState=async c=>parseRangeKeeperJson((await db.query(`SELECT state_json FROM deployment_live_campaign_runtime WHERE campaign_id=$1`,[c.campaignId])).rows[0].state_json);
  const closedEvent=async c=>(await db.query(`SELECT payload FROM deployment_live_runtime_events WHERE campaign_id=$1 AND kind='closed'`,[c.campaignId])).rows[0]?.payload;

  // ============================================================ S0: preview contract for a convert review (campaign D)
  const stripped=convertCosts(await walletSource());delete stripped.conversion;
  let review=await recordConvert(D,stripped);
  assert.equal(review.status,'unavailable');assert.equal(review.kind,'rangekeeper_live_convert_preview');
  assert.match(review.missing.join(' '),/lacks its conversion evidence/,'a convert review cannot be frozen without its conversion evidence');
  const src0=await walletSource();
  review=await recordConvert(D,convertCosts(src0,{},{token:0}));
  assert.equal(review.status,'unavailable');assert.match(review.missing.join(' '),/non-quote leg directly into the quote token/,'selling the quote leg is not a convert');
  review=await recordConvert(D,convertCosts(src0,{},{shortfallValue:'1001'}));
  assert.equal(review.status,'unavailable');assert.match(review.missing.join(' '),/slippage or swap-shortfall policy/);
  review=await recordConvert(D,convertCosts(src0,{},{maxSlippageBps:51}));
  assert.equal(review.status,'unavailable');assert.match(review.missing.join(' '),/slippage or swap-shortfall policy/,'the frozen slippage limit is bound');
  review=await recordConvert(D,convertCosts(src0,{},{minOut:'141'}));
  assert.equal(review.status,'unavailable','a minimum output above the expected output is malformed');
  review=await recordConvert(D,{...convertCosts(src0),source:{...src0,block:'1'}});
  assert.equal(review.status,'unavailable',JSON.stringify(review.missing));
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_reviews WHERE (payload->>'operationKind')='close_convert'`)).rows[0].n,0,'rejected previews persist nothing');
  const noSwap=await recordConvert(D,convertCosts(src0,{},{swapRequired:false,token:undefined,amountIn:undefined,minOut:undefined,expectedOut:undefined,rehearsedOut:undefined,feeValue:'0',shortfallValue:'0'}));
  assert.equal(noSwap.status,'indicative',JSON.stringify(noSwap));assert.equal(noSwap.kind,'rangekeeper_live_convert_preview','a withdraw-only convert (no risky leg to sell) is still a valid review');
  const dReview=await recordConvert(D);
  assert.equal(dReview.status,'indicative',JSON.stringify(dReview));assert.equal(dReview.trustedPreviewSaved,true);assert.equal(dReview.kind,'rangekeeper_live_convert_preview');
  assert.equal(dReview.executionEligible,false);assert.equal(dReview.costs.conversion.mode,'convert');
  const retainOfD=await recordConvert(D,frozenRetainCosts(src0),'close_retain');
  function frozenRetainCosts(source){return {status:'estimated',provenance:'owned_fork_allocated_lifecycle_v1',source,gasWei:'400',actionGasWei:'400',actionCostValue:'400',gasValueUsdX18:'400'};}
  assert.equal(retainOfD.status,'indicative');assert.equal(retainOfD.kind,'rangekeeper_live_retain_preview','retain previews keep their own kind');

  // ============================================================ S1: admission validation (campaign D, nothing runs)
  const before=freshChecks;
  let r=await request(D,dReview,'convert-d-wrong-kind-1','close_retain');
  assert.equal(r.status,'unavailable');assert.match(r.missing.join(' '),/stale, expired, or bound to another campaign/,'a convert review cannot be admitted as a retain');
  r=await request(D,retainOfD,'convert-d-wrong-kind-2','close_convert');
  assert.equal(r.status,'unavailable','a retain review cannot be admitted as a convert');
  r=await request(D,{...dReview,contentDigest:'9'.repeat(64)},'convert-d-digest-1');
  assert.equal(r.status,'unavailable');assert.match(r.missing.join(' '),/digest changed/);
  r=await request(D,dReview,'convert-d-fresh-missing',undefined,{},{...deps,verifyConvertFresh:undefined});
  assert.equal(r.status,'unavailable');assert.match(r.missing.join(' '),/fresh canonical source/,'a convert admission fails closed without its fresh-source check');
  freshResult=false;
  r=await request(D,dReview,'convert-d-fresh-fails');
  assert.equal(r.status,'unavailable');assert.match(r.missing.join(' '),/fresh canonical source/,'a stale pool or quote at the fresh source rejects the admission');
  freshResult=true;
  assert(freshChecks>before);
  const reviewTimes=(await db.query('SELECT expires_at,created_at FROM deployment_live_reviews WHERE id=$1',[dReview.previewId])).rows[0];
  await db.query("UPDATE deployment_live_reviews SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '2 seconds' WHERE id=$1",[dReview.previewId]);
  r=await request(D,dReview,'convert-d-expired');assert.equal(r.status,'unavailable');
  await db.query('UPDATE deployment_live_reviews SET expires_at=$2,created_at=$3 WHERE id=$1',[dReview.previewId,reviewTimes.expires_at,reviewTimes.created_at]);
  await db.query('UPDATE deployment_live_wallets SET generation=generation+1 WHERE chain_id=4663 AND wallet=$1',[wallet]);
  r=await request(D,dReview,'convert-d-stale-wallet');assert.equal(r.status,'unavailable');assert.match(r.missing.join(' '),/Wallet changed after management preview/);
  await db.query('UPDATE deployment_live_wallets SET generation=generation-1 WHERE chain_id=4663 AND wallet=$1',[wallet]);
  const dState=(await campaignOf(D)).stateHash;
  await db.query('UPDATE deployment_live_campaign_runtime SET state_hash=$2 WHERE campaign_id=$1',[D.campaignId,'1'.repeat(64)]);
  r=await request(D,dReview,'convert-d-stale-state');assert.equal(r.status,'unavailable');
  await db.query('UPDATE deployment_live_campaign_runtime SET state_hash=$2 WHERE campaign_id=$1',[D.campaignId,dState]);
  r=await request(D,dReview,'convert-d-wrong-revision',undefined,{expectedRevision:2});assert.equal(r.status,'unavailable');
  assert.equal((await jobsOf(D)).length,0,'every rejected admission leaves no job behind');
  assert.equal((await db.query('SELECT consumed_by_job FROM deployment_live_reviews WHERE id=$1',[dReview.previewId])).rows[0].consumed_by_job,null,'and does not consume the review');
  assert.equal((await campaignOf(D)).state.phase,'holding','a rejected admission never changes campaign state');

  // ============================================================ S2: A converts end to end (admission through the runtime facade)
  const runtime=createRangeKeeperLiveManagementRuntime({pool:db,wallet:walletIdentity,buildId:managerBuildId,persistReviews:true,
   observe:async()=>{throw Error('retain observation must not be used for a convert');},
   observeConvert:async campaign=>{const source=await walletSource(),id=campaign.state.activeTokenId;
    return {source,snapshot:snapshotAt(source,id),references:refsAt(source),position:positionValuation(id),
     decision:{reason:'convert_exit_preview',observationHash:'f'.repeat(64)},costs:convertCosts(source),missing:[],expiresAt:source.timestamp+90};},
   verifyPinned:async()=>true,verifyConvertFresh:deps.verifyConvertFresh,enqueue:job=>queue.enqueue(job)});
  const preview=await runtime.convertPreview(A.campaignId);
  assert.equal(preview.status,'indicative',JSON.stringify(preview));assert.equal(preview.kind,'rangekeeper_live_convert_preview');
  assert.equal(preview.actionAvailable,true);assert.equal(preview.executionEligible,false);
  const body={previewId:preview.previewId,contentDigest:preview.contentDigest,expectedRevision:preview.expectedRevision,idempotencyKey:'convert-a-1'};
  let admitted=await runtime.retainOperation(A.campaignId,{...body,idempotencyKey:'convert-a-wrong'});
  assert.equal(admitted.status,'unavailable',JSON.stringify(admitted));assert.match(admitted.missing.join(' '),/another campaign|stale/,'the retain endpoint refuses a convert review');
  admitted=await runtime.convertOperation(A.campaignId,body);
  assert.equal(admitted.status,'queued',JSON.stringify(admitted));assert.equal(admitted.replayed,false);assert.equal(admitted.executionEligible,false);
  assert.equal('requestDigest' in admitted,false);
  const jobA=admitted.jobId;
  assert.deepEqual((await jobsOf(A)).map(j=>[j.kind,j.status]),[['close_convert','queued']]);
  assert.equal((await db.query('SELECT consumed_by_job FROM deployment_live_reviews WHERE id=$1',[preview.previewId])).rows[0].consumed_by_job,jobA);
  const replay=await runtime.convertOperation(A.campaignId,body);
  assert.equal(replay.status,'queued');assert.equal(replay.jobId,jobA);assert.equal(replay.replayed,true,'the same key replays the same job');
  const conflict=await runtime.convertOperation(A.campaignId,{...body,contentDigest:'7'.repeat(64)});
  assert.equal(conflict.status,'request_conflict');
  const asRetainKey=await runtime.retainOperation(A.campaignId,body);
  assert.notEqual(asRetainKey.status,'queued','a convert request key never replays as a retain request');
  // A second review for the same campaign cannot be admitted beside its pending exit.
  const second=await recordConvert(A).catch(()=>null);
  if(second?.status==='indicative'){
   const dup=await request(A,second,'convert-a-second');assert.equal(dup.status,'unavailable');assert.match(dup.missing.join(' '),/quiescent wallet queue|stale/);
  }
  const aAlloc0=await liquidOf(A),aNative0=BigInt((await allocationRow(A)).native_spend_wei);
  const beforeSiblings=await Promise.all([B,C].map(async c=>({c,hash:(await campaignOf(c)).stateHash,liquid:await liquidOf(c)})));
  let w=await exec();
  assert.deepEqual([w.status,w.jobId],['reconciled',jobA]);assert.match(w.stage,/^withdraw:/);
  let a=(await campaignOf(A)).state;
  assert.deepEqual([a.phase,a.desired,a.exitMode,a.withdrawDone,a.activeTokenId],['exit','stopped','convert',true,null],'the frozen review put the campaign into a convert exit');
  assert.equal(a.reservedActionCost,900n,'the reserved cost covers gas plus the estimated sale cost');
  assert((await eventsOf(A)).some(e=>e.payload_kind==='rangekeeper_live_management_transition_v1'),'the frozen review is consumed by one recorded transition');
  w=await exec();assert.deepEqual([w.status,w.jobId],['reconciled',jobA]);assert.match(w.stage,/^approve:/,'the router is approved for the risky leg before the sale');
  assert((model.allowances.get(`${token1}:router`)??0n)>0n);
  w=await exec();assert.deepEqual([w.status,w.jobId],['reconciled',jobA]);assert.match(w.stage,/^swap:/);
  a=(await campaignOf(A)).state;
  assert.equal(a.lastReason,'swap_confirmed');assert.equal(a.costEvents.length,3,'withdraw, approval and sale are each booked once');
  const swapEvent=a.costEvents[2];assert.equal(swapEvent.gasValue,50n);assert(swapEvent.swapFeeValue!==null&&swapEvent.swapShortfallValue!==null,'the sale books its fee and shortfall from receipt-block references');
  const liquidAfterSale=await liquidOf(A);
  assert.equal(liquidAfterSale[token1],0n,'the whole non-quote leg was sold');assert(liquidAfterSale[token0]>aAlloc0[token0],'the proceeds settle into the campaign quote-token allocation');
  w=await exec();assert.deepEqual([w.status,w.jobId],['completed',jobA],JSON.stringify(w));
  assert.deepEqual((await stagesOf(jobA)).map(s=>s.plan_json.kind),['withdraw','approve','swap']);
  assert((await stagesOf(jobA)).every(s=>s.status==='confirmed'));
  a=await finalState(A);
  assert.deepEqual([a.phase,a.desired,a.exitMode,a.lastReason],['closed','stopped','convert','convert_close_complete']);
  assert.equal(await lifecycleOf(A),'closed');assert.equal((await allocationRow(A)).state,'released','allocation is released on the terminal close');
  assert.deepEqual((await custodyOf(A)).map(n=>[n.id,n.status,n.liquidity]),[['77','retired_empty',0n]],'NFT custody records the retired, empty position');
  const aClosed=await closedEvent(A);assert.equal(aClosed.kind,'rangekeeper_live_convert_close_complete_v1');assert.equal(aClosed.convertDegradedToRetain,false);assert.equal(aClosed.jobKind,'close_convert');
  assert.equal(aClosed.terminalValuation.kind,'rangekeeper_live_valuation_mark_v1','the terminal valuation mark is recorded like a retained close');
  assert.equal((await jobRow(jobA)).status,'succeeded');
  assert(BigInt((await allocationRow(A)).native_spend_wei)<aNative0,'gas for every stage is charged to this campaign');
  for(const f of beforeSiblings)assert.equal((await campaignOf(f.c)).stateHash,f.hash,'sibling campaigns are untouched by the convert exit');
  for(const f of beforeSiblings)assert.deepEqual(await liquidOf(f.c),f.liquid);
  // A closed campaign can no longer be reviewed for any exit.
  review=await runtime.convertPreview(A.campaignId);assert.equal(review.status,'unavailable');assert.deepEqual(review.missing,['live_campaign_unavailable']);
  assert.equal(review.kind,'rangekeeper_live_convert_preview');

  // ============================================================ S3: B cannot plan its sale -> bounded wait -> retained close
  review=await recordConvert(B);assert.equal(review.status,'indicative',JSON.stringify(review));
  const jobB=(await request(B,review,'convert-b-1')).jobId;
  w=await exec();assert.deepEqual([w.status,w.jobId],['reconciled',jobB]);assert.match(w.stage,/^withdraw:/);
  assert.equal((await campaignOf(B)).state.withdrawDone,true);
  const bHashAfterWithdraw=(await campaignOf(B)).stateHash;
  convertUnavailable.add(B.campaignId);
  w=await exec();assert.equal(w.status,'blocked',JSON.stringify(w));assert.match(w.reason,/^convert_swap_unavailable_wait: Exit pool\/reference deviation/);
  assert.equal((await campaignOf(B)).stateHash,bHashAfterWithdraw,'waiting writes no campaign state');
  assert.equal((await campaignOf(B)).state.exitMode,'convert');
  w=await exec();assert.equal(w.status,'blocked');assert.match(w.reason,/convert_swap_unavailable_wait/,'still within the bounded wait');
  assert.equal((await stagesOf(jobB)).length,1,'nothing is signed while the sale cannot be planned');
  assert(signCalls>=0);
  const signedBeforeDegrade=signCalls;
  await db.query(`UPDATE deployment_live_stage_outbox SET updated_at=updated_at-($2::text||' seconds')::interval WHERE job_id=$1`,[jobB,String(RANGEKEEPER_CONVERT_WAIT_SECONDS+60)]);
  w=await exec();assert.deepEqual([w.status,w.jobId],['completed',jobB],JSON.stringify(w));
  const b=await finalState(B);
  assert.deepEqual([b.phase,b.exitMode,b.lastReason],['closed','retain','retain_close_complete'],'the exit fell back to a retained close');
  assert.equal(signCalls,signedBeforeDegrade,'the fallback signs nothing: withdrawal done, tokens stay in the wallet');
  assert.deepEqual((await stagesOf(jobB)).map(s=>s.plan_json.kind),['withdraw'],'the sale was never attempted and the withdrawal never repeated');
  const bClosed=await closedEvent(B);assert.equal(bClosed.kind,'rangekeeper_live_retained_close_complete_v1');assert.equal(bClosed.convertDegradedToRetain,true);assert.equal(bClosed.jobKind,'close_convert');
  const bLiquid=await liquidOf(B);assert(bLiquid[token1]>=100n+40n,'the risky leg stays in the campaign wallet allocation');
  assert.equal(await lifecycleOf(B),'closed');assert.equal((await allocationRow(B)).state,'released');assert.equal((await jobRow(jobB)).status,'succeeded');
  assert((await eventsOf(B)).some(e=>e.payload_kind==='rangekeeper_live_management_settle_v1'),'the degradation is recorded as a settlement event');

  // ============================================================ S4: C's sale reverts on chain -> retained close, never a halt
  review=await recordConvert(C);const jobC=(await request(C,review,'convert-c-1')).jobId;
  w=await exec();assert.match(w.stage,/^withdraw:/);
  assert((model.allowances.get(`${token1}:router`)??0n)>0n,'the persistent router approval from the earlier convert is still in force, so no new approval is planned');
  revertKind.set(C.campaignId,'swap');
  w=await exec();assert.deepEqual([w.status,w.jobId],['blocked',jobC],JSON.stringify(w));assert.equal(w.reason,'canonical_stage_reverted_after_cost_attribution');
  let c=(await campaignOf(C)).state;
  assert.deepEqual([c.phase,c.exitMode,c.haltReason],['exit','retain',null],'a reverted sale degrades the exit instead of halting the campaign');
  assert.match(c.lastReason,/^convert_swap_reverted_degraded_to_retain:swap:/);
  assert.equal(c.costEvents.length,2,'the reverted sale\'s gas is booked');assert.equal(c.costEvents[1].gasValue,50n);assert.equal(c.costEvents[1].swapFeeValue,0n);
  assert.equal((await liquidOf(C))[token1],100n+40n,'the reverted sale moved no tokens');
  assert.equal((await stagesOf(jobC)).find(s=>s.plan_json.kind==='swap').status,'reverted');
  assert.equal((await jobRow(jobC)).status,'blocked');
  w=await exec();assert.deepEqual([w.status,w.jobId],['completed',jobC],JSON.stringify(w));
  c=await finalState(C);
  assert.deepEqual([c.phase,c.exitMode,c.lastReason],['closed','retain','retain_close_complete']);
  assert.equal(await lifecycleOf(C),'closed');assert.equal((await allocationRow(C)).state,'released');assert.equal((await jobRow(jobC)).status,'succeeded');
  const cClosed=await closedEvent(C);assert.equal(cClosed.convertDegradedToRetain,true);
  assert.deepEqual((await stagesOf(jobC)).map(s=>s.plan_json.kind),['withdraw','swap'],'no stage is repeated and the reverted row is kept as history');
  assert.equal(signCalls>0,true);

  // ============================================================ S5: a crash between queue.finish and the terminal event is recovered for a degraded convert
  review=await recordConvert(E);const jobE=(await request(E,review,'convert-e-1')).jobId;
  w=await exec();assert.match(w.stage,/^withdraw:/);
  revertKind.set(E.campaignId,'swap');
  w=await exec();assert.equal(w.reason,'canonical_stage_reverted_after_cost_attribution');
  failComplete=true;
  w=await exec();assert.equal(w.status,'blocked',JSON.stringify(w));assert.match(w.reason,/injected crash/);
  assert.equal((await jobRow(jobE)).status,'succeeded','the queue already finished the job');assert.equal(await lifecycleOf(E),'active','the terminal event has not been written');
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_runtime_events WHERE campaign_id=$1 AND kind='closed'`,[E.campaignId])).rows[0].n,0);
  w=await exec();assert.equal(w.status,'idle',JSON.stringify(w));
  assert.equal(await lifecycleOf(E),'closed','the next worker pass replays the idempotent terminal completion');assert.equal((await allocationRow(E)).state,'released');
  assert.equal((await closedEvent(E)).convertDegradedToRetain,true);assert.deepEqual([(await finalState(E)).exitMode,(await finalState(E)).lastReason],['retain','retain_close_complete']);

  // ============================================================ S6: a reverted non-sale stage still halts; finish() accepts a reverted row only for a convert sale
  review=await recordConvert(D);const jobD=(await request(D,review,'convert-d-1')).jobId;
  w=await exec();assert.match(w.stage,/^withdraw:/);
  model.allowances.set(`${token1}:router`,0n);
  revertKind.set(D.campaignId,'approve');
  w=await exec();assert.equal(w.status,'blocked',JSON.stringify(w));assert.equal(w.reason,'canonical_stage_reverted_after_cost_attribution');
  const d=(await campaignOf(D)).state;
  assert.equal(d.phase,'halted','a reverted router approval is not a recoverable sale failure');assert.match(d.haltReason,/^transaction_reverted:/);
  w=await exec();assert.equal(w.status,'blocked');assert.equal(w.reason,'canonical_stage_reverted','a halted convert exit stays blocked for operator recovery');
  const leased=(await db.query(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1 RETURNING lease_token`,[jobD])).rows[0].lease_token;
  assert(leased,'the blocked job keeps its lease for the fence below');
  await assert.rejects(queue.finish(walletIdentity,jobD,leased),/Only successfully reconciled actions can finish/,'a reverted non-swap stage can never finish a close');
  await db.query(`UPDATE deployment_live_stage_outbox SET plan_json=jsonb_set(plan_json,'{kind}','"swap"') WHERE job_id=$1 AND status='reverted'`,[jobD]);
  await db.query(`UPDATE deployment_live_jobs SET kind='close_retain' WHERE id=$1`,[jobD]);
  await assert.rejects(queue.finish(walletIdentity,jobD,leased),/Only successfully reconciled actions can finish|Pending or unknown action/,'only a convert job may skip a reverted sale');
  assert.equal(await lifecycleOf(D),'active','nothing closed the halted campaign');

  // ============================================================ final wallet-level invariants
  const wfinal=await readWalletState(db,walletIdentity);
  assert.equal(wfinal.status,'available');assert.equal(wfinal.nonce,String(model.nonce));assert.equal(wfinal.nativeBalanceWei,String(model.native));
  assert.deepEqual(Object.fromEntries(wfinal.tokens.map(t=>[t.address,t.balanceRaw])),{[token0]:String(model.t0),[token1]:String(model.t1)});
  assert.equal(wfinal.commitmentsHash,liveWalletCommitmentFingerprint(await readCommitments(db,walletIdentity)));
  assert.equal((await db.query(`SELECT count(*)::int n FROM deployment_live_stage_outbox WHERE status IN('prepared','signed')`)).rows[0].n,0);
  // Cross-build management: every management job ran under the managing build, every campaign kept its open build.
  const mgmtBuilds=(await db.query(`SELECT DISTINCT build_id FROM deployment_live_jobs WHERE kind<>'open'`)).rows.map(r=>r.build_id);
  assert.deepEqual(mgmtBuilds,[managerBuildId],'Management jobs bind to the build that admitted them');
  const stateBuilds=(await db.query(`SELECT DISTINCT state_json->>'buildId' b FROM deployment_live_campaign_runtime`)).rows.map(r=>r.b);
  assert.deepEqual(stateBuilds,[buildId],'Campaign open-build provenance is never rewritten by management');
  const reviewBuilds=(await db.query(`SELECT DISTINCT payload->>'buildId' b,payload->>'campaignBuildId' cb FROM deployment_live_reviews WHERE payload->>'kind'='rangekeeper_live_management_review'`)).rows;
  assert.deepEqual(reviewBuilds,[{b:managerBuildId,cb:buildId}]);
  console.log('RangeKeeper live convert exit isolated PostgreSQL integration passed');
 }finally{await db.end();}
}finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);admin.release();await root.end();}
