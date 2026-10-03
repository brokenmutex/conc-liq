// Isolated database mechanics for the disabled V3 close-convert path.
// The verifier is injected, so this proves persistence/idempotency/rollback
// mechanics only; it does not prove owned-fork replay or authorize HTTP.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {migrateDatabase} from '../../src/storage/migrations.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {referenceProofHash} from '../../src/deployments/market-profile.ts';
import {validReport} from '../fixtures/paper-close-convert-prestate-report.ts';
import {principalAmounts,sqrtRatioAtTick} from '../../src/backtest/principal.ts';
import {advancePaperFeeCarry} from '../../src/deployments/paper-fee-replay.ts';
import {advanceEphemeralStaticPaperFeeCarry} from '../../src/deployments/paper-close-convert-ephemeral-fees.ts';
import {persistTrustedStaticPaperCloseConvertPreview} from '../../src/deployments/paper-close-convert-preflight.ts';
import {PAPER_ACCOUNTING_POLICY,PAPER_CONVERSION_ACCOUNTING_POLICY_V2}
 from '../../src/deployments/paper-accounting.ts';
import {auditCanonicalPaperConversionAccountingV3} from '../../src/deployments/paper-accounting.ts';
import {maintainCanonicalPaperScenario} from '../../src/deployments/paper-maintenance.ts';
import {readDeploymentRows,readDeploymentDetail,deploymentPosition} from '../../src/dashboard/deployment-position.ts';
import {marketProfileEvidenceSchema} from '../../src/deployments/market-profile.ts';
import {rehearseStaticPaperSchemaRestore} from './helpers/static-paper-schema-restore.mjs';

assert(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required');
const runtimeIdentity={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:process.version};
process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(runtimeIdentity);
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3}),admin=await pool.connect();
const schema=`paper_close_convert_v3_${randomUUID().replaceAll('-','')}`;
let store,indexerPool;
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`SET search_path=${schema}`);
 assert.deepEqual(await migrateDatabase(admin),[1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
 const scopedUrl=new URL(process.env.TEST_DATABASE_URL);
 scopedUrl.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=15000`);
 store=new DeploymentStore(scopedUrl.toString());await store.assertReady();
 indexerPool=new pg.Pool({connectionString:scopedUrl.toString(),max:2});
 const now=Date.now(),nowSec=Math.floor(now/1000),report=validReport(),profile=report.profile,
  profileHash=contentHash(profile),targetSetHash='0x'+'4'.repeat(64),stream='fee-stream',
  limits={maxDeploymentValue:'1000000000',minDeploymentValue:'1',maxExposurePpm:1_000_000,
   maxLossValue:'1000000000',maxDrawdownPpm:1_000_000,maxActionCost:'1000000000',
   maxRollingCost:'1000000000',maxCampaignCost:'1000000000',exitReserveWei:'1',maxSlippageBps:50},
  config={halfWidthTicks:60,limits},configHash=contentHash(config),campaignId=randomUUID(),
  proof=report.openModel.referenceProof,proofHash=referenceProofHash(proof),
  opening={block:'100',hash:'0x'+'1'.repeat(64),timestamp:nowSec-20},
  previous={block:'110',hash:'0x'+'3'.repeat(64),timestamp:nowSec-10},
  sample={block:'120',hash:'0x'+'2'.repeat(64),timestamp:nowSec};
 await admin.query(`INSERT INTO indexer_pools(stream_key,pool_address,chain_id,rwa_symbol,rwa_address,
  fee,created_block,target_set_hash,enabled) VALUES($1,$2,4663,'TOKEN',$3,$4,1,$5,true)`,
 [stream,profile.pool.pool,profile.pool.quoteToken===0?profile.pool.token1:profile.pool.token0,
  profile.pool.fee,targetSetHash]);
 const profileEvidence={verificationClass:'canonical_chain_and_independent_reference_v1',
  source:opening,streamKey:stream,indexerTargetSetHash:targetSetHash,
  contractHashes:{poolCodeHash:profile.pool.poolCodeHash,token0CodeHash:profile.pool.token0CodeHash,
   token1CodeHash:profile.pool.token1CodeHash,managerCodeHash:profile.pool.managerCodeHash,
   quoterCodeHash:profile.pool.quoterCodeHash},references:{price0:'100000000000000',price1:'100',
   nativePrice:'1000000000000000000',proofHash},referenceProof:proof};
 assert(marketProfileEvidenceSchema.safeParse(profileEvidence).success);
 const registered=await store.registerVerifiedMarketProfile({profile,profileHash,streamKey:stream,
  source:opening,contractHashes:profileEvidence.contractHashes,
  references:profileEvidence.references,referenceProof:proof,verifiedAt:new Date(now).toISOString()});
 const draft=await store.createDraftWithRequestId(campaignId,{mode:'paper',chainId:4663,
  wallet:'0x1111111111111111111111111111111111111111',marketProfileId:registered.id,
  strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1,
  allocation:{token0Raw:'100',token1Raw:'35',nativeWei:'1000000000000000000'},config});
 assert.equal(draft.id,campaignId);

 // Rebind the sampler fixture to this campaign, the centered saved config and
 // fresh synthetic source anchors. The V3 calculations still use the frozen
 // range recorded on the open model.
 const open=report.openModel;open.campaignId=campaignId;open.profileHash=profileHash;
 open.configHash=draft.configHash;open.source=opening;open.referenceProof=proof;
 open.referenceProofHash=proofHash;open.reference={price0:'100000000000000',price1:'100',
  nativePrice:'1000000000000000000'};open.allocation={token0Raw:'100',token1Raw:'35',
   nativeWei:'1000000000000000000'};
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:sqrtRatioAtTick(0)});
 open.candidate.range={...open.candidate.range,requestedLower:open.candidate.range.tickLower,
  requestedUpper:open.candidate.range.tickUpper,rounded:false};
 assert(principal.amount0<=100n&&principal.amount1<=35n);
 open.candidate.idle0=String(100n-principal.amount0);open.candidate.idle1=String(35n-principal.amount1);
 open.candidate.amount0Desired=open.candidate.idle0;open.candidate.amount1Desired=open.candidate.idle1;
 open.candidate.amount0Minted='0';open.candidate.amount1Minted='0';
 open.candidateHash=contentHash({campaignId,revision:1,profileHash,configHash:open.configHash,
  source:opening,referenceProofHash:proofHash,candidate:open.candidate});
 report.campaignId=campaignId;report.profileHash=profileHash;report.openModel=open;
 report.openModelHash=contentHash(open);report.openMarkId='1';report.previousMarkId='2';
 report.previousSource=previous;report.frame.source=sample;report.frame.price0='100000000000000';
 report.frame.price1='100';report.frame.nativePrice='1000000000000000000';
 report.quote.source=sample;report.quote.quoteHash=contentHash((({quoteHash:_q,...body})=>body)(report.quote));
 report.inventory={principal0Raw:String(principal.amount0),principal1Raw:String(principal.amount1),
  idle0Raw:String(100n-principal.amount0),idle1Raw:String(35n-principal.amount1),fee0Raw:'0',
  fee1Raw:'0',token0Raw:'100',token1Raw:'35',inputAsset:'token0',inputAmountRaw:'100'};
 report.postWithdrawReplay.balances={token0:'100',token1:'35'};
 report.postWithdrawReplay.replayHash=contentHash((({replayHash:_r,...body})=>body)(report.postWithdrawReplay));
 report.feeReplay.previousFeeEvidenceId='1';report.feeReplay.from={block:previous.block,hash:previous.hash};
 report.feeReplay.to={block:sample.block,hash:sample.hash};report.feeReplay.stream=stream;
 report.feeReplay.targetSetHash=targetSetHash;
 report.gasStages.forEach((stage,index)=>{
  stage.source.block=sample.block;stage.source.hash=sample.hash;
  stage.source.estimatedAt=new Date(sample.timestamp*1000).toISOString();stage.sourceHash=contentHash(stage.source);
 });
 const zeroAmount={lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  interval=(from,to)=>({kind:'paper_observed_flow_fee_interval_v1',pool:profile.pool.pool.toLowerCase(),
   token0Address:profile.pool.token0.toLowerCase(),token1Address:profile.pool.token1.toLowerCase(),
   fee:profile.pool.fee,tickSpacing:profile.pool.tickSpacing,from:{block:from.block,hash:from.hash},
   to:{block:to.block,hash:to.hash},range:open.candidate.range,liquidity:open.candidate.liquidity,
   token0:zeroAmount,token1:zeroAmount,events:0,segments:0,partialSegments:0,
   accounting:'modeled_hypothetical_fee_share',coverage:{stream,targetSetHash,
    completeThroughBlock:to.block,completeThroughHash:to.hash,chainAnchorRecheckRequired:false}}),
  priorInterval=interval(opening,previous),priorCarry=advancePaperFeeCarry(null,priorInterval,opening),
  previousFeeProofHash=contentHash(priorInterval),previousCarryHash=contentHash(priorCarry);
 const previewOpen=await store.recordPreview({campaignId,expectedRevision:1,kind:'open',request:{},
  proposal:{paperOpenModel:open},evidence:{fixture:'synthetic_mechanics'},
  expiresAt:new Date(now+60_000)});
 const openMark=(await admin.query(`INSERT INTO deployment_marks(campaign_id,revision,source_block,
  source_hash,inventory,economics,provenance,calibration_profile_ids)
  VALUES($1,1,$2,$3,$4,'{}',$5,$6) RETURNING id::text`,
 [campaignId,opening.block,opening.hash,JSON.stringify({position:{liquidity:open.candidate.liquidity,
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper}}),
 JSON.stringify({classification:'paper_model_provisional',previewId:previewOpen.id,
  modelHash:contentHash(open),source:opening,reference:open.reference,modeledCosts:open.costs}),
  open.costs.stages.map(stage=>stage.profileId)])).rows[0].id;
 await admin.query(`INSERT INTO deployment_marks(campaign_id,revision,source_block,source_hash,
  inventory,economics,provenance) VALUES($1,1,$2,$3,$4,'{}',$5) RETURNING id`,
 [campaignId,previous.block,previous.hash,JSON.stringify({classification:'paper_model_principal_valuation',
  position:{liquidity:open.candidate.liquidity,tickLower:open.candidate.range.tickLower,
   tickUpper:open.candidate.range.tickUpper},knownLowerBound:{token0Raw:'100',token1Raw:'35'}}),
 JSON.stringify({classification:'paper_model_principal_valuation',source:previous,
  reference:open.reference})]);
 const previousMark=(await admin.query(`SELECT id::text FROM deployment_marks WHERE campaign_id=$1
  ORDER BY id DESC LIMIT 1`,[campaignId])).rows[0].id;
 const previousFee=(await admin.query(`INSERT INTO deployment_paper_fee_evidence
  (campaign_id,from_mark_id,to_mark_id,proof,proof_hash,carry,carry_hash)
  VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
 [campaignId,openMark,previousMark,JSON.stringify(priorInterval),previousFeeProofHash,
  JSON.stringify(priorCarry),previousCarryHash])).rows[0].id;
 await admin.query(`UPDATE deployment_campaigns SET lifecycle='active' WHERE id=$1`,[campaignId]);
 // Exercise the production maintenance orchestrator against real PostgreSQL
 // store methods and synthetic canonical anchors. It must exhaust the first
 // bounded pass only after projecting both marks under V1 and V2; no V2
 // accounting snapshot is manually seeded by this fixture.
 const sourceByBlock=new Map([[opening.block,opening],[previous.block,previous],[sample.block,sample]]),
  canonicalClient={getChainId:async()=>4663,getBlock:async({blockNumber})=>{
   const source=sourceByBlock.get(String(blockNumber));assert(source,'Unexpected synthetic source read');
   return {hash:source.hash,timestamp:BigInt(source.timestamp)};
  }},
  firstMaintenance=await maintainCanonicalPaperScenario(store,canonicalClient,indexerPool,campaignId,3);
 assert.equal(firstMaintenance.status,'budget_exhausted');assert.equal(firstMaintenance.steps,3);
 const projected=(await admin.query(`SELECT source_mark_id::text AS mark_id,policy_version
  FROM deployment_paper_accounting WHERE campaign_id=$1 ORDER BY policy_version,source_mark_id`,
  [campaignId])).rows,
  countPolicy=policy=>projected.filter(row=>row.policy_version===policy).map(row=>row.mark_id).sort();
 assert.deepEqual(countPolicy(PAPER_ACCOUNTING_POLICY),[openMark,previousMark]);
 assert.deepEqual(countPolicy(PAPER_CONVERSION_ACCOUNTING_POLICY_V2),[openMark],
  'the first pass must preserve its bounded budget instead of projecting the full backlog');
 const resumedMaintenance=await maintainCanonicalPaperScenario(store,canonicalClient,indexerPool,campaignId,2);
 assert.equal(resumedMaintenance.status,'projection_current');
 assert.equal(resumedMaintenance.steps,1,'resume should project the remaining V2 mark then observe catch-up');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2`,[campaignId,PAPER_ACCOUNTING_POLICY])).rows[0].n,2);
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_paper_accounting
  WHERE campaign_id=$1 AND policy_version=$2`,[campaignId,PAPER_CONVERSION_ACCOUNTING_POLICY_V2])).rows[0].n,2);

 const advanced=advanceEphemeralStaticPaperFeeCarry({previous:priorCarry,
   interval:interval(previous,sample),sampleSource:sample,stream,targetSetHash,opening}),
  replayBody={kind:'paper_close_convert_ephemeral_fee_replay_v1',classification:'fork_estimated',
   previousFeeEvidenceId:previousFee,from:{block:previous.block,hash:previous.hash},
   to:{block:sample.block,hash:sample.hash},stream,targetSetHash,interval:interval(previous,sample),
   intervalHash:advanced.intervalHash,previousFeeCarryHash:previousCarryHash,
   feeCarry:advanced.feeCarry,feeCarryHash:advanced.feeCarryHash},
  ephemeral={...replayBody,replayHash:contentHash(replayBody)};
 report.feeReplay={kind:ephemeral.kind,classification:ephemeral.classification,
  previousFeeEvidenceId:previousFee,from:ephemeral.from,to:ephemeral.to,stream,targetSetHash,
  intervalHash:ephemeral.intervalHash,previousFeeCarryHash:previousCarryHash,
  feeCarryHash:advanced.feeCarryHash,replayHash:ephemeral.replayHash};
 report.feeCarryHash=advanced.feeCarryHash;
 report.gasScopeHash=contentHash({campaignId,revision:1,openMarkId:openMark,
  latestMarkId:previousMark,openModelHash:contentHash(open),profileHash,feeCarryHash:advanced.feeCarryHash,
  feeReplayHash:ephemeral.replayHash,source:sample,routeHash:report.route.routeHash,
  inventory:report.inventory,quoteHash:report.quote.quoteHash,
  initialAllowances:report.gasStages[0].allowancesBefore});
 for(const stage of report.gasStages)stage.scopeHash=report.gasScopeHash;
 report.gasSequenceHash=contentHash(report.gasStages.map(stage=>({stage:stage.stage,
  callHash:stage.callHash,sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
  allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
  balancesAfter:stage.balancesAfter})));
 for(const stage of report.gasStages)stage.sequenceHash=report.gasSequenceHash;
 report.reportHash=contentHash((({reportHash:_r,postWithdraw:_p,sourceReplayHash:_s,...body})=>body)(report));
 report.postWithdraw.reportHash=report.reportHash;
 report.postWithdraw.source=sample;report.postWithdraw.balances={token0:'100',token1:'35'};
 report.postWithdraw.postWithdrawReplayHash=report.postWithdrawReplay.replayHash;
 report.sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',
  reportHash:report.reportHash,source:sample,openModelHash:report.openModelHash,
  feeCarryHash:report.feeCarryHash,postWithdrawReplayHash:report.postWithdrawReplay.replayHash,
  quoteHash:report.quote.quoteHash});
 const imported=await store.registerStaticPaperCloseConvertPrestateGas({report,
  verifyAnchors:async()=>{},verifyFeeReplay:async()=>ephemeral});
 const profiles=await store.staticPaperCloseConvertPrestateGasProfiles({chainId:4663,
  poolAddress:profile.pool.pool,sizeBand:imported.sizeBand,reportHash:report.reportHash});
 const frame={source:sample,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:1_000_000n,
  price0:100000000000000n,price1:100n,nativePrice:1000000000000000000n,
  referenceEligible:true,referenceReasons:[],referenceProofHash:proofHash,referenceProof:proof};
 const postWithdraw={verificationClass:'owned_fork_close_convert_post_withdraw_v2',
  reportHash:report.reportHash,source:sample,postWithdrawReplayHash:report.postWithdrawReplay.replayHash,
  withdrawCallHash:report.postWithdrawReplay.withdrawCallHash,
  quoterCallHash:report.postWithdrawReplay.quoterCallHash,
  poolState:report.postWithdrawReplay.poolState,balances:{token0:'100',token1:'35'},
  quotedOutputRaw:'90',position:{liquidity:'0',tokensOwed0:'0',tokensOwed1:'0'}};
 const client={getChainId:async()=>4663,getBlock:async()=>({hash:sample.hash,timestamp:BigInt(sample.timestamp)}),
  simulateContract:async()=>({result:[90n]})};
 const terminalPreview=await persistTrustedStaticPaperCloseConvertPreview({store,state:{openModel:open,
  openMarkId:openMark,previous:{markId:previousMark,sourceBlock:previous.block,sourceHash:previous.hash,
   source:previous},profile,profileHash,configHash:open.configHash,parameters:config},frame,
  previousFeeCarry:priorCarry,feeReplay:ephemeral,feeEvidence:{id:previousFee,
   proofHash:previousFeeProofHash,carryHash:previousCarryHash},postWithdraw,client,
  verifyPersistedContext:async()=>{},verifyAnchors:async()=>{},
  verifyOwnedFork:async()=>({reportHash:report.reportHash,
   postWithdrawReplayHash:report.postWithdrawReplay.replayHash,sourceReplayHash:report.sourceReplayHash,
   source:sample,gasScopeHash:report.gasScopeHash,gasSequenceHash:report.gasSequenceHash,
   gasStages:report.gasStages.map(stage=>({stage:stage.stage,source:stage.source,
    sourceHash:stage.sourceHash,callHash:stage.callHash,gasUnitsExpected:stage.gasUnitsExpected,
    gasUnitsBound:stage.gasUnitsBound}))}),prestateCostProfiles:profiles,prestateReport:report,
  gasPriceWei:1_000_000_000n,now});
 assert.equal(terminalPreview.actionAvailable,false);
 assert.equal(terminalPreview.operationAcceptanceAvailable,false);
 const savedPreview=(await admin.query(`SELECT proposal FROM deployment_previews WHERE id=$1`,
   [terminalPreview.id])).rows[0].proposal,
  model=savedPreview.paperCloseConvertTerminalV3,
  verifyTerminal=async terminal=>({status:'verified',modelHash:terminal.modelHash,
   feeReplayHash:terminal.feeReplay.replayHash,intervalHash:terminal.feeReplay.intervalHash,
   gasReportHash:terminal.gasReport.reportHash,quoteHash:terminal.quote.quoteHash,
   source:terminal.source,actionAvailable:false,bookingAvailable:false}),
  verifyAnchors=async(chainId,sources)=>{
   assert.equal(chainId,4663);assert.deepEqual(sources.map(source=>source.block),
    [opening.block,previous.block,sample.block]);
  },
 request={previewId:terminalPreview.id,contentDigest:terminalPreview.contentDigest,
   expectedRevision:1,idempotencyKey:'fixture-static-close-convert-v3-key-0001'},
 badDigestRequest={...request,contentDigest:'f'.repeat(64),
  idempotencyKey:'fixture-static-close-convert-v3-tampered-0001'};
 await assert.rejects(store.acceptStaticPaperCloseConvertV3Operation(campaignId,badDigestRequest,
  'fixture_operator',verifyTerminal,verifyAnchors),error=>
  error?.code==='stale_preview');
 assert.equal((await admin.query(`SELECT count(*)::int AS n FROM deployment_operations
  WHERE campaign_id=$1`,[campaignId])).rows[0].n,0);
 const
  acceptedPair=await Promise.all([
   store.acceptStaticPaperCloseConvertV3Operation(campaignId,request,'fixture_operator',
    verifyTerminal,verifyAnchors),
   store.acceptStaticPaperCloseConvertV3Operation(campaignId,request,'fixture_operator',
    verifyTerminal,verifyAnchors),
  ]);
 assert.equal(acceptedPair.filter(item=>!item.replayed).length,1);
 assert.equal(acceptedPair.filter(item=>item.replayed).length,1);
 assert.equal(acceptedPair[0].id,acceptedPair[1].id);
 const operationId=acceptedPair[0].id,workerId='fixture-worker-v3-0001',claim=
  await store.claimNext(workerId,120,'paper','static_manual_v1');
 assert.equal(claim.id,operationId);assert.equal(claim.status,'preflighting');
 await store.advanceClaim(operationId,workerId,'paper_model_preflight_checked','executing',null);
 await store.advanceClaim(operationId,workerId,'paper_model_reconciling','reconciling',null);
 const verification={status:'verified',modelHash:model.modelHash,
  feeReplayHash:model.feeReplay.replayHash,previousFeeEvidenceId:model.feeReplay.previousFeeEvidenceId,
  intervalHash:model.feeReplay.intervalHash,feeCarryHash:model.feeReplay.feeCarryHash,
  gasReportHash:model.gasReport.reportHash,quoteHash:model.quote.quoteHash,source:model.source,
  actionAvailable:false,bookingAvailable:false};
 let anchorChecks=0;
 const failSecondAnchorCheck=async(chainId,sources)=>{
  anchorChecks++;
  if(anchorChecks===2)throw new assert.AssertionError({message:'synthetic source changed during booking'});
  await verifyAnchors(chainId,sources);
 };
 await assert.rejects(store.completeTrustedStaticPaperCloseConvertV3({operationId,workerId,
  verification,verifyAnchors:failSecondAnchorCheck}),error=>
  error?.code==='paper_close_convert_v3_source_changed_during_completion');
 assert.equal(anchorChecks,2);
 const rolledBack=(await admin.query(`SELECT
  (SELECT count(*)::int FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2) marks,
  (SELECT count(*)::int FROM deployment_ledger WHERE campaign_id=$1 AND operation_id::text=$2) ledger,
  (SELECT count(*)::int FROM deployment_paper_accounting WHERE campaign_id=$1 AND policy_version='paper_fixed_flow_convert_v3') accounting,
  (SELECT lifecycle FROM deployment_campaigns WHERE id=$1) lifecycle,
  (SELECT status FROM deployment_operations WHERE id::text=$2) status`,[campaignId,operationId])).rows[0];
 assert.deepEqual(rolledBack,{marks:0,ledger:0,accounting:0,lifecycle:'closing',status:'reconciling'});
 const completed=await store.completeTrustedStaticPaperCloseConvertV3({operationId,workerId,
  verification,verifyAnchors});
 assert.equal(completed.replayed,false);
 const restartStore=new DeploymentStore(scopedUrl.toString());await restartStore.assertReady();
 const replayed=await restartStore.completeTrustedStaticPaperCloseConvertV3({operationId,workerId,
  verification,verifyAnchors});
 assert.equal(replayed.replayed,true);assert.equal(replayed.markId,completed.markId);
 const counts=(await admin.query(`SELECT
  (SELECT count(*)::int FROM deployment_marks WHERE campaign_id=$1 AND provenance->>'operationId'=$2) marks,
  (SELECT count(*)::int FROM deployment_ledger WHERE campaign_id=$1 AND operation_id::text=$2) ledger,
  (SELECT count(*)::int FROM deployment_paper_accounting WHERE campaign_id=$1 AND policy_version='paper_fixed_flow_convert_v3') accounting`,
  [campaignId,operationId])).rows[0];
 assert.deepEqual(counts,{marks:1,ledger:3,accounting:1});
 const dashboardClient=await restartStore.readPool.connect();
 try{
  const rows=await readDeploymentRows(dashboardClient),row=rows.find(item=>item.id===campaignId);
  assert(row);const position=deploymentPosition(row);
  assert.equal(position.deployment.conversionAccountingStatus,'available');
  assert.equal(position.accounting,'provisional');
  assert.equal(position.deployment.accounting.policyVersion,'paper_fixed_flow_convert_v3');
  assert.equal(position.deployment.unavailable.includes(
   'prospective_prestate_gas_is_fork_estimated_not_paid'),true);
  assert.equal(position.deployment.accounting.capitalOut.length,3);
  const savedV3=(await dashboardClient.query(`SELECT snapshot FROM deployment_paper_accounting
   WHERE campaign_id=$1 AND source_mark_id=$2 AND policy_version='paper_fixed_flow_convert_v3'`,
   [campaignId,completed.markId])).rows[0].snapshot;
  assert.equal(savedV3.conversion.gasEvidence.kind,'candidate_prestate_gas_only');
  assert.equal(savedV3.conversion.gasEvidence.pathVersion,'paper_static_manual_close_convert_prestate_v1');
  assert.equal(savedV3.conversion.gasEvidence.paidGasAvailable,false);
  assert.equal(position.inventory.tokens[0].amountRaw,savedV3.inventory.token0Raw);
  assert.equal(position.inventory.tokens[1].amountRaw,savedV3.inventory.token1Raw);
  const detail=await readDeploymentDetail(dashboardClient,row,24),terminal=detail.performance.timeline
   .find(point=>point.block===sample.block);
  assert(terminal);assert.equal(terminal.action,'exit');
  assert(terminal.tokenBalances.some(token=>token.amountRaw!==null));
  assert.notEqual(terminal.gasThisMarkQuote,null);
  assert.equal(terminal.swapThisMarkQuote!==null,true);
  const canonical={hash:sample.hash,timestamp:sample.timestamp};
  const auditClient={getChainId:async()=>4663,getBlock:async()=>canonical};
  assert.deepEqual(await auditCanonicalPaperConversionAccountingV3(restartStore,auditClient,campaignId),
   {checked:1,invalidated:[],alreadyInvalidated:false,detectedAccountingId:null});
  canonical.hash='0x'+'9'.repeat(64);
  const revoked=await auditCanonicalPaperConversionAccountingV3(restartStore,auditClient,campaignId);
  assert.equal(revoked.checked,1);assert.equal(revoked.invalidated.length,1);
  assert(revoked.detectedAccountingId);
  const revokedPosition=deploymentPosition((await readDeploymentRows(dashboardClient))
   .find(item=>item.id===campaignId));
  assert.equal(revokedPosition.accounting,'invalid');
  assert.equal(revokedPosition.navQuote,null);
  assert.equal(revokedPosition.deployment.conversionAccountingStatus,'unavailable');
  canonical.hash=sample.hash;
  const stillRevoked=await auditCanonicalPaperConversionAccountingV3(restartStore,auditClient,campaignId);
  assert.equal(stillRevoked.checked,0);assert.equal(stillRevoked.alreadyInvalidated,true);
  const recoveredPosition=deploymentPosition((await readDeploymentRows(dashboardClient))
   .find(item=>item.id===campaignId));
  assert.equal(recoveredPosition.accounting,'invalid');
  assert.equal(recoveredPosition.navQuote,null);
 }finally{dashboardClient.release();}
 await restartStore.close();
 if(process.argv.includes('--restore-rehearsal')){
  const restore=await rehearseStaticPaperSchemaRestore({testDatabaseUrl:process.env.TEST_DATABASE_URL,
   sourceSchema:schema});
  assert.equal(restore.evidenceClass,'synthetic_injected_verifier_database_mechanics');
  process.stdout.write(`${JSON.stringify({restoreRehearsal:restore})}\n`);
 }
 const finalProjectionRows=(await admin.query(`SELECT source_mark_id::text AS mark_id,policy_version
  FROM deployment_paper_accounting WHERE campaign_id=$1 ORDER BY policy_version,source_mark_id`,
  [campaignId])).rows,
  finalV2MarkIds=finalProjectionRows.filter(row=>row.policy_version===PAPER_CONVERSION_ACCOUNTING_POLICY_V2)
   .map(row=>row.mark_id).sort();
 console.log(JSON.stringify({status:'passed',maintenance:{firstStatus:firstMaintenance.status,
  firstSteps:firstMaintenance.steps,resumeStatus:resumedMaintenance.status,
  resumeSteps:resumedMaintenance.steps,firstPassV1MarkIds:countPolicy(PAPER_ACCOUNTING_POLICY),
  firstPassV2MarkIds:countPolicy(PAPER_CONVERSION_ACCOUNTING_POLICY_V2),
  resumedV2MarkIds:finalV2MarkIds},
  v3Admission:'accepted',operationId,source:'synthetic canonical anchors and isolated PostgreSQL'}));
}finally{
 if(indexerPool)await indexerPool.end();
 if(store)await store.close();
 await admin.query('SET search_path=public');await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 admin.release();await pool.end();
}
