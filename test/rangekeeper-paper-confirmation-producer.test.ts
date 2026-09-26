import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {describe,it} from 'node:test';
import {marketProfileSchema,referenceProofHash} from '../src/deployments/market-profile.js';
import {contentHash} from '../src/deployments/contracts.js';
import {createRangeKeeperPaperConfirmationProducer} from
 '../src/deployments/rangekeeper-paper-confirmation-producer.js';
import {buildRangeKeeperPaperOwnedForkConfirmationEvidence} from
 '../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {isRangeKeeperPaperServerProduced} from
 '../src/deployments/rangekeeper-paper-confirmation-provenance.js';
import {RangeKeeperPaperPinnedQuoteCache} from
 '../src/deployments/rangekeeper-paper-pinned-quote-cache.js';
import {RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES}
 from '../src/deployments/rangekeeper-paper-cost.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';

const address=(n:string)=>`0x${n.repeat(40)}`;
const hash=(n:string)=>`0x${n.repeat(64)}`;

describe('trusted RangeKeeper paper confirmation producer',()=>{
 it('refuses a confirmed-shaped result when the owned-fork callback never ran',async()=>{
  const campaignId=randomUUID(),draft={id:campaignId,revision:1,strategyId:'rangekeeper_v1',
   profile:{},profileHash:'a'.repeat(64),configHash:'b'.repeat(64),allocation:{token0Raw:'1',token1Raw:'1',nativeWei:'1'}},
   result={status:'confirmed',campaignId,revision:1,actionAvailable:false},source={block:'1',hash:hash('1'),timestamp:1};
  const priorIdentity=process.env.CONC_LIQ_RUNTIME_IDENTITY;
  process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:'f'.repeat(64),
   configHash:'a'.repeat(64),nodeVersion:process.version});
  let recorded=false,preparedOnly=false;
  try{
   const client={getGasPrice:async()=>1n} as never,
    store={paperDraft:async()=>draft,
     readRangeKeeperPaperConfirmationEnvelope:async(input:any)=>{preparedOnly=input.prepareOnly===true;return result;},
     recordRangeKeeperPaperConfirmationProducerReceipt:async(input:any)=>{
      recorded=true;assert.equal(input.envelope,result);
      assert.equal(isRangeKeeperPaperServerProduced(input.envelope),true);
      return {replayed:false,actionAvailable:false};
     }} as never,
    producer=createRangeKeeperPaperConfirmationProducer({store,client,rpcUrl:'http://fixture.invalid',
     beforeRead:async()=>{},readCanonicalFrame:async()=>({source,tick:0,sqrtPriceX96:1n,
      poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,
      referenceReasons:[],referenceProofHash:'c'.repeat(64),referenceProof:{}})});
   assert.deepEqual(await producer(campaignId),{status:'unavailable',
    reason:'rangekeeper_confirmation_owned_fork_proof_unavailable',campaignId,revision:1,
    actionAvailable:false});
   assert.equal(recorded,false);
   assert.equal(preparedOnly,true,'Producer did not request prepare-only store replay');
   assert.equal(isRangeKeeperPaperServerProduced(result),false);
  }finally{
   if(priorIdentity===undefined)delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
   else process.env.CONC_LIQ_RUNTIME_IDENTITY=priorIdentity;
  }
 });

 it('does not treat an injected runner as production-owned fork proof',async()=>{
  const campaignId=randomUUID(),draft={id:campaignId,revision:1,strategyId:'rangekeeper_v1',
   profile:{},profileHash:'a'.repeat(64),configHash:'b'.repeat(64),allocation:{token0Raw:'1',token1Raw:'1',nativeWei:'1'}},
   result={status:'confirmed',campaignId,revision:1,actionAvailable:false},source={block:'1',hash:hash('1'),timestamp:1};
  const priorIdentity=process.env.CONC_LIQ_RUNTIME_IDENTITY;
  process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:'f'.repeat(64),
   configHash:'a'.repeat(64),nodeVersion:process.version});
  let recorded=false,preparedOnly=false;
  try{
   const client={getGasPrice:async()=>1n} as never,
    store={paperDraft:async()=>draft,
     readRangeKeeperPaperConfirmationEnvelope:async(input:any)=>{preparedOnly=input.prepareOnly===true;return result;},
     recordRangeKeeperPaperConfirmationProducerReceipt:async()=>{recorded=true;}} as never,
    producer=createRangeKeeperPaperConfirmationProducer({store,client,rpcUrl:'http://fixture.invalid',
     beforeRead:async()=>{},readCanonicalFrame:async()=>({source,tick:0,sqrtPriceX96:1n,
      poolLiquidity:1n,price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,
      referenceReasons:[],referenceProofHash:'c'.repeat(64),referenceProof:{}}),
     runOwnedFork:async()=>({status:'success',sourceBlock:'1',sourceHash:hash('1'),
      candidateHash:'d'.repeat(64),simulationHash:hash('2'),ownedForkEvidence:{fixture:true}} as never)});
   assert.deepEqual(await producer(campaignId),{status:'unavailable',
    reason:'rangekeeper_confirmation_owned_fork_proof_unavailable',campaignId,revision:1,
    actionAvailable:false});
   assert.equal(recorded,false);
   assert.equal(preparedOnly,true,'Untrusted runner path attempted a durable confirmation write');
  }finally{
   if(priorIdentity===undefined)delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
   else process.env.CONC_LIQ_RUNTIME_IDENTITY=priorIdentity;
  }
 });

 it('loads campaign context and supplies only internally built owned-fork evidence',async()=>{
  const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:address('1'),pool:address('2'),
   token0:address('3'),token1:address('4'),quoteToken:1,decimals0:18,decimals1:18,fee:3000,
   tickSpacing:60,positionManager:address('5'),router:address('6'),quoter:address('7'),
   poolCodeHash:hash('a'),token0CodeHash:hash('b'),token1CodeHash:hash('c'),managerCodeHash:hash('d'),
   quoterCodeHash:hash('e'),reference0:'A/USD',reference1:'B/USD',nativeReference:'ETH/USD',numeraire:'USD'},
   referencePolicy:{token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',
    corporateAction:'reject_pending'},token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',
    corporateAction:'reject_pending'},nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
  const parameters={fullWidthSpacings:2,limits:{maxDeploymentValue:'100000000000000000000',
   minDeploymentValue:'1',minDeploymentPpm:1,maxSwapInputValue:'10000000000000000000',
   maxSwapInputPpm:1_000_000,maxSwapShortfallValue:'1000000000000000000',maxSlippageBps:50,
   maxActionCost:'10000000000000000000',maxRollingCost:'10000000000000000000',
   maxCampaignCost:'10000000000000000000',maxExposurePpm:1_000_000,
   maxLossValue:'10000000000000000000',maxDrawdownPpm:1_000_000,maxRecenters:2,
   maxLiquiditySharePpm:100_000,maxObservationGapSeconds:90,exitReserveWei:'1000000000000000'}},
   campaignId=randomUUID(),profileHash=contentHash(profile),configHash=contentHash({...parameters,
    strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1}),draft={id:campaignId,
    revision:7,allocation:{token0Raw:'11',token1Raw:'22',nativeWei:'33'},profile,profileHash,configHash,
    strategyId:'rangekeeper_v1' as const,parameters};
  const source={block:'400',hash:hash('6'),timestamp:1_800_000_000},proof={fixture:'canonical-reference'},
   frame:PaperOpenFrame={source,tick:0,sqrtPriceX96:1n<<96n,poolLiquidity:100n,
    price0:1n,price1:1n,nativePrice:1n,referenceEligible:true,referenceReasons:[],
    referenceProofHash:referenceProofHash(proof),referenceProof:proof},
   candidate:RangeKeeperCandidate={kind:'entry',range:{tickLower:-10,tickUpper:10},swap:null,
    amount0Desired:10n,amount1Desired:10n,amount0Min:9n,amount1Min:9n,liquidity:10n,
    deployedValue:20n,sourceBlock:400n,sourceHash:source.hash as `0x${string}`,expiresAt:1_800_000_060};
  const priorIdentity=process.env.CONC_LIQ_RUNTIME_IDENTITY;
  process.env.CONC_LIQ_RUNTIME_IDENTITY=JSON.stringify({buildId:'f'.repeat(64),
   configHash:'a'.repeat(64),nodeVersion:'v24.20.0'});
  let capturedProbe:unknown=null,capturedEvidence:unknown=null,capturedCache:unknown=null,
   frameRead=false,draftRead=false;
  try{
   const client={getGasPrice:async()=>1n,getChainId:async()=>4663,
    getBlock:async()=>({hash:source.hash,timestamp:BigInt(source.timestamp)})} as never,
    store={paperDraft:async(id:string)=>{draftRead=true;assert.equal(id,campaignId);return draft;},
     readRangeKeeperPaperConfirmationEnvelope:async(input:any)=>{
     assert.equal(input.frame,frame);assert.equal(input.marketGasPriceWei,1n);
      capturedCache=input.pinnedQuoteCache;
      await input.verifyAnchors(4663,[source]);
      const simulation=await input.simulate(candidate);capturedEvidence=simulation.ownedForkEvidence;
      return {status:'unavailable',campaignId,reason:'fixture_non_actionable',actionAvailable:false};
     }} as never;
   const producer=createRangeKeeperPaperConfirmationProducer({store,client,rpcUrl:'http://fixture.invalid',
    beforeRead:async()=>{},readCanonicalFrame:async(_client,receivedProfile)=>{
     frameRead=true;assert.equal(contentHash(receivedProfile),profileHash);return frame;},
     runOwnedFork:async request=>{
     capturedProbe=request.probe;
     const stages=[...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
     const evidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe:request.probe,frame,
      configHash,samples:stages.map((action,index)=>({action,to:address('8'),calldata:'0x1234',
       returnData:'0x',localHash:hash(String(index+1)),localGasUsed:'21000',
       localEffectiveGasPriceWei:'1',sourceBlock:source.block,sourceHash:source.hash,
       estimate:{gas:'25000',parentGas:'21000',baseFeeWei:'1',parentBaseFeeWei:'1',
        totalFeeWei:'1',parentFeeWei:'1',executionFeeWei:'0',
        basis:'node_estimateGas_with_paper_prestate_and_parent_component'},
       stateOverrideHash:'9'.repeat(64),stateOverrides:{}}))});
     return {status:'success',sourceBlock:source.block,sourceHash:source.hash,
      candidateHash:request.probe.candidateHash,simulationHash:evidence.sequenceHash,
      ownedForkEvidence:evidence};
    },pinnedQuoteCache:new RangeKeeperPaperPinnedQuoteCache(client,profile)});
   const result=await producer(campaignId);
   assert.equal(result.status,'unavailable');assert(draftRead&&frameRead);
   assert(capturedProbe&&capturedEvidence);
   const built=capturedProbe as {campaignId:string;revision:number;candidate:RangeKeeperCandidate;
    scope:{profileHash:string;candidateHash:string}};
   assert.equal(built.campaignId,campaignId);assert.equal(built.revision,draft.revision);
   assert.equal(built.scope.profileHash,profileHash);assert.equal(built.candidate.sourceBlock,400n);
   assert(capturedCache instanceof RangeKeeperPaperPinnedQuoteCache,
    'Producer did not forward its request-local pinned quote cache');
   assert.equal((capturedEvidence as {evidenceClass:string}).evidenceClass,
    'caller_claimed_owned_anvil_fork');
  }finally{
   if(priorIdentity===undefined)delete process.env.CONC_LIQ_RUNTIME_IDENTITY;
   else process.env.CONC_LIQ_RUNTIME_IDENTITY=priorIdentity;
  }
 });
});
