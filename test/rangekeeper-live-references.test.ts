import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {MarketProfile} from '../src/deployments/market-profile.js';
import type {PaperOpenFrame} from '../src/deployments/paper-preview.js';
import {buildRangeKeeperLiveStageReferences,rangeKeeperLiveStageReferencesMatch} from '../src/deployments/rangekeeper-live-references.js';

const profile={pool:{chainId:4663,token0:'0x0000000000000000000000000000000000000001',token1:'0x0000000000000000000000000000000000000002'},
 referencePolicy:{}} as unknown as MarketProfile;
const frame=(proof:Record<string,unknown>= {feed:{address:'0xfeed',baseAsset:'ABC',quoteAsset:'USD'},oracle:{answer:'100',updatedAt:'9',fetchedAt:'now'},registry:{revision:1}}):PaperOpenFrame=>({
 source:{block:'100',hash:`0x${'a'.repeat(64)}`,timestamp:10},tick:0,sqrtPriceX96:1n,poolLiquidity:1n,
 price0:100n,price1:200n,nativePrice:300n,referenceEligible:true,referenceReasons:[],referenceProofHash:'f'.repeat(64),referenceProof:proof});

describe('RangeKeeper live independent references',()=>{
 it('pins the semantic profile/source/reference proof and permits only fetch-time metadata changes',()=>{
  const original=buildRangeKeeperLiveStageReferences({campaignId:'campaign-a',revision:1,profile,frame:frame()});
  const transportOnly=frame({feed:{address:'0xfeed',baseAsset:'ABC',quoteAsset:'USD'},
   oracle:{answer:'100',updatedAt:'9',fetchedAt:'later'},registry:{revision:1}});
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-a',revision:1,profile,expected:original,frame:transportOnly}),true);
  const changedPrice=frame({feed:{address:'0xfeed',baseAsset:'ABC',quoteAsset:'USD'},oracle:{answer:'101',updatedAt:'9',fetchedAt:'later'},registry:{revision:1}});
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-a',revision:1,profile,expected:original,frame:changedPrice}),false);
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-b',revision:1,profile,expected:original,frame:frame()}),false);
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-a',revision:2,profile,expected:original,frame:frame()}),false);
  const tamperedEvidence={...original,evidence:{...original.evidence,prices:{...original.evidence.prices,price0:'999'}}};
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-a',revision:1,profile,expected:tamperedEvidence,frame:frame()}),false);
  const tamperedProof={...original,evidence:{...original.evidence,referenceProof:{oracle:{answer:'999'}}}};
  assert.equal(rangeKeeperLiveStageReferencesMatch({campaignId:'campaign-a',revision:1,profile,expected:tamperedProof,frame:frame()}),false);
 });
 it('fails closed when independent prices or reference evidence are unavailable',()=>{
  assert.throws(()=>buildRangeKeeperLiveStageReferences({campaignId:'c',revision:1,profile,frame:{...frame(),price1:null}}),/independent_reference_unavailable/);
  assert.throws(()=>buildRangeKeeperLiveStageReferences({campaignId:'c',revision:1,profile,frame:{...frame(),referenceEligible:false}}),/independent_reference_unavailable/);
 });
});
