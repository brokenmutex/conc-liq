import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {decodeFunctionData,encodeFunctionData,keccak256} from 'viem';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore,DeploymentConflict} from '../../src/deployments/store.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {marketProfileSchema,referenceProofHash} from '../../src/deployments/market-profile.ts';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../src/constants.ts';
import {PAPER_QUOTER,PAPER_ROUTER} from '../../src/paper/execution-abi.ts';
import {guardedCanaryPositionManagerAbi} from '../../src/canary-plan/abi.ts';
import {canaryExitAbi} from '../../src/canary-plan/exit.ts';
import {buildIndicativePaperOpenPreview,readCanonicalPaperNextFrame}
 from '../../src/deployments/paper-preview.ts';
import {costIndicativePaperOpenPreview,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES}
 from '../../src/deployments/paper-cost.ts';
import {buildPaperOpenModel} from '../../src/deployments/paper-open-model.ts';
import {buildPaperCloseRetainModel} from '../../src/deployments/paper-close-model.ts';
import {buildPaperPrincipalValuation} from '../../src/deployments/paper-valuation.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {ExperimentMarket} from '../../src/experiment/market.ts';
import {readDeploymentRows,deploymentPosition,readDeploymentDetail}
 from '../../src/dashboard/deployment-position.ts';
import {readPositionOverview,readPositionDetail} from '../../src/dashboard/positions.ts';
import {createDashboardServer} from '../../src/dashboard/server.ts';
import {readIndexedPaperFeeInterval,replayPaperFeeInterval} from '../../src/deployments/paper-fee-replay.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect();
const schema=`deployment_test_${randomUUID().replaceAll('-','')}`;
let store,feePool;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4,5,6]);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(url.toString());
 await store.assertReady();
 const wallet='0x1111111111111111111111111111111111111111';
 const poolAddress='0x'+'a'.repeat(40),token0='0x'+'b'.repeat(40),token1='0x'+'c'.repeat(40);
 const codeHash='0x'+'a'.repeat(64),sourceHash='0x'+'2'.repeat(64);
 const market=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:poolAddress,token0,token1,
  quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
  positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
  poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
  managerCodeHash:codeHash,quoterCodeHash:codeHash,
  reference0:'BASE/USD',reference1:'USDG/USD',nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
   token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
   nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,4663,'BASE',$3,3000,1,$4,true)`,
  ['test-stream',poolAddress,token0,'0x'+'f'.repeat(64)]);
 const proof={profile:market,profileHash:contentHash(market),streamKey:'test-stream',
  source:{block:'100',hash:sourceHash,timestamp:Math.floor(Date.now()/1000)},
  contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
   managerCodeHash:codeHash,quoterCodeHash:codeHash},
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'1000000000000000000',proofHash:referenceProofHash({fixture:true})},
  referenceProof:{fixture:true},verifiedAt:new Date().toISOString()};
 await assert.rejects(store.registerVerifiedMarketProfile({...proof,profileHash:'b'.repeat(64)}),
  error=>error instanceof DeploymentConflict&&error.code==='profile_hash_mismatch');
 await assert.rejects(store.registerVerifiedMarketProfile({...proof,references:{...proof.references,proofHash:'b'.repeat(64)}}),
  error=>error instanceof DeploymentConflict&&error.code==='profile_reference_proof_mismatch');
 const registered=await store.registerVerifiedMarketProfile(proof);
 assert.equal(registered.created,true);
 assert.deepEqual(await store.registerVerifiedMarketProfile(proof),{id:registered.id,created:false});
 const profile=registered.id;
 feePool=new pg.Pool({connectionString:url.toString(),max:2});
 const feePrice=String(sqrtRatioAtTick(-276325)),feeHash='0x'+'4'.repeat(64),
  targetSetHash='0x'+'f'.repeat(64),Q128=1n<<128n;
 await admin.query(`INSERT INTO v3_replay_cursors
  (stream_key,chain_id,target_set_hash,complete_through_block,complete_through_hash)
  VALUES('test-stream',4663,$1,101,$2)`,[targetSetHash,feeHash]);
 await admin.query(`INSERT INTO v3_replay_pools
  (stream_key,pool_address,chain_id,rwa_symbol,fee,initialized,sqrt_price_x96,tick,
   liquidity,observation_cardinality_next)
  VALUES('test-stream',$1,4663,'BASE',3000,true,$2,-276325,1000,1)`,
  [poolAddress,feePrice]);
 await admin.query(`INSERT INTO v3_replay_ticks
  (stream_key,pool_address,tick,liquidity_gross,liquidity_net) VALUES
  ('test-stream',$1,-276420,1000,1000),('test-stream',$1,-276240,1000,-1000)`,
  [poolAddress]);
 await admin.query(`INSERT INTO v3_pool_events
  (stream_key,chain_id,pool_address,block_number,block_hash,transaction_hash,
   transaction_index,log_index,event_name,event_args,raw_topics,raw_data)
  VALUES('test-stream',4663,$1,101,$2,$3,0,0,'Flash',$4,'[]','0x')`,
  [poolAddress,feeHash,'0x'+'3'.repeat(64),JSON.stringify({paid0:'0',paid1:'10000'})]);
 const feeBefore={source:{block:'100',hash:sourceHash},poolState:{tick:-276325,
  sqrtPriceX96:feePrice,poolLiquidity:'1000',feeGrowthGlobal0X128:'0',
  feeGrowthGlobal1X128:'0'}};
 const feeAfter={source:{block:'101',hash:feeHash},poolState:{...feeBefore.poolState,
  feeGrowthGlobal1X128:String(10000n*Q128/1000n)}};
 const feeReplay=await readIndexedPaperFeeInterval(feePool,'test-stream',targetSetHash,
  market,feeBefore,feeAfter,{tickLower:-276420,tickUpper:-276240},1000n);
 assert.equal(feeReplay.token1.lowerAmountRaw,'5000');
 assert.equal(feeReplay.coverage.chainAnchorRecheckRequired,true);
 await assert.rejects(readIndexedPaperFeeInterval(feePool,'test-stream','wrong-target',
  market,feeBefore,feeAfter,{tickLower:-276420,tickUpper:-276240},1000n),
  /coverage unavailable/);
 await admin.query(`UPDATE v3_pool_events SET block_hash=$1 WHERE stream_key='test-stream'`,
  [sourceHash]);
 await assert.rejects(readIndexedPaperFeeInterval(feePool,'test-stream',targetSetHash,
  market,feeBefore,feeAfter,{tickLower:-276420,tickUpper:-276240},1000n),
  /ending block hash mismatch/);
 await admin.query(`UPDATE v3_replay_cursors SET last_block_number=102,
  last_block_hash=$1,last_transaction_hash=$2,last_transaction_index=0,
  last_log_index=0 WHERE stream_key='test-stream'`,[feeHash,'0x'+'5'.repeat(64)]);
 await assert.rejects(readIndexedPaperFeeInterval(feePool,'test-stream',targetSetHash,
  market,feeBefore,feeAfter,{tickLower:-276420,tickUpper:-276240},1000n),
  /incomplete later block/);
 const catalog=await store.listMarketProfiles();
 assert.equal(catalog.length,1);
 assert.equal(catalog[0].id,profile);
 assert.equal(catalog[0].draftAvailable,true);
 assert.equal(catalog[0].deploymentAvailable,false);
 assert.equal(catalog[0].pool.toLowerCase(),poolAddress);
 const draftInput={mode:'live',chainId:4663,wallet,marketProfileId:profile,
  strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'10000000000000000'},config:{tickLower:10,tickUpper:20}};
 await assert.rejects(store.createDraft({...draftInput,strategyId:'adaptive_v1'}));
 await admin.query("UPDATE indexer_pools SET enabled=false WHERE stream_key='test-stream'");
 assert.equal((await store.listMarketProfiles())[0].draftAvailable,false);
 assert.equal((await store.listMarketProfiles())[0].reason,'indexer_identity_changed');
 await assert.rejects(store.createDraft(draftInput),
  error=>error instanceof DeploymentConflict&&error.code==='market_profile_indexer_changed');
 await admin.query("UPDATE indexer_pools SET enabled=true WHERE stream_key='test-stream'");
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,spender:'0x'+'d'.repeat(40)}}));
 await assert.rejects(store.createDraft({...draftInput,config:{...draftInput.config,calldata:'0xdeadbeef'}}));
 const paperLimits={maxDeploymentValue:String(250n*10n**18n),minDeploymentValue:'1',
  maxExposurePpm:1000000,maxLossValue:String(250n*10n**18n),maxDrawdownPpm:1000000,
  maxActionCost:String(10n**18n),maxRollingCost:String(10n**18n),maxCampaignCost:String(10n**18n),
  exitReserveWei:'1000000000000000',maxSlippageBps:50};
 const paperDraft=await store.createDraft({...draftInput,mode:'paper',
  allocation:{token0Raw:'1000000000000000000',token1Raw:'250000000',nativeWei:'10000000000000000'},
  config:{tickLower:-276400,tickUpper:-276250,limits:paperLimits}});
 const paperInput=await store.paperDraft(paperDraft.id);
 assert.equal(paperInput.strategyId,'static_manual_v1');
 assert.equal(paperInput.profile.pool.fee,3000);
 assert.equal(paperInput.allocation.token1Raw,'250000000');
 const frame={source:{block:'100',hash:sourceHash,timestamp:Math.floor(Date.now()/1000)},
  tick:-276325,sqrtPriceX96:sqrtRatioAtTick(-276325),poolLiquidity:10n**24n,
  price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,
  referenceEligible:true,referenceReasons:[],referenceProofHash:referenceProofHash({fixture:true}),
  referenceProof:{fixture:true}};
 const indicative=buildIndicativePaperOpenPreview(paperInput,frame);
 assert.equal(indicative.status,'indicative');assert.equal(indicative.actionAvailable,false);
 assert.equal(indicative.economics,null);assert.equal(indicative.candidate.range.fullWidthTicks,180);
 const detached=buildIndicativePaperOpenPreview(paperInput,{...frame,sqrtPriceX96:sqrtRatioAtTick(0)});
 assert.equal(detached.status,'unavailable');assert.equal(detached.reason,'independent_price_band');
 const stale=buildIndicativePaperOpenPreview(paperInput,{...frame,source:{...frame.source,timestamp:frame.source.timestamp-181}});
 assert.equal(stale.status,'unavailable');assert.equal(stale.reason,'source_stale');
 const noReference=buildIndicativePaperOpenPreview(paperInput,{...frame,price0:null,referenceEligible:false,
  referenceReasons:['token0_oracle_missing']});
 assert.equal(noReference.status,'unavailable');assert.match(noReference.reason,/independent_reference_unavailable/);
 const noCosts=costIndicativePaperOpenPreview(indicative,[],poolAddress,10n**18n,1_000_000_000n);
 assert.equal(noCosts.costs.status,'unavailable');
 assert.equal(noCosts.costs.reason,'complete_fresh_stage_costs_unavailable');
 const gasSource={block:'100',hash:sourceHash,estimatedAt:new Date().toISOString(),
  callHash:'0x'+'4'.repeat(64),method:'owned_fork_nitro_exact_call_v1'};
 for(const stage of PAPER_STATIC_GAS_STAGES){
  const model={schemaVersion:1,source:gasSource,gasUnitsExpected:'100000',gasUnitsBound:'150000',
   sizeMinValue:'1',sizeMaxValue:String(500n*10n**18n),shareMinPpm:'0',shareMaxPpm:'1000000',
   tickLower:indicative.candidate.range.tickLower,tickUpper:indicative.candidate.range.tickUpper};
  await admin.query(`INSERT INTO deployment_calibration_profiles
   (id,version,chain_id,pool_address,path_version,stage,allowance_state,size_band,
    component,status,evidence_class,model,validation,source_hash,observed_until)
   VALUES($1,1,4663,$2,$3,$4,'zero','one_to_500_usd','gas_units','provisional',
    'fork_estimated',$5,'{}',$6,$7)`,[randomUUID(),poolAddress,PAPER_STATIC_GAS_PATH,stage,
    JSON.stringify(model),contentHash(gasSource),gasSource.estimatedAt]);
 }
 const gasRows=await store.paperGasProfiles(poolAddress);
 assert.equal(gasRows.length,6);
 const costed=costIndicativePaperOpenPreview(indicative,gasRows,poolAddress,10n**18n,1_000_000_000n);
 assert.equal(costed.costs.status,'provisional');
 assert.equal(costed.costs.open.expectedGasUnits,'300000');
 assert.equal(costed.costs.closeRetain.boundWei,'562500000000000');
 assert.equal(costed.actionAvailable,false);assert.equal(costed.economics,null);
 const incomplete=costIndicativePaperOpenPreview(indicative,gasRows.slice(1),poolAddress,10n**18n,1_000_000_000n);
 assert.equal(incomplete.costs.status,'unavailable');
 const expired=gasRows.map(row=>({...row,observedUntil:new Date(Date.now()-86_500_000)}));
 assert.equal(costIndicativePaperOpenPreview(indicative,expired,poolAddress,10n**18n,1_000_000_000n)
  .costs.status,'unavailable');
 const borrowed=gasRows.map(row=>({...row,poolAddress:'0x'+'d'.repeat(40)}));
 assert.equal(costIndicativePaperOpenPreview(indicative,borrowed,poolAddress,10n**18n,1_000_000_000n)
  .costs.status,'unavailable');
 assert.equal(costIndicativePaperOpenPreview(indicative,gasRows,poolAddress,10n**18n,0n)
  .costs.reason,'gas_price_or_native_reference_unavailable');
 const rejectedNewer=gasRows.map(row=>row.stage==='mint'?{...row,version:2,status:'rejected'}:row);
 assert.equal(costIndicativePaperOpenPreview(indicative,[...gasRows,...rejectedNewer],poolAddress,
  10n**18n,1_000_000_000n).costs.status,'unavailable');
 // Direct store registration tests atomicity/idempotence in an isolated schema.
 // The real CLI obtains this attestation by replaying the canonical source.
 const artifact=JSON.parse(readFileSync(new URL('../../research/calibration/static-manual-aapl-usdg-fork-2026-09-22.json',
  import.meta.url),'utf8'));
 const calibrationPool=marketProfileSchema.parse(artifact.profile).pool;
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,fee,
  created_block,target_set_hash,enabled) VALUES($1,$2,4663,'AAPL',$3,$4,1,$5,true)`,
  ['calibration-stream',calibrationPool.pool,
   calibrationPool.quoteToken===0?calibrationPool.token1:calibrationPool.token0,
   calibrationPool.fee,'0x'+'e'.repeat(64)]);
 const calibrationCode={poolCodeHash:calibrationPool.poolCodeHash,
  token0CodeHash:calibrationPool.token0CodeHash,token1CodeHash:calibrationPool.token1CodeHash,
  managerCodeHash:calibrationPool.managerCodeHash,quoterCodeHash:calibrationPool.quoterCodeHash};
 const calibrationProof={profile:artifact.profile,profileHash:artifact.profileHash,streamKey:'calibration-stream',
  source:{block:'100',hash:sourceHash,timestamp:Math.floor(Date.now()/1000)},
  contractHashes:calibrationCode,
  references:{price0:'1000000000000000000',price1:'1000000000000000000',
   nativePrice:'1000000000000000000',proofHash:referenceProofHash({fixture:true})},
  referenceProof:{fixture:true},verifiedAt:new Date().toISOString()};
 await store.registerVerifiedMarketProfile(calibrationProof);
 const fresh=structuredClone(artifact),stamp=new Date().toISOString();
 fresh.sampledAt=stamp;fresh.source.timestamp=Math.floor(Date.now()/1000);
 for(const stage of fresh.stageProfiles){
  if(stage.stage==='mint'){
   const decoded=decodeFunctionData({abi:guardedCanaryPositionManagerAbi,data:stage.evidence.calldata});
   stage.evidence.calldata=encodeFunctionData({abi:guardedCanaryPositionManagerAbi,
    functionName:'mint',args:[{...decoded.args[0],deadline:BigInt(fresh.source.timestamp+300)}]});
  }else if(stage.stage==='withdraw_collect'){
   const outer=decodeFunctionData({abi:canaryExitAbi,data:stage.evidence.calldata});
   const decrease=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][0]});
   const newDecrease=encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',
    args:[{...decrease.args[0],deadline:BigInt(fresh.source.timestamp+300)}]});
   stage.evidence.calldata=encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',
    args:[[newDecrease,outer.args[0][1]]]});
  }
  stage.model.source.callHash=keccak256(stage.evidence.calldata);
  stage.model.source.estimatedAt=stamp;
  stage.sourceHash=contentHash(stage.model.source);
 }
 fresh.candidateHash=contentHash({campaignId:fresh.campaignId,revision:fresh.revision,
  profileHash:fresh.profileHash,configHash:fresh.configHash,source:fresh.source,
  referenceProofHash:fresh.reference.proofHash,candidate:fresh.candidate});
 const {reportHash:_old,...freshBody}=fresh;fresh.reportHash=contentHash(freshBody);
 const attestation={verificationClass:'canonical_candidate_replay_v1',reportHash:fresh.reportHash,
  sourceHash:fresh.source.hash,profileHash:fresh.profileHash,verifiedAt:new Date().toISOString()};
 const registration=await store.registerPaperGasEvidence(fresh,attestation);
 assert.equal(registration.created,true);assert.equal(registration.version,1);
 assert.equal(registration.profileIds.length,6);
 const repeated=await store.registerPaperGasEvidence(fresh,attestation);
 assert.equal(repeated.created,false);assert.deepEqual(repeated.profileIds.sort(),registration.profileIds.sort());
 const imported=await store.paperGasProfiles(calibrationPool.pool);
 assert.equal(imported.length,6);
 const importedCost=costIndicativePaperOpenPreview({status:'indicative',candidate:fresh.candidate,
  actionAvailable:false,economics:null},imported,calibrationPool.pool,10n**18n,1_000_000_000n);
 assert.equal(importedCost.costs.status,'provisional');
 const shiftedRange={...fresh.candidate,range:{...fresh.candidate.range,
  tickLower:fresh.candidate.range.tickLower-calibrationPool.tickSpacing}};
 assert.equal(costIndicativePaperOpenPreview({status:'indicative',candidate:shiftedRange,
  actionAvailable:false,economics:null},imported,calibrationPool.pool,10n**18n,1_000_000_000n)
  .costs.status,'unavailable');
 const tampered=structuredClone(fresh);tampered.stageProfiles[0].model.gasUnitsExpected='1';
 await assert.rejects(store.registerPaperGasEvidence(tampered,attestation));
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_calibration_profiles
  WHERE lower(pool_address)=lower($1)`,[calibrationPool.pool])).rows[0].n,6);
 await new Promise(resolve=>setTimeout(resolve,10));
 const newer=structuredClone(fresh),newStamp=new Date().toISOString();
 newer.sampledAt=newStamp;
 for(const stage of newer.stageProfiles){
  stage.model.source.estimatedAt=newStamp;
  stage.sourceHash=contentHash(stage.model.source);
 }
 const {reportHash:_prior,...newerBody}=newer;newer.reportHash=contentHash(newerBody);
 const newerAttestation={...attestation,reportHash:newer.reportHash,verifiedAt:new Date().toISOString()};
 const secondVersion=await store.registerPaperGasEvidence(newer,newerAttestation);
 assert.equal(secondVersion.version,2);assert.equal(secondVersion.created,true);
 await assert.rejects(store.registerPaperGasEvidence(fresh,attestation),
  error=>error instanceof DeploymentConflict&&error.code==='paper_gas_report_superseded');
 assert((await store.paperGasProfiles(calibrationPool.pool)).every(row=>row.version===2||row.version===1));
 const draft=await store.createDraft(draftInput);
 await assert.rejects(store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'1'},evidence:{blockHash:'0x'+'2'.repeat(64)},
  expiresAt:new Date(Date.now()+10*60*1000)}),
  error=>error instanceof DeploymentConflict&&error.code==='preview_expiry_too_distant');
 const preview=await store.recordPreview({campaignId:draft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'1',token0Raw:'0'},
  evidence:{blockHash:'0x'+'2'.repeat(64)},expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(admin.query('UPDATE deployment_revisions SET config=$2 WHERE campaign_id=$1',
  [draft.id,'{}']),/append-only/);
 await assert.rejects(admin.query('DELETE FROM deployment_previews WHERE id=$1',[preview.id]),/append-only/);
 const command={previewId:preview.id,contentDigest:preview.contentDigest,expectedRevision:1,
  idempotencyKey:'deployment-open-unique-1'};
 const blocker=await pool.connect();
 try{
  await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  await assert.rejects(store.acceptOperation(draft.id,command,'operator'),
   error=>error instanceof DeploymentConflict&&error.code==='predecessor_wallet_locked');
 }finally{
  await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`conc-liq-live:4663:${wallet.toLowerCase()}`]);
  blocker.release();
 }
 const first=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(first.status,'queued');assert.equal(first.replayed,false);
 assert.equal((await store.operation(first.id)).status,'queued');
 const replay=await store.acceptOperation(draft.id,command,'operator');
 assert.equal(replay.id,first.id);assert.equal(replay.replayed,true);
 await assert.rejects(store.acceptOperation(draft.id,{...command,contentDigest:'f'.repeat(64)},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='idempotency_conflict');
 assert.equal(await store.claimNext('paper-worker',30,'paper'),null);
 const claimed=await Promise.all([store.claimNext('worker-one',30,'live'),store.claimNext('worker-two',30,'live')]);
 assert.equal(claimed.filter(Boolean).length,1);
 const owner=claimed[0]?'worker-one':'worker-two';
 assert.equal(claimed.find(Boolean).id,first.id);
 await assert.rejects(store.advanceClaim(first.id,owner==='worker-one'?'worker-two':'worker-one',
  'preflight','executing',null),error=>error instanceof DeploymentConflict&&error.code==='claim_lost_or_transition_disallowed');
 await store.advanceClaim(first.id,owner,'source_checked','executing',null);
 await store.renewClaim(first.id,owner,30);
 await assert.rejects(store.advanceClaim(first.id,owner,'backwards','preflighting',null),
  error=>error instanceof DeploymentConflict&&error.code==='claim_lost_or_transition_disallowed');
 await assert.rejects(store.advanceClaim(first.id,owner,'unproven','succeeded',null),
  error=>error instanceof DeploymentConflict&&error.code==='invalid_claim_transition');
 await admin.query(`UPDATE deployment_operations SET claim_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[first.id]);
 const recovered=await store.claimNext('worker-restart',30,'live');
 assert.equal(recovered.id,first.id);assert.equal(recovered.stage,'source_checked');
 assert.equal(recovered.status,'executing');
 const second=await store.createDraft(draftInput);
 const secondPreview=await store.recordPreview({campaignId:second.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{sourceBlock:'2'},evidence:{blockHash:'0x'+'3'.repeat(64)},
  expiresAt:new Date(Date.now()+60000)});
 await assert.rejects(store.acceptOperation(second.id,{previewId:secondPreview.id,
  contentDigest:secondPreview.contentDigest,expectedRevision:1,idempotencyKey:'deployment-open-unique-2'},'operator'),
  error=>error instanceof DeploymentConflict&&error.code==='wallet_reserved');
 const rows=(await admin.query('SELECT id,status FROM deployment_operations')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].id,first.id);
 const reservations=(await admin.query('SELECT campaign_id FROM deployment_wallet_reservations WHERE released_at IS NULL')).rows;
 assert.deepEqual(reservations.map(row=>row.campaign_id),[draft.id]);
 const paperModel=buildPaperOpenModel(paperInput,frame,costed);
 assert.equal(paperModel.kind,'paper_open_model');
 assert.throws(()=>buildPaperOpenModel(paperInput,{...frame,referenceProof:{fixture:false}},costed),
  /paper_open_source_mismatch/);
 const paperPreview=await store.recordPreview({campaignId:paperDraft.id,expectedRevision:1,kind:'open',
  request:{kind:'open'},proposal:{paperOpenModel:paperModel},
  evidence:{verificationClass:'isolated_fixture'},expiresAt:new Date(Date.now()+60000)});
 const paperOperation=await store.acceptOperation(paperDraft.id,{previewId:paperPreview.id,
  contentDigest:paperPreview.contentDigest,expectedRevision:1,
  idempotencyKey:'paper-open-model-unique-1'},'operator');
 const paperClaim=await store.claimNext('paper-worker',30,'paper');
 assert.equal(paperClaim.id,paperOperation.id);
 await assert.rejects(store.completeTrustedPaperOpen(paperOperation.id,'wrong-worker'),
  error=>error instanceof DeploymentConflict&&error.code==='paper_open_claim_lost');
 await store.advanceClaim(paperOperation.id,'paper-worker','model_checked','executing',null);
 await store.advanceClaim(paperOperation.id,'paper-worker','ready_to_record','reconciling',null);
 const opened=await store.completeTrustedPaperOpen(paperOperation.id,'paper-worker');
 assert.equal(opened.replayed,false);
 assert.equal(await store.paperFeeSamplingState(paperDraft.id),null);
 assert.deepEqual(await store.completeTrustedPaperOpen(paperOperation.id,'paper-worker'),
  {markId:opened.markId,replayed:true});
 const paperRows=(await admin.query(`SELECT kind,entry_key,value_raw,source FROM deployment_ledger
  WHERE campaign_id=$1 ORDER BY id`,[paperDraft.id])).rows;
 assert.equal(paperRows.length,3);
 assert(paperRows.every(row=>row.kind==='capital_in'&&
  row.source.classification==='paper_model_provisional'));
 const paperMarks=(await admin.query(`SELECT id::text,inventory,economics,calibration_profile_ids,provenance
  FROM deployment_marks WHERE campaign_id=$1`,[paperDraft.id])).rows;
 assert.equal(paperMarks.length,1);assert.equal(paperMarks[0].id,opened.markId);
 assert.equal(paperMarks[0].economics,null);
 assert.equal(paperMarks[0].inventory.position.liquidity,paperModel.candidate.liquidity);
 assert.equal(paperMarks[0].calibration_profile_ids.length,6);
 assert.equal(paperMarks[0].provenance.paidCostsAvailable,false);
 const openAccounting=await store.recordNextPaperAccounting(paperDraft.id);
 assert.equal(openAccounting.kind,'open');
 assert.equal(openAccounting.markId,opened.markId);
 assert.equal(await store.recordNextPaperAccounting(paperDraft.id),null);
 const openSnapshot=(await admin.query(`SELECT snapshot,snapshot_hash FROM deployment_paper_accounting
  WHERE id=$1`,[openAccounting.snapshotId])).rows[0];
 assert.equal(openSnapshot.snapshot.classification,'provisional_paper_scenario');
 assert.equal(openSnapshot.snapshot.inventory.nativeWei,
  String(BigInt(paperInput.allocation.nativeWei)-BigInt(paperModel.costs.open.expectedWei)));
 assert.equal(openSnapshot.snapshot.flows.length,1);
 assert.equal(openSnapshot.snapshot.flows[0].kind,'modeled_gas');
 assert.equal(openSnapshot.snapshot.economics.alphaQuote,
  String(-BigInt(paperModel.costs.open.expectedValue)));
 assert.equal(openSnapshot.snapshot_hash,contentHash(openSnapshot.snapshot));
 assert.equal(openSnapshot.snapshot.economics.initialCapitalQuote,
  String(paperRows.reduce((sum,row)=>sum+BigInt(row.value_raw),0n)));
 await assert.rejects(admin.query('UPDATE deployment_paper_accounting SET snapshot=$2 WHERE id=$1',
  [openAccounting.snapshotId,'{}']),/append-only/);
 assert.equal((await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',
  [paperDraft.id])).rows[0].lifecycle,'active');
 const openingRows=await readDeploymentRows(admin);
 const listedPaper=openingRows.find(row=>row.id===paperDraft.id);
 assert(listedPaper);
 const paperPosition=deploymentPosition(listedPaper);
 assert.equal(paperPosition.id,`paper-dep-${paperDraft.id}`);
 assert.equal(paperPosition.accounting,'provisional');
 assert.equal(paperPosition.navQuote,String(BigInt(openSnapshot.snapshot.economics.netNavQuote)/10n**12n));
 assert.equal(paperPosition.gasQuote,String(BigInt(openSnapshot.snapshot.economics.cumulativeGasExpenseQuote)/10n**12n));
 assert.equal(paperPosition.inventory.nativeWei,openSnapshot.snapshot.inventory.nativeWei);
 assert.equal(deploymentPosition({...listedPaper,accounting_hash:'invalid'}).navQuote,null);
 assert.equal(paperPosition.initialQuote,'251010000');
 assert.equal(paperPosition.inventory.tokens.length,2);
 assert.equal(paperPosition.inventory.tokens[0].amountRaw,paperInput.allocation.token0Raw);
 assert.equal(paperPosition.inventory.tokens[0].decimals,18);
 assert.equal(paperPosition.referencePriceQuoteX18,'1000000000000000000');
 assert.equal(paperPosition.status,'open');
 const outside=deploymentPosition({...listedPaper,range_state:'outside'});
 assert.equal(outside.status,'outside');
 assert(outside.reasons.includes('outside_range_manual_hold'));
 assert(!outside.reasons.includes('operation_blocked'));
 const keeperOutside=deploymentPosition({...listedPaper,strategy_id:'rangekeeper_v1',range_state:'outside'});
 assert.equal(keeperOutside.status,'outside');
 assert(keeperOutside.reasons.includes('outside_range_observed'));
 assert(!keeperOutside.reasons.includes('outside_range_manual_hold'));
 assert.equal(deploymentPosition({...listedPaper,lifecycle:'paused',range_state:'outside'}).status,'paused');
 assert.equal(deploymentPosition({...listedPaper,lifecycle:'changing'}).status,'changing');
 assert.equal(deploymentPosition({...listedPaper,range_state:'unknown'}).status,'unknown');
 assert(deploymentPosition({...listedPaper,provenance:{}}).reasons.includes('source_unavailable'));
 assert.equal(deploymentPosition({...listedPaper,lifecycle:'closing'}).status,'exiting');
 assert.equal(deploymentPosition({...listedPaper,lifecycle:'closed'}).status,'closed');
 await admin.query(`UPDATE deployment_operations SET status='blocked',stage='recovery',reason='receipt_mismatch'
  WHERE id=$1`,[paperOperation.id]);
 await admin.query(`UPDATE deployment_campaigns SET lifecycle='blocked' WHERE id=$1`,[paperDraft.id]);
 const blocked=deploymentPosition((await readDeploymentRows(admin)).find(row=>row.id===paperDraft.id));
 assert.equal(blocked.status,'blocked');
 assert.deepEqual(blocked.deployment.operation,
  {status:'blocked',stage:'recovery',reason:'receipt_mismatch'});
 await admin.query(`UPDATE deployment_operations SET status='succeeded',stage='recorded',reason=NULL
  WHERE id=$1`,[paperOperation.id]);
 await admin.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[paperDraft.id]);
 const openingLive=openingRows.find(row=>row.id===draft.id);
 assert(openingLive);
 assert.equal(deploymentPosition(openingLive).status,'waiting');
 assert.equal(deploymentPosition(openingLive).navQuote,null);
 const openingDetail=await readDeploymentDetail(admin,listedPaper,1);
 assert.equal(openingDetail.performance.markCount,1);
 assert.equal(openingDetail.performance.timeline[0].economicNavQuote,paperPosition.navQuote);
 assert.equal(openingDetail.performance.timeline[0].action,'enter');
 assert.equal(openingDetail.performance.timeline[0].tickLower,paperModel.candidate.range.tickLower);
 assert.equal(openingDetail.performance.timeline[0].referencePriceQuoteX18,'1000000000000000000');
 assert.equal(openingDetail.position.navQuote,paperPosition.navQuote);
 const overview=await readPositionOverview(admin,'test-stream');
 assert(overview.positions.some(position=>position.id===paperPosition.id));
 const apiDetail=await readPositionDetail(admin,'test-stream',paperPosition.id,1);
 assert.equal(apiDetail.performance.markCount,1);
 await assert.rejects(admin.query('UPDATE deployment_marks SET economics=$2 WHERE id=$1',
  [opened.markId,'{}']),/append-only/);
 const invalidPaperDraft=await store.createDraft({...draftInput,mode:'paper',
  allocation:paperInput.allocation,config:paperInput.parameters});
 const invalidModel={...paperModel,campaignId:invalidPaperDraft.id,
  candidate:{...paperModel.candidate,liquidity:'1'}};
 const invalidPreview=await store.recordPreview({campaignId:invalidPaperDraft.id,expectedRevision:1,
  kind:'open',request:{kind:'open'},proposal:{paperOpenModel:invalidModel},
  evidence:{verificationClass:'isolated_fixture'},expiresAt:new Date(Date.now()+60000)});
 const invalidOperation=await store.acceptOperation(invalidPaperDraft.id,{previewId:invalidPreview.id,
  contentDigest:invalidPreview.contentDigest,expectedRevision:1,
  idempotencyKey:'paper-open-invalid-unique-1'},'operator');
 await store.claimNext('paper-worker',30,'paper');
 await store.advanceClaim(invalidOperation.id,'paper-worker','model_checked','executing',null);
 await store.advanceClaim(invalidOperation.id,'paper-worker','ready_to_record','reconciling',null);
 await assert.rejects(store.completeTrustedPaperOpen(invalidOperation.id,'paper-worker'),
  error=>error instanceof DeploymentConflict&&error.code==='paper_open_candidate_mismatch');
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_ledger WHERE campaign_id=$1',
  [invalidPaperDraft.id])).rows[0].n,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_marks WHERE campaign_id=$1',
  [invalidPaperDraft.id])).rows[0].n,0);
 const initialValuationState=await store.paperValuationState(paperDraft.id);
 assert.equal(initialValuationState.openMarkId,opened.markId);
 assert.equal(initialValuationState.previous.markId,opened.markId);
 assert.equal(initialValuationState.openModel.candidateHash,paperModel.candidateHash);
 await assert.rejects(readCanonicalPaperNextFrame({getBlock:async()=>({hash:'0x'+'f'.repeat(64)})},
  paperInput.profile,initialValuationState.previous),/paper_prior_source_reorged/);
 const valuationFrame={...frame,source:{...frame.source,block:'101',hash:'0x'+'3'.repeat(64)}};
 const valuationModel=buildPaperPrincipalValuation(paperModel,opened.markId,
  {markId:opened.markId,sourceBlock:'100',sourceHash},valuationFrame,paperInput.profile);
 const valuationResults=await Promise.all([
  store.recordTrustedPaperPrincipalValuation(valuationModel),
  store.recordTrustedPaperPrincipalValuation(valuationModel)]);
 assert.deepEqual(valuationResults.map(result=>result.replayed).sort(),[false,true]);
 assert.equal(valuationResults[0].markId,valuationResults[1].markId);
 const valuation=valuationResults[0];
 await assert.rejects(store.recordTrustedPaperPrincipalValuation({...valuationModel,
  source:{...valuationModel.source,hash:'0x'+'4'.repeat(64)}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_valuation_conflicting_source');
 await assert.rejects(store.recordTrustedPaperPrincipalValuation({...valuationModel,
  previousMarkId:valuation.markId,previousSource:{block:'101',hash:valuationFrame.source.hash},
  source:{...valuationModel.source,block:'102',timestamp:frame.source.timestamp-1}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_valuation_source_time_regressed');
 const valuationMark=(await admin.query(`SELECT inventory,economics,calibration_profile_ids
  FROM deployment_marks WHERE id=$1`,[valuation.markId])).rows[0];
 assert.equal(valuationMark.inventory.token0Raw,null);
 assert.equal(valuationMark.economics.netNav,null);
 assert.equal(valuationMark.economics.alpha,null);
 assert.equal(valuationMark.economics.principalOnlyValue,
  valuationModel.lowerBound.principalOnlyValue);
 const valuedDetail=await readPositionDetail(admin,'test-stream',paperPosition.id,1);
 assert.equal(valuedDetail.performance.markCount,2);
 assert.equal(valuedDetail.performance.timeline[1].principalOnlyValue,
  String(BigInt(valuationModel.lowerBound.principalOnlyValue)/10n**12n));
 assert.equal(valuedDetail.performance.timeline[1].passiveTokenValue,
  String(BigInt(valuationMark.economics.passiveTokenValue)/10n**12n));
 assert.equal(valuedDetail.performance.timeline[1].economicNavQuote,null);
 assert.equal(valuationMark.calibration_profile_ids.length,0);
 assert.equal((await admin.query('SELECT count(*)::int AS n FROM deployment_marks WHERE campaign_id=$1',
  [paperDraft.id])).rows[0].n,2);
 assert.equal((await store.paperValuationState(paperDraft.id)).previous.markId,valuation.markId);
 await assert.rejects(store.recordNextPaperAccounting(paperDraft.id),
  error=>error instanceof DeploymentConflict&&
   error.code==='paper_accounting_fee_evidence_unavailable');
 const feeState=await store.paperFeeSamplingState(paperDraft.id);
 assert.equal(feeState.fromMarkId,opened.markId);
 assert.equal(feeState.toMarkId,valuation.markId);
 assert.equal(feeState.before.source.hash,sourceHash);
 assert.equal(feeState.after.source.hash,valuationFrame.source.hash);
 assert.equal(feeState.stream,'test-stream');
 assert.equal(feeState.targetSetHash,targetSetHash);
 assert.equal(feeState.liquidity,BigInt(paperModel.candidate.liquidity));
 const feeSeed={price:String(frame.sqrtPriceX96),tick:frame.tick,
  liquidity:String(frame.poolLiquidity),global0:'0',global1:'0',protocol0:0,protocol1:0,
  fee:paperInput.profile.pool.fee,spacing:paperInput.profile.pool.tickSpacing,
  ticks:[{tick:-276420,gross:String(frame.poolLiquidity),net:String(frame.poolLiquidity)},
   {tick:-276240,gross:String(frame.poolLiquidity),net:String(-frame.poolLiquidity)}]};
 const feeMarket=new ExperimentMarket(feeSeed);
 const hypotheticalFeeEvent={block:'101',hash:valuationFrame.source.hash,tx:0,log:0,
  name:'Flash',args:{paid0:'0',paid1:String(10n**20n)}};
 feeMarket.apply(hypotheticalFeeEvent);
 const feeInterval=replayPaperFeeInterval(feeSeed,[hypotheticalFeeEvent],
  {source:{block:'100',hash:sourceHash},poolState:{tick:frame.tick,
   sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity),
   feeGrowthGlobal0X128:'0',feeGrowthGlobal1X128:'0'}},
  {source:{block:'101',hash:valuationFrame.source.hash},poolState:{tick:feeMarket.tick,
   sqrtPriceX96:String(feeMarket.price),poolLiquidity:String(feeMarket.liquidity),
   feeGrowthGlobal0X128:String(feeMarket.global0),
   feeGrowthGlobal1X128:String(feeMarket.global1)}},
  paperModel.candidate.range,BigInt(paperModel.candidate.liquidity),
  {address:poolAddress,token0,token1,fee:3000,tickSpacing:60});
 // Stubbed canonical recheck here exercises persistence, not RPC validation.
 const verifiedFeeInterval={...feeInterval,coverage:{stream:'test-stream',
  targetSetHash,completeThroughBlock:'101',completeThroughHash:valuationFrame.source.hash,
  chainAnchorRecheckRequired:false}};
 await assert.rejects(store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,{...verifiedFeeInterval,coverage:{...verifiedFeeInterval.coverage,
   chainAnchorRecheckRequired:true}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_fee_interval_rejected');
 await assert.rejects(store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,{...verifiedFeeInterval,to:{...verifiedFeeInterval.to,hash:sourceHash}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_fee_mark_source_mismatch');
 const savedFee=await store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,verifiedFeeInterval);
 assert.equal(savedFee.replayed,false);
 const valuedAccounting=await store.recordNextPaperAccounting(paperDraft.id);
 assert.equal(valuedAccounting.kind,'valuation');
 assert.equal(valuedAccounting.markId,valuation.markId);
 assert.equal(await store.recordNextPaperAccounting(paperDraft.id),null);
 const valuedSnapshot=(await admin.query(`SELECT snapshot FROM deployment_paper_accounting
  WHERE id=$1`,[valuedAccounting.snapshotId])).rows[0].snapshot;
 assert.equal(valuedSnapshot.feeEvidence.id,savedFee.evidenceId);
 assert.equal(valuedSnapshot.inventory.fee1Raw,
  String(BigInt(verifiedFeeInterval.token1.lowerRawQ128)/(1n<<128n)));
 assert.equal(valuedSnapshot.flows.filter(flow=>flow.kind==='modeled_fee').length,2);
 assert.equal(valuedSnapshot.economics.netNavQuote,
  String(BigInt(valuedSnapshot.economics.passiveQuote)+
   BigInt(valuedSnapshot.economics.alphaQuote)));
 assert.equal(valuationMark.economics.netNav,null);
 assert.equal(await store.paperFeeSamplingState(paperDraft.id),null);
 assert.deepEqual(await store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,verifiedFeeInterval),{evidenceId:savedFee.evidenceId,replayed:true});
 await assert.rejects(store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,{...verifiedFeeInterval,fee:500}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_fee_profile_mismatch');
 await assert.rejects(store.recordTrustedPaperFeeEvidence(paperDraft.id,opened.markId,
  valuation.markId,{...verifiedFeeInterval,token1:{...verifiedFeeInterval.token1,
   lowerRawQ128:'0',lowerAmountRaw:'0'}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_fee_conflicting_interval');
 const persistedFee=(await admin.query(`SELECT proof,carry,proof_hash,carry_hash
  FROM deployment_paper_fee_evidence WHERE id=$1`,[savedFee.evidenceId])).rows[0];
 assert.equal(persistedFee.carry.intervals,1);
 assert.equal(persistedFee.carry.token1.lowerRawQ128,verifiedFeeInterval.token1.lowerRawQ128);
 assert.equal(persistedFee.proof.accounting,'modeled_hypothetical_fee_share');
 await assert.rejects(admin.query('UPDATE deployment_paper_fee_evidence SET proof=$2 WHERE id=$1',
  [savedFee.evidenceId,'{}']),/append-only/);
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_ledger
  WHERE campaign_id=$1 AND kind='fee'`,[paperDraft.id])).rows[0].n,0);
 assert.equal((await admin.query(`SELECT economics->>'feeIncome' AS fee_income,
  economics->>'netNav' AS net_nav FROM deployment_marks WHERE id=$1`,
  [valuation.markId])).rows[0].fee_income,null);
 const closeFrame={...frame,source:{...frame.source,block:'102',hash:'0x'+'5'.repeat(64)}};
 const closeCosts=costIndicativePaperOpenPreview({status:'indicative',candidate:paperModel.candidate},
  gasRows,poolAddress,10n**18n,1_000_000_000n);
 assert.equal(closeCosts.costs.status,'provisional');
 const priorClose={markId:valuation.markId,sourceBlock:'101',sourceHash:valuationFrame.source.hash};
 const closeModel=buildPaperCloseRetainModel(paperModel,opened.markId,priorClose,closeFrame,
  paperInput.profile,paperInput.parameters,closeCosts);
 assert.equal(closeModel.unobserved[0],'fee_capture');
 assert.throws(()=>buildPaperCloseRetainModel(paperModel,opened.markId,priorClose,
  {...closeFrame,source:{...closeFrame.source,block:'100'}},paperInput.profile,
  paperInput.parameters,closeCosts),/paper_close_source_or_position_mismatch/);
 const closePreview=await store.recordPreview({campaignId:paperDraft.id,expectedRevision:1,
  kind:'close_retain',request:{kind:'close_retain'},proposal:{paperCloseRetainModel:closeModel},
  evidence:{verificationClass:'isolated_fixture'},expiresAt:new Date(Date.now()+60000)});
 const closeOperation=await store.acceptOperation(paperDraft.id,{previewId:closePreview.id,
  contentDigest:closePreview.contentDigest,expectedRevision:1,
  idempotencyKey:'paper-close-retain-unique-1'},'operator');
 const closeClaim=await store.claimNext('paper-worker',30,'paper');
 assert.equal(closeClaim.id,closeOperation.id);
 await store.advanceClaim(closeOperation.id,'paper-worker','model_checked','executing',null);
 await store.advanceClaim(closeOperation.id,'paper-worker','ready_to_record','reconciling',null);
 await assert.rejects(store.completeTrustedPaperCloseRetain(closeOperation.id,'wrong-worker'),
  error=>error instanceof DeploymentConflict&&error.code==='paper_close_claim_lost');
 const closed=await store.completeTrustedPaperCloseRetain(closeOperation.id,'paper-worker');
 assert.equal(closed.replayed,false);
 await assert.rejects(store.recordNextPaperAccounting(paperDraft.id),
  error=>error instanceof DeploymentConflict&&
   error.code==='paper_accounting_fee_evidence_unavailable');
 const closingFeeState=await store.paperFeeSamplingState(paperDraft.id);
 assert.equal(closingFeeState.fromMarkId,valuation.markId);
 assert.equal(closingFeeState.toMarkId,closed.markId);
 assert.equal(closingFeeState.ending,'close_retain');
 assert.equal(closingFeeState.liquidity,BigInt(paperModel.candidate.liquidity));
 const closingFeeSeed={...feeSeed,global0:String(feeMarket.global0),
  global1:String(feeMarket.global1)};
 const closingFeeBefore={source:{block:'101',hash:valuationFrame.source.hash},
  poolState:{tick:feeMarket.tick,sqrtPriceX96:String(feeMarket.price),
   poolLiquidity:String(feeMarket.liquidity),feeGrowthGlobal0X128:String(feeMarket.global0),
   feeGrowthGlobal1X128:String(feeMarket.global1)}};
 const closingFeeEvent={block:'102',hash:closeFrame.source.hash,tx:0,log:0,
  name:'Flash',args:{paid0:'0',paid1:String(10n**20n)}};
 feeMarket.apply(closingFeeEvent);
 const closingFeeProof=replayPaperFeeInterval(closingFeeSeed,[closingFeeEvent],closingFeeBefore,
  {source:{block:'102',hash:closeFrame.source.hash},poolState:{tick:feeMarket.tick,
   sqrtPriceX96:String(feeMarket.price),poolLiquidity:String(feeMarket.liquidity),
   feeGrowthGlobal0X128:String(feeMarket.global0),
   feeGrowthGlobal1X128:String(feeMarket.global1)}},paperModel.candidate.range,
  BigInt(paperModel.candidate.liquidity),
  {address:poolAddress,token0,token1,fee:3000,tickSpacing:60});
 const verifiedCloseFee={...closingFeeProof,coverage:{stream:'test-stream',targetSetHash,
  completeThroughBlock:'102',completeThroughHash:closeFrame.source.hash,
  chainAnchorRecheckRequired:false}};
 await assert.rejects(store.recordTrustedPaperFeeEvidence(paperDraft.id,
  valuation.markId,closed.markId,{...verifiedCloseFee,
   to:{...verifiedCloseFee.to,hash:sourceHash}}),
  error=>error instanceof DeploymentConflict&&error.code==='paper_fee_mark_source_mismatch');
 const savedClosingFee=await store.recordTrustedPaperFeeEvidence(paperDraft.id,
  valuation.markId,closed.markId,verifiedCloseFee);
 assert.equal(savedClosingFee.replayed,false);
 const closedAccounting=await store.recordNextPaperAccounting(paperDraft.id);
 assert.equal(closedAccounting.kind,'close_retain');
 assert.equal(closedAccounting.markId,closed.markId);
 assert.equal(await store.recordNextPaperAccounting(paperDraft.id),null);
 const closedSnapshot=(await admin.query(`SELECT snapshot FROM deployment_paper_accounting
  WHERE id=$1`,[closedAccounting.snapshotId])).rows[0].snapshot;
 assert.equal(closedSnapshot.inventory.hasLiquidity,false);
 assert.equal(closedSnapshot.inventory.token0Raw,
  String(BigInt(closeModel.retainedLowerBound.token0Raw)+BigInt(closedSnapshot.inventory.fee0Raw)));
 assert.equal(closedSnapshot.inventory.token1Raw,
  String(BigInt(closeModel.retainedLowerBound.token1Raw)+BigInt(closedSnapshot.inventory.fee1Raw)));
 assert.equal(closedSnapshot.inventory.nativeWei,
  String(BigInt(paperInput.allocation.nativeWei)-BigInt(paperModel.costs.open.expectedWei)-
   BigInt(closeModel.costs.closeRetain.expectedWei)));
 assert.equal(closedSnapshot.flows.filter(flow=>flow.kind==='modeled_capital_out').length,3);
 assert.equal(closedSnapshot.flows.filter(flow=>flow.kind==='modeled_gas').length,1);
 assert.equal(closedSnapshot.economics.netNavQuote,
  String(BigInt(closedSnapshot.economics.passiveQuote)+
   BigInt(closedSnapshot.economics.alphaQuote)));
 assert.equal(closedSnapshot.flows.filter(flow=>flow.kind==='modeled_capital_out')
  .reduce((sum,flow)=>sum+BigInt(flow.valueQuote),0n),
  BigInt(closedSnapshot.economics.netNavQuote));
 assert.deepEqual(await store.recordTrustedPaperFeeEvidence(paperDraft.id,
  valuation.markId,closed.markId,verifiedCloseFee),
  {evidenceId:savedClosingFee.evidenceId,replayed:true});
 assert.equal(await store.paperFeeSamplingState(paperDraft.id),null);
 const closingCarry=(await admin.query(`SELECT carry FROM deployment_paper_fee_evidence
  WHERE id=$1`,[savedClosingFee.evidenceId])).rows[0].carry;
 assert.equal(closingCarry.intervals,2);
 assert.equal(closingCarry.through.hash,closeFrame.source.hash);
 assert.equal(closingCarry.token1.lowerRawQ128,
  String(BigInt(verifiedFeeInterval.token1.lowerRawQ128)+
   BigInt(verifiedCloseFee.token1.lowerRawQ128)));
 assert.deepEqual(await store.completeTrustedPaperCloseRetain(closeOperation.id,'paper-worker'),
  {markId:closed.markId,replayed:true});
 const finalLedger=(await admin.query(`SELECT kind,amount_raw,value_raw,source
  FROM deployment_ledger WHERE campaign_id=$1 ORDER BY id`,[paperDraft.id])).rows;
 assert.equal(finalLedger.length,6);
 assert(finalLedger.slice(3).every(row=>row.kind==='capital_out'&&
  row.amount_raw===null&&row.value_raw===null&&
  row.source.classification==='paper_model_partial_close'));
 assert.equal(finalLedger[3].source.principalLowerBoundRaw,
  closeModel.retainedLowerBound.token0Raw);
 const finalMark=(await admin.query(`SELECT inventory,economics FROM deployment_marks
  WHERE id=$1`,[closed.markId])).rows[0];
 assert.equal(finalMark.inventory.position,null);
 assert.equal(finalMark.inventory.token0Raw,null);
 assert.equal(finalMark.economics,null);
 const finalCampaign=(await admin.query(`SELECT lifecycle,range_state,closed_at FROM deployment_campaigns
  WHERE id=$1`,[paperDraft.id])).rows[0];
 assert.equal(finalCampaign.lifecycle,'closed');
 assert.equal(finalCampaign.range_state,'no_liquidity');
 assert(finalCampaign.closed_at instanceof Date);
 const closedPosition=deploymentPosition((await readDeploymentRows(admin))
  .find(row=>row.id===paperDraft.id));
 assert.equal(closedPosition.history,true);
 assert.equal(closedPosition.accounting,'provisional');
 assert.equal(closedPosition.navQuote,String(BigInt(closedSnapshot.economics.netNavQuote)/10n**12n));
 assert.equal(closedPosition.holdQuote,String(BigInt(closedSnapshot.economics.passiveQuote)/10n**12n));
 assert.equal(closedPosition.feesQuote,String(BigInt(closedSnapshot.economics.cumulativeFeeValueQuote)/10n**12n));
 assert.equal(closedPosition.gasQuote,String(BigInt(closedSnapshot.economics.cumulativeGasExpenseQuote)/10n**12n));
 assert.equal(closedPosition.inventory.tokens[0].amountRaw,closedSnapshot.inventory.token0Raw);
 assert.equal(closedPosition.inventory.tokens[1].amountRaw,closedSnapshot.inventory.token1Raw);
 assert.equal(closedPosition.inventory.nativeWei,closedSnapshot.inventory.nativeWei);
 assert.equal(closedPosition.inventory.tokens[0].lowerBoundRaw,
  closeModel.retainedLowerBound.token0Raw);
 const retainedValue=BigInt(closeModel.retainedLowerBound.token0Raw)*BigInt(closeModel.reference.price0)/10n**18n+
  BigInt(closeModel.retainedLowerBound.token1Raw)*BigInt(closeModel.reference.price1)/10n**6n;
 assert.equal(closedPosition.deployment.lowerBoundValue,String(retainedValue/10n**12n));
 assert.notEqual(closedPosition.deployment.passiveTokenValue,null);
 const closedDetail=await readPositionDetail(admin,'test-stream',paperPosition.id,168);
 assert.equal(closedDetail.performance.markCount,3);
 assert.equal(closedDetail.performance.timeline.at(-1).action,'exit');
 assert.equal(closedDetail.performance.timeline.at(-1).economicNavQuote,closedPosition.navQuote);
 assert.equal(closedDetail.performance.timeline.at(-1).holdQuote,closedPosition.holdQuote);
 assert.equal(closedDetail.performance.timeline.at(-1).principalOnlyValue,
  closedPosition.deployment.lowerBoundValue);
 assert(closedDetail.events.some(event=>event.action==='close_retain'));
 assert(closedDetail.events.some(event=>event.action==='valuation'&&event.stage==='principal_only'));
 const dashboard=createDashboardServer({snapshot:async()=>({}),
  positions:(id,hours)=>id?readPositionDetail(admin,'test-stream',id,hours):
   readPositionOverview(admin,'test-stream')},{host:'127.0.0.1',port:0});
 try{
  if(!dashboard.listening)await once(dashboard,'listening');
  const base=`http://127.0.0.1:${dashboard.address().port}`;
  const overviewResponse=await fetch(`${base}/api/positions`);
  assert.equal(overviewResponse.status,200);
  const servedOverview=await overviewResponse.json();
  assert(servedOverview.positions.some(position=>position.id===paperPosition.id&&
   position.history===true&&position.navQuote===closedPosition.navQuote&&
   position.accounting==='provisional'));
  const detailResponse=await fetch(`${base}/api/positions/${paperPosition.id}?hours=168`);
  assert.equal(detailResponse.status,200);
  const servedDetail=await detailResponse.json();
  assert.equal(servedDetail.performance.markCount,3);
  assert.equal(servedDetail.performance.timeline.at(-1).economicNavQuote,closedPosition.navQuote);
  assert(servedDetail.events.some(event=>event.action==='close_retain'));
 }finally{await new Promise((resolve,reject)=>dashboard.close(error=>error?reject(error):resolve()));}
 assert.deepEqual(await store.recordTrustedPaperPrincipalValuation(valuationModel),
  {markId:valuation.markId,replayed:true});
 await assert.rejects(store.paperValuationState(paperDraft.id),
  error=>error instanceof DeploymentConflict&&error.code==='paper_valuation_state_unavailable');
 console.log(JSON.stringify({passed:['explicit migration','indexed verified profile','profile integrity and idempotency','strategy allowlist','draft and trusted preview','fresh scoped provisional gas profile','atomic idempotent gas evidence ingestion','bounded asset-neutral indexed fee replay','adjacent hypothetical fee sampler state and immutable evidence','modeled retain-close fee interval and terminal carry','predecessor lock','idempotent operation','conflicting retry','single worker claim','restart resumes stage','wallet exclusivity','atomic failure','modeled paper open inventory and capital','idempotent mark replay','invalid candidate writes nothing','canonical prior anchor check','concurrent principal-only valuation retry and same-block conflict','valuation replay after closure','retain-close mark stays principal-only while provisional journal records scenario','idempotent close mark replay']}));
}finally{
 if(feePool)await feePool.end();
 if(store)await store.close();
 await admin.query('SET search_path=public');
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
