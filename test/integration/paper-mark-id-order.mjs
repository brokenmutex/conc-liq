// Regression for numeric deployment_marks.id ordering at the 9 -> 10 boundary.
// Run against an isolated local PostgreSQL database:
// TEST_DATABASE_URL=... node --import tsx test/integration/paper-mark-id-order.mjs
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {UNISWAP_V3_FACTORY,NONFUNGIBLE_POSITION_MANAGER} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {paperOpenModelSchema} from '../../src/deployments/paper-open-model.ts';
import {buildPaperPrincipalValuation} from '../../src/deployments/paper-valuation.ts';
import {recordCanonicalNextPaperAccounting} from '../../src/deployments/paper-accounting.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('TEST_DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
const admin=await pool.connect(),schema=`paper_mark_order_${randomUUID().replaceAll('-','')}`;
let store;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 await migrateDatabase(admin);
 const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
 scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
 const stream='paper-mark-order-fixture',targetSetHash='0x'+'f'.repeat(64),
  poolAddress='0x'+'a'.repeat(40),token0='0x'+'b'.repeat(40),token1='0x'+'c'.repeat(40),
  codeHash='0x'+'d'.repeat(64),source0={block:'100',hash:'0x'+'1'.repeat(64),timestamp:Math.floor(Date.now()/1000)-3},
  proofBody={fixture:'numeric-mark-order'},references={price0:'1000000000000000000',
   price1:'1000000000000000000',nativePrice:'1000000000000000000'},
  market=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:poolAddress,
   token0,token1,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
   positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
   poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash,reference0:'BASE/USD',reference1:'USDG/USD',
   nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{token0:{kind:'stock_token',
    maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
    token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
    nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}}),
  profileHash=contentHash(market),proofHash=referenceProofHash(proofBody);
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,4663,'BASE',$3,3000,1,$4,true)`,
  [stream,poolAddress,token0,targetSetHash]);
 const registration=await store.registerVerifiedMarketProfile({profile:market,profileHash,streamKey:stream,
  source:source0,
  contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},references:{...references,
   proofHash:referenceProofHash(proofBody)},referenceProof:proofBody,verifiedAt:new Date().toISOString()});
 const limits={maxDeploymentValue:'1000000000000000000000',minDeploymentValue:'1',maxExposurePpm:1000000,
  maxLossValue:'1000000000000000000000',maxDrawdownPpm:1000000,maxActionCost:'1000000000000000000',
  maxRollingCost:'1000000000000000000',maxCampaignCost:'1000000000000000000',exitReserveWei:'1',
  maxSlippageBps:50};
 const draft=await store.createDraft({mode:'paper',chainId:4663,wallet:'0x'+'e'.repeat(40),
  marketProfileId:registration.id,strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'1000000000000000000',token1Raw:'250000000',nativeWei:'1000000000000000000'},
  config:{tickLower:-276420,tickUpper:-276240,limits}});
 const current=await store.paperDraft(draft.id),timestamp=source0.timestamp,
  sqrt=String(sqrtRatioAtTick(-276325)),range={tickLower:-276420,tickUpper:-276240,fullWidthTicks:180},
  candidate={range,liquidity:'1000',amount0Desired:'1000000000000000000',amount1Desired:'250000000',
   amount0Minted:'100000000000000000',amount1Minted:'25000000',idle0:'900000000000000000',
   idle1:'225000000',deployedValue:'1',exposurePpm:'1',feeEarningAtEntry:true,oneSided:false,
   dilutedSharePpm:'1'},
  costs={status:'provisional',scope:'open_and_close_retain_gas_only',
   pathVersion:'paper_static_manual_no_swap_v1',sizeBand:'paper_fixture',gasPriceWei:'1',
   boundGasPriceWei:'1',gasPriceObservedAt:new Date(timestamp*1000).toISOString(),
   nativeReferencePrice:references.nativePrice,stages:Array.from({length:6},(_,index)=>({
    stage:`stage_${index}`,profileId:randomUUID(),version:1,evidenceClass:'fork_estimated',
    expectedGasUnits:'1',boundGasUnits:'1',source:{block:'100',hash:source0.hash,
     estimatedAt:new Date(timestamp*1000).toISOString(),callHash:'0x'+'2'.repeat(64),
     method:'owned_fork_nitro_exact_call_v1'}})),
   open:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
   closeRetain:{expectedGasUnits:'1',boundGasUnits:'1',expectedWei:'1',boundWei:'1',expectedValue:'1',boundValue:'1'},
   missing:[]},
  openModel=paperOpenModelSchema.parse({schemaVersion:1,kind:'paper_open_model',campaignId:draft.id,
   revision:1,strategyId:'static_manual_v1',profileHash:current.profileHash,configHash:current.configHash,
   candidateHash:'a'.repeat(64),source:source0,poolState:{tick:-276325,sqrtPriceX96:sqrt,poolLiquidity:'1000'},
   referenceProof:proofBody,referenceProofHash:proofHash,reference:references,
   allocation:{token0Raw:'1000000000000000000',token1Raw:'250000000',nativeWei:'1000000000000000000'},
   candidate,costs});
 const preview=await store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{paperOpenModel:openModel},evidence:{fixture:true},
  expiresAt:new Date(Date.now()+60_000)});
 // A fixture with no other mark rows starts the generated ID at 10 after an
 // explicit opening mark 9. The store methods below see genuine bigint IDs.
 await admin.query("SELECT setval(pg_get_serial_sequence('deployment_marks','id'),8,true)");
 await admin.query(`INSERT INTO deployment_marks(id,campaign_id,revision,source_block,source_hash,
  inventory,economics,calibration_profile_ids,provenance) VALUES(9,$1,1,$2,$3,$4,NULL,$5,$6)`,
  [draft.id,source0.block,source0.hash,JSON.stringify({classification:'paper_model_provisional',
   position:{liquidity:candidate.liquidity,tickLower:range.tickLower,tickUpper:range.tickUpper},
   token0Raw:candidate.amount0Minted,token1Raw:candidate.amount1Minted}),
   costs.stages.map(stage=>stage.profileId),JSON.stringify({classification:'paper_model_provisional',
    previewId:preview.id,modelHash:contentHash(openModel),source:source0,
    poolState:openModel.poolState,reference:openModel.reference,modeledCosts:costs,
    referenceProofHash:proofHash})]);
 await admin.query("SELECT setval(pg_get_serial_sequence('deployment_marks','id'),9,true)");
 await admin.query("UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1",[draft.id]);
 const firstState=await store.paperValuationState(draft.id);
 assert.equal(firstState.openMarkId,'9');assert.equal(firstState.previous.markId,'9');
 const valuationFrame=(block,hash,blockTime)=>({source:{block,hash,timestamp:blockTime},tick:-276325,
  sqrtPriceX96:BigInt(sqrt),poolLiquidity:1000n,price0:BigInt(references.price0),
  price1:BigInt(references.price1),nativePrice:BigInt(references.nativePrice),referenceEligible:true,
  referenceReasons:[],referenceProofHash:proofHash,referenceProof:proofBody});
 const firstModel=buildPaperPrincipalValuation(openModel,'9',
  {markId:'9',sourceBlock:'100',sourceHash:source0.hash},
  valuationFrame('101','0x'+'3'.repeat(64),timestamp+1),market);
 const first=await store.recordTrustedPaperPrincipalValuation(firstModel);
 assert.deepEqual(first,{markId:'10',replayed:false});
 const afterFirst=await store.paperValuationState(draft.id);
 assert.equal(afterFirst.previous.markId,'10','valuation reader must use numeric newest mark');
 const feeState=await store.paperFeeSamplingState(draft.id);
 assert.equal(feeState.fromMarkId,'9');assert.equal(feeState.toMarkId,'10',
  'fee sampler must choose the adjacent 9 -> 10 numeric marks');
 const interval={kind:'paper_observed_flow_fee_interval_v1',pool:poolAddress,token0Address:token0,
  token1Address:token1,fee:3000,tickSpacing:60,from:{block:'100',hash:source0.hash},
  to:{block:'101',hash:'0x'+'3'.repeat(64)},range:{tickLower:range.tickLower,tickUpper:range.tickUpper},
  liquidity:candidate.liquidity,token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},events:0,segments:0,
  partialSegments:0,accounting:'modeled_hypothetical_fee_share',coverage:{stream,
   targetSetHash,completeThroughBlock:'101',completeThroughHash:'0x'+'3'.repeat(64),
   chainAnchorRecheckRequired:false}};
 const fee=await store.recordTrustedPaperFeeEvidence(draft.id,'9','10',interval);
 assert.equal(fee.replayed,false);
 const openAccounting=await recordCanonicalNextPaperAccounting(store,{getChainId:async()=>4663,
  getBlock:async()=>({hash:source0.hash,timestamp:BigInt(timestamp)})},draft.id);
 assert.equal(openAccounting?.markId,'9','accounting must project the numeric opening mark first');
 const valuationAccounting=await recordCanonicalNextPaperAccounting(store,{getChainId:async()=>4663,
  getBlock:async({blockNumber})=>blockNumber===100n?{hash:source0.hash,timestamp:BigInt(timestamp)}:
   {hash:'0x'+'3'.repeat(64),timestamp:BigInt(timestamp+1)}},draft.id);
 assert.equal(valuationAccounting?.markId,'10','accounting must project the numeric next mark');
 const secondModel=buildPaperPrincipalValuation(openModel,'9',
  {markId:'10',sourceBlock:'101',sourceHash:'0x'+'3'.repeat(64)},
  valuationFrame('102','0x'+'4'.repeat(64),timestamp+2),market);
 const second=await store.recordTrustedPaperPrincipalValuation(secondModel);
 assert.deepEqual(second,{markId:'11',replayed:false},
  'principal writer must bind the new mark to numeric latest ID 10, not lexical ID 9');
 assert.equal((await store.paperValuationState(draft.id)).previous.markId,'11');
 console.log(JSON.stringify({status:'passed',markIds:['9','10','11'],
  exercised:['paperValuationState','paperFeeSamplingState','recordTrustedPaperPrincipalValuation',
   'recordTrustedPaperFeeEvidence','recordNextPaperAccounting'],source:'synthetic database fixture; real store methods'}));
}finally{
 await store?.close().catch(()=>{});
 await admin.query('SET search_path=public').catch(()=>{});
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(()=>{});
 admin.release();await pool.end();
}
