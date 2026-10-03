import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {it} from 'node:test';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import type {RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import {buildRangeKeeperLiveStageEvidence,consumeRangeKeeperLiveStageProof,
 type RangeKeeperLiveStageProofRequest} from '../src/deployments/rangekeeper-live-stage-proof.js';

function fixture(){
 const config=parseRangeKeeperConfig({...JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')),signer:null});
 const source={block:100n,hash:`0x${'a'.repeat(64)}` as const,timestamp:1000};
 const beforePool:RangeKeeperSnapshot={source,operator:config.operator!,wallet0:1000n,wallet1:2000n,
  nativeWei:2n*10n**18n,nonce:3,nftCount:0n,tick:0,sqrtPriceX96:1n<<96n,poolLiquidity:1000n,
  unlocked:true,position:null,allowances:[]};
 const r:RangeKeeperLiveStageProofRequest={campaignId:'campaign-a',allocationId:'allocation-a',revision:1,
  stage:'open-approve-1',buildId:'b'.repeat(64),profileHash:'c'.repeat(64),allocationHash:'d'.repeat(64),
  referenceProofHash:'e'.repeat(64),config,source,beforePool,
  plan:{kind:'approve',token:0,spender:'positionManager',amount:100n},
  allocation:{campaignId:'campaign-a',liquidByTokenAddress:{[config.pool.token0.toLowerCase()]:100n,
   [config.pool.token1.toLowerCase()]:200n},nativeSpendWei:10n**18n,exitReserveWei:10n**17n,nftTokenIds:[]},
  prices:{price0:10n**18n,price1:10n**18n,nativePrice:10n**18n}};
 const measurement={gasUsed:30_000n,estimatedGas:25_000n,baseFeePerGasWei:2n,marketGasPriceWei:3n,
  forkReceiptHash:`0x${'f'.repeat(64)}`,now:1_001_000};
 return {r,measurement};
}

it('owned-stage evidence binds exact campaign/source/plan and pads measured gas and current fees',()=>{
 const {r,measurement}=fixture(),e=buildRangeKeeperLiveStageEvidence(r,measurement);
 assert.equal(e.gasUnitsBound,'39000');assert.equal(e.maxFeePerGasWei,'4');
 assert.equal(e.stageGasWei,'156000');assert.equal(e.costValue,'156000');
 assert.equal(e.campaignId,'campaign-a');assert.equal(e.nonce,3);
 assert.equal(e.expiresAt,1_090_000);assert.match(e.evidenceHash,/^[0-9a-f]{64}$/);
 const changed=buildRangeKeeperLiveStageEvidence({...r,stage:'another-stage'},measurement);
 assert.notEqual(changed.requestHash,e.requestHash);
});

it('a public evidence report cannot recreate owned-fork authorization',()=>{
 const {r,measurement}=fixture(),e=buildRangeKeeperLiveStageEvidence(r,measurement);
 assert.throws(()=>consumeRangeKeeperLiveStageProof({kind:'rangekeeper_verified_live_stage_proof',evidence:e},r,
  {now:()=>measurement.now}),/absent or already consumed/);
});

it('stage proofs cannot invade sibling tokens, the exit reserve or the reviewed cost budget',()=>{
 const {r,measurement}=fixture();
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,plan:{kind:'approve',token:0,
  spender:'positionManager',amount:101n}},measurement),/Approval exceeds/);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,allocation:{...r.allocation,nativeSpendWei:155999n}},measurement),/exit gas/);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,config:{...r.config,
  limits:{...r.config.limits,maxActionCost:1n}}},measurement),/action budget/);
});

it('retained close may spend exit reserve only through explicitly bound withdraw or allowance cleanup stages',()=>{
 const {r,measurement}=fixture(),allocation={...r.allocation,nativeSpendWei:100_000n,exitReserveWei:100_000n};
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,allocation},measurement),/exit gas/);
 const retained=buildRangeKeeperLiveStageEvidence({...r,allocation,exitSpendAllowed:true,
  plan:{kind:'approve',token:0,spender:'positionManager',amount:0n}},measurement);
 assert.equal(retained.exitSpendAllowed,true);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,allocation,exitSpendAllowed:true},measurement),
  /withdraw\/allowance-cleanup/);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,allocation,exitSpendAllowed:true,
  plan:{kind:'swap',token:0,amountIn:1n,minOut:1n,deadline:1200n}},measurement),/withdraw\/allowance-cleanup/);
});

it('stale observations and mismatched pre-stage sources never produce an admissible report',()=>{
 const {r,measurement}=fixture();
 assert.throws(()=>buildRangeKeeperLiveStageEvidence(r,{...measurement,now:1_090_000}),/stale/);
 assert.throws(()=>buildRangeKeeperLiveStageEvidence({...r,source:{...r.source,block:101n}},measurement),/source differs/);
});
