import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {buildRangeKeeperPaperMaintenanceKernel} from
 '../src/deployments/rangekeeper-paper-maintenance.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft,
 type RangeKeeperPaperOpenModel} from '../src/deployments/rangekeeper-paper-open-model.js';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';

const address=(n:string)=>`0x${n.repeat(40)}`;
const hash=(n:string)=>`0x${n.repeat(64)}`;

function setup(){
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
   strategyId:'rangekeeper_v1',parameters},buildId='f'.repeat(64),
  policy=resolveRangeKeeperPaperPolicy(draft,buildId).policy!;
 const openSource={block:'100',hash:hash('1'),timestamp:1_000},
  candidate={kind:'entry',range:{tickLower:-60,tickUpper:60},swap:null,
   amount0Desired:'1000000000000000000',amount1Desired:'1000000000000000000',
   amount0Min:'1',amount1Min:'1',liquidity:'1000000000000000000',deployedValue:'2000000000000000000',
   sourceBlock:'100',sourceHash:openSource.hash,expiresAt:1_090},
  model={kind:'rangekeeper_paper_open_model',status:'indicative',campaignId:id,revision:1,
   strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',draftConfigHash:configHash,
   kernelPolicyHash:policy.policyHash,kernelBuildId:buildId,profileHash,
   source:openSource,poolState:{tick:0,sqrtPriceX96:String(sqrtRatioAtTick(0)),poolLiquidity:'1000000000000000'},
   reference:{price0:'1000000000000000000',price1:'1000000000000000000',nativePrice:'1000000000000000000'},
   candidate,candidateHash:'a'.repeat(64),allocation:{strategyInventoryValue:'2000000000000000000'}} as
   unknown as RangeKeeperPaperOpenModel,
  inventory={position:{tickLower:-60,tickUpper:60,liquidity:candidate.liquidity},
   idle:{token0:'0',token1:'0'}},
  openState={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
   configHash:`0x${policy.policyHash}`,buildId,lastEligible:{block:'101',hash:hash('2'),timestamp:1_030},
   confirmation:null,exit:null},
  snapshot={draft,lifecycle:'active',runtimeIdentity:{buildId,configHash:'a'.repeat(64),nodeVersion:'v24'},
   openMark:{id:'1',source:openSource,model,inventory,kernelState:openState},
   previousMark:{id:'1',source:openSource,inventory,kernelSnapshot:null}} as any;
 return {snapshot,model,inventory};
}

function frame(block:number,timestamp:number,tick:number):PaperOpenFrame{return {source:{block:String(block),
 hash:hash(String(block%10)),timestamp},tick,sqrtPriceX96:sqrtRatioAtTick(tick),poolLiquidity:10n**18n,
 price0:10n**18n,price1:10n**18n,nativePrice:10n**18n,referenceEligible:true,
 referenceReasons:[],referenceProofHash:'a'.repeat(64),referenceProof:{fixture:true}};}

test('persists outside-range timer without creating a recenter or executable state',()=>{
 const {snapshot}=setup(),first=buildRangeKeeperPaperMaintenanceKernel({snapshot,frame:frame(110,1_040,120)});
 assert.equal(first.decision.action,'wait');
 assert.equal(first.decision.reason,'outside_range_observed');
 assert.equal(first.actionAvailable,false);
 assert.equal(first.kernelSnapshot.recenters,0);
 assert.equal(first.kernelSnapshot.entryAllowed,false);
 assert.equal(first.kernelSnapshot.executionReady,false);
 assert.equal(first.kernelSnapshot.state.exit?.since,1_040);
 let prior=first.kernelSnapshot,priorFrame=frame(110,1_040,120),second=first;
 for(const [block,timestamp] of [[111,1_100],[112,1_160],[113,1_220],[114,1_280],[115,1_340]] as const){
  const next={...snapshot,previousMark:{...snapshot.previousMark,id:String(block-109),
   source:priorFrame.source,kernelSnapshot:prior}},current=frame(block,timestamp,120);
  second=buildRangeKeeperPaperMaintenanceKernel({snapshot:next,frame:current});
  prior=second.kernelSnapshot;priorFrame=current;
 }
 assert.equal(second.decision.reason,'outside_range_persistence_elapsed');
 assert.equal(second.kernelSnapshot.recenters,0);
 assert.equal(second.kernelSnapshot.state.exit?.since,1_040);
});

test('resets outside-range persistence after a source gap beyond the policy bound',()=>{
 const {snapshot}=setup(),first=buildRangeKeeperPaperMaintenanceKernel({snapshot,frame:frame(110,1_040,120)}),
  next={...snapshot,previousMark:{...snapshot.previousMark,id:'2',source:frame(110,1_040,120).source,
   kernelSnapshot:first.kernelSnapshot}},second=buildRangeKeeperPaperMaintenanceKernel({snapshot:next,
   frame:frame(111,1_131,120)});
 assert.equal(second.kernelSnapshot.state.exit?.since,1_131);
 assert.equal(second.decision.reason,'outside_range_observed');
});
