import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
import {buildIndicativePaperOpenPreview} from '../../src/deployments/paper-preview.ts';
import {costIndicativePaperOpenPreview,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES}
 from '../../src/deployments/paper-cost.ts';
import {buildPaperOpenModel} from '../../src/deployments/paper-open-model.ts';
import {sqrtRatioAtTick} from '../../src/backtest/principal.ts';

if(!process.env.TEST_DATABASE_URL)throw Error('Set TEST_DATABASE_URL to a database where isolated schemas may be created');
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});
const admin=await pool.connect();
const schema=`deployment_test_${randomUUID().replaceAll('-','')}`;
let store;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4]);
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
 assert.deepEqual(await store.completeTrustedPaperOpen(paperOperation.id,'paper-worker'),
  {markId:opened.markId,replayed:true});
 const paperRows=(await admin.query(`SELECT kind,entry_key,source FROM deployment_ledger
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
 assert.equal((await admin.query('SELECT lifecycle FROM deployment_campaigns WHERE id=$1',
  [paperDraft.id])).rows[0].lifecycle,'active');
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
 console.log(JSON.stringify({passed:['explicit migration','indexed verified profile','profile integrity and idempotency','strategy allowlist','draft and trusted preview','fresh scoped provisional gas profile','atomic idempotent gas evidence ingestion','immutable evidence','predecessor lock','idempotent operation','conflicting retry','single worker claim','restart resumes stage','wallet exclusivity','atomic failure','modeled paper open inventory and capital','idempotent mark replay','invalid candidate writes nothing']}));
}finally{
 if(store)await store.close();
 await admin.query('SET search_path=public');
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
