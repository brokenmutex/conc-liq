import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import type {RobinhoodClient} from '../src/client.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {verifyRangeKeeperPaperGasReport} from
 '../src/deployments/rangekeeper-paper-gas-evidence.js';
import {prepareRangeKeeperPaperOpenRuntime} from
 '../src/deployments/rangekeeper-paper-open-runtime.js';
import {RangeKeeperPaperPinnedQuoteCache} from
 '../src/deployments/rangekeeper-paper-pinned-quote-cache.js';
import {RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES,RANGEKEEPER_PAPER_ZERO_ALLOWANCES}
 from '../src/deployments/rangekeeper-paper-cost.js';
import type {RangeKeeperPaperDraft} from '../src/deployments/rangekeeper-paper-open-model.js';

const address=(n:string)=>`0x${n.repeat(40)}`;
const hash=(n:string)=>`0x${n.repeat(64)}`;

function fixture(){
 const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:address('1'),pool:address('2'),
  token0:address('3'),token1:address('4'),quoteToken:1,decimals0:18,decimals1:18,fee:3000,
  tickSpacing:60,positionManager:address('5'),router:address('6'),quoter:address('7'),
  poolCodeHash:hash('a'),token0CodeHash:hash('b'),token1CodeHash:hash('c'),managerCodeHash:hash('d'),
  quoterCodeHash:hash('e'),reference0:'A/USD',reference1:'B/USD',nativeReference:'ETH/USD',numeraire:'USD'},
  referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',
   corporateAction:'reject_pending'},token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',
   corporateAction:'reject_pending'},nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
 const parameters={fullWidthSpacings:2,limits:{maxDeploymentValue:'100000000000000000000',
  minDeploymentValue:'1',minDeploymentPpm:1,maxSwapInputValue:'10000000000000000000',
  maxSwapInputPpm:1000000,maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
  maxActionCost:'10000000000000000000',maxRollingCost:'10000000000000000000',
  maxCampaignCost:'10000000000000000000',maxExposurePpm:1000000,maxLossValue:'10000000000000000000',
  maxDrawdownPpm:1000000,maxRecenters:2,maxLiquiditySharePpm:100000,
  maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
  id=randomUUID(),profileHash=contentHash(profile),configHash=contentHash({...parameters,
   strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),
  draft:RangeKeeperPaperDraft={id,revision:1,allocation:{token0Raw:'1000000000000000000',
   token1Raw:'1000000000000000000',nativeWei:'10000000000000000'},profile,profileHash,configHash,
   strategyId:'rangekeeper_v1',parameters},
  timestamp=Math.floor(Date.now()/1000),proof={fixture:'open-runtime-source'},
  source={block:'100',hash:hash('1'),timestamp},frame:PaperOpenFrame={source,tick:0,
   sqrtPriceX96:sqrtRatioAtTick(0),poolLiquidity:10n**24n,price0:10n**18n,price1:10n**18n,
   nativePrice:10n**18n,referenceEligible:true,referenceReasons:[],
   referenceProofHash:contentHash(proof),referenceProof:proof};
 return {draft,frame,buildId:'f'.repeat(64),runtime:{buildId:'f'.repeat(64),
  configHash:'a'.repeat(64),nodeVersion:'v24.0.0'}};
}

function stageSamples(request:Parameters<NonNullable<Parameters<typeof prepareRangeKeeperPaperOpenRuntime>[0]['sampleOwnedFork']>>[0]){
 return request.stages.map(action=>({action,to:address('5'),calldata:'0x1234',returnData:'0x',
  localHash:hash('2'),localGasUsed:'90000',localEffectiveGasPriceWei:'1000000000',
  sourceBlock:request.frame.source.block,sourceHash:request.frame.source.hash,
  estimate:{gas:'100000',parentGas:'90000',baseFeeWei:'1000000000',parentBaseFeeWei:'1000000000',
   totalFeeWei:'100000000000000',parentFeeWei:'90000000000000',executionFeeWei:'10000000000000',
   basis:'node_estimateGas_with_paper_prestate_and_parent_component' as const},
  stateOverrideHash:createHash('sha256').update('{}').digest('hex'),stateOverrides:{}}));
}

test('samples the discovered candidate on the supplied pinned frame, replays it, and refreshes gas after sampling',async()=>{
 const f=fixture(),oldIdentity=process.env.CONC_LIQ_RUNTIME_IDENTITY;
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(f.runtime);
 let gasReads=0,readCalls=0,registered=0,profileRows:unknown[]=[],cacheContextChecks=0;
 const client={getGasPrice:async()=>++gasReads===1?1_000_000_000n:2_000_000_000n} as unknown as RobinhoodClient,
  pinnedQuoteCache=new RangeKeeperPaperPinnedQuoteCache(client,f.draft.profile),
  store={paperDraft:async()=>f.draft,
   rangeKeeperPaperGasProfiles:async()=>{readCalls++;return profileRows;},
   registerRangeKeeperPaperGasEvidence:async(input:any)=>{
    // This fake persistence boundary exercises the runtime after a trusted
    // store would have verified the source attestation. The fabricated stage
    // rows stay inside this test and grant no actionability.
    registered++;
    const report=verifyRangeKeeperPaperGasReport(input.report);
    assert.equal(report.frame.source.block,f.frame.source.block);
    const replay=await input.replayPersistedContext({report,frame:f.frame});
    assert.match(replay.replayHash,/^[a-f0-9]{64}$/);
    profileRows=report.stageProfiles.map(stage=>({id:randomUUID(),version:1,
     poolAddress:report.scope.poolAddress,pathVersion:report.pathVersion,stage:stage.stage,
     allowanceState:stage.allowanceState,sizeBand:report.sizeBand,component:'gas_units',
     status:'provisional',evidenceClass:'fork_estimated',model:stage.model,
     sourceHash:stage.sourceHash,observedUntil:new Date(report.sampledAt)}));
    return {created:true};
   }} as any;
 try{
  const originalMatches=pinnedQuoteCache.matches.bind(pinnedQuoteCache);
  pinnedQuoteCache.matches=(candidateClient,candidateProfile)=>{
   cacheContextChecks++;
   return originalMatches(candidateClient,candidateProfile);
  };
  const model=await prepareRangeKeeperPaperOpenRuntime({store,client,campaignId:f.draft.id,
   frame:f.frame,pinnedQuoteCache,readGasProfiles:async query=>store.rangeKeeperPaperGasProfiles(query),
   sampleOwnedFork:async request=>stageSamples(request)});
  assert.equal(registered,1);
  assert(readCalls>=2,'Expected a fresh candidate-scope profile query after persistence');
  assert.equal(model.status,'indicative');
  assert.equal(model.source.block,f.frame.source.block);
  assert.equal(model.costs?.marketGasPriceWei,'2000000000',
   'The final model must use gas freshly observed after owned-fork sampling');
  assert.equal(model.actionAvailable,false);
  assert(cacheContextChecks>=4,'The supplied source/profile-bound quote cache must be reused for initial, replay, and refreshed model builds');
 }finally{
  if(oldIdentity===undefined)delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
  else process.env.CONC_LIQ_RUNTIME_IDENTITY=oldIdentity;
 }
});

test('failed gas-profile registration cannot return or persist a preview',async()=>{
 const f=fixture(),oldIdentity=process.env.CONC_LIQ_RUNTIME_IDENTITY;
 process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify(f.runtime);
 let registered=0,sampledSource='';
 const client={getGasPrice:async()=>1_000_000_000n} as unknown as RobinhoodClient,
  store={paperDraft:async()=>f.draft,rangeKeeperPaperGasProfiles:async()=>[],
   registerRangeKeeperPaperGasEvidence:async(input:any)=>{
    registered++;
    const report=verifyRangeKeeperPaperGasReport(input.report);
    await input.replayPersistedContext({report,frame:f.frame});
    throw Error('store_rejected_source_replay');
   }} as any;
 try{
  await assert.rejects(prepareRangeKeeperPaperOpenRuntime({store,client,campaignId:f.draft.id,
   frame:f.frame,readGasProfiles:async()=>[],sampleOwnedFork:async request=>{
    sampledSource=request.frame.source.hash;return stageSamples(request);
   }}),/store_rejected_source_replay/);
  assert.equal(sampledSource,f.frame.source.hash,'Fork sampling must stay pinned to the supplied frame');
  assert.equal(registered,1);
 }finally{
  if(oldIdentity===undefined)delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
  else process.env.CONC_LIQ_RUNTIME_IDENTITY=oldIdentity;
 }
});
