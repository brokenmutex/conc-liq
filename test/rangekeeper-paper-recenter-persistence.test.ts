import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {principalAmounts,Q96,sqrtRatioAtTick} from '../src/backtest/principal.js';
import {contentHash} from '../src/deployments/contracts.js';
import {buildRangeKeeperPaperRecenterBooking,validateRangeKeeperPaperRecenterBooking} from
 '../src/deployments/rangekeeper-paper-persistence.js';
import {buildRangeKeeperPaperEpochObservationPayload} from
 '../src/deployments/rangekeeper-paper-persistence.js';
import {rangeKeeperPaperCandidateHash} from '../src/deployments/rangekeeper-paper-cost.js';
import {referenceProofHash} from '../src/deployments/market-profile.js';
import {replayPaperMint} from '../src/v3/position-math.js';

const source=(block:string,timestamp:number)=>({block,hash:`0x${block.padStart(64,'0')}`,timestamp});
const WAD=10n**18n;

function fixture(withSwap=false){
 const frame={source:source('20',120),sqrtPriceX96:Q96},
  oldPosition={tickLower:-60,tickUpper:60,liquidity:'1000000'},
  withdrawn=principalAmounts({liquidity:BigInt(oldPosition.liquidity),tickLower:-60,tickUpper:60,
   sqrtPriceX96:frame.sqrtPriceX96}),
  candidateRange={tickLower:-120,tickUpper:120},postSwapPrice=withSwap?sqrtRatioAtTick(20):frame.sqrtPriceX96,
  afterSwap0=withdrawn.amount0+100n-(withSwap?1n:0n),
  afterSwap1=withdrawn.amount1+200n+(withSwap?1n:0n),
  desired={amount0:afterSwap0,amount1:afterSwap1},
  mint=replayPaperMint(postSwapPrice,candidateRange,desired.amount0,desired.amount1,0n),
  idle0=afterSwap0-mint.amount0,idle1=afterSwap1-mint.amount1,
  canonicalPrincipal=principalAmounts({liquidity:mint.liquidity,...candidateRange,sqrtPriceX96:frame.sqrtPriceX96});
 assert(idle0>=0n&&idle1>=0n);
 const priorCandidate={kind:'entry',range:{tickLower:-60,tickUpper:60},swap:null,
  amount0Desired:String(withdrawn.amount0),amount1Desired:String(withdrawn.amount1),
  amount0Min:String(withdrawn.amount0),amount1Min:String(withdrawn.amount1),liquidity:oldPosition.liquidity,
  deployedValue:'1000000',sourceBlock:'10',sourceHash:source('10',100).hash,expiresAt:190};
 const priorSource=source('10',100),priorKernel={source:priorSource,state:{schemaVersion:1,policyId:'rangekeeper_v1',
   strategyVersion:'1.0.0',configHash:`0x${'b'.repeat(64)}`,buildId:'c'.repeat(64),
   lastEligible:{block:'10',hash:priorSource.hash,timestamp:100},confirmation:null,exit:null},
  wallet0:'100',wallet1:'200',released0:String(withdrawn.amount0),released1:String(withdrawn.amount1),
  nativeWei:'450',campaignStartValue:'10000',highWaterValue:'10000',rollingSpentCost:'100',
  campaignSpentCost:'100',reservedCost:'0',recenters:0,pending:false,entryAllowed:false,
  safeExitRequired:false,executionReady:false};
 const initialModeledOpenCost={schemaVersion:1,kind:'rangekeeper_paper_initial_modeled_open_cost_v1',
  openModelHash:'1'.repeat(64),costHash:'2'.repeat(64),profileIds:[{stage:'open',
   id:'00000000-0000-4000-8000-000000000001',version:1}],expectedValue:'80',boundValue:'100',
  expectedWei:'40',boundWei:'50',classification:'provisional',paidCostsAvailable:false};
 const previousMark={id:'5',markHash:'a'.repeat(64),source:priorSource,epoch:0,
  classification:'rangekeeper_paper_mark_v1' as const,candidate:priorCandidate,
  candidateHash:'9'.repeat(64),inventory:{position:oldPosition,idle:{token0:'100',token1:'200'}},
  kernelSnapshot:priorKernel,provenance:{candidateHash:'9'.repeat(64),initialModeledOpenCost}};
 const candidate={kind:'recenter',range:candidateRange,swap:withSwap?{token:0,amountIn:'1',quotedOut:'1',
  minOut:'1',priceAfter:String(postSwapPrice),feeValue:'0',shortfallValue:'0'}:null,
  amount0Desired:String(desired.amount0),amount1Desired:String(desired.amount1),
  amount0Min:String(mint.amount0),amount1Min:String(mint.amount1),liquidity:String(mint.liquidity),
  deployedValue:'1000000',sourceBlock:frame.source.block,sourceHash:frame.source.hash,expiresAt:210};
 const draft={id:randomUUID(),revision:1,configHash:'e'.repeat(64),profileHash:'f'.repeat(64),
  profile:{pool:{decimals0:18,decimals1:6}}};
 const kernelSnapshot={source:frame.source,state:{schemaVersion:1,policyId:'rangekeeper_v1',
   strategyVersion:'1.0.0',configHash:`0x${'b'.repeat(64)}`,buildId:'c'.repeat(64),
   lastEligible:{block:'20',hash:frame.source.hash,timestamp:120},confirmation:null,exit:null},
  wallet0:String(idle0),wallet1:String(idle1),released0:String(canonicalPrincipal.amount0),
  released1:String(canonicalPrincipal.amount1),
  nativeWei:'400',campaignStartValue:'10000',highWaterValue:'10000',rollingSpentCost:'223',
  campaignSpentCost:'223',reservedCost:'0',recenters:1,pending:false,entryAllowed:false,
  safeExitRequired:false,executionReady:false};
 const proof={fixture:'pinned'},candidateReferenceProofHash=referenceProofHash(proof),candidateHash=rangeKeeperPaperCandidateHash({
  campaignId:draft.id,revision:draft.revision,profileHash:draft.profileHash,configHash:draft.configHash,
  source:frame.source,referenceProofHash:candidateReferenceProofHash,candidate:candidate as never});
 const bookingBody={schemaVersion:1,kind:'rangekeeper_paper_recenter_v1',campaignId:draft.id,
  revision:1,previousEpoch:0,epoch:1,priorMark:{id:previousMark.id,markHash:previousMark.markHash,
   source:previousMark.source},source:frame.source,poolState:{tick:0,sqrtPriceX96:String(Q96),poolLiquidity:'10000000'},
  allowancesCleared:true,
  reference:{price0:String(WAD),price1:String(WAD),nativePrice:String(WAD),
   proofHash:candidateReferenceProofHash,proof},
  retiredPosition:oldPosition,
  candidateReferenceProofHash,candidateHash,
  withdrawal:{amount0:String(withdrawn.amount0),amount1:String(withdrawn.amount1)},
  collected:{amount0:String(withdrawn.amount0),amount1:String(withdrawn.amount1)},
  swap:withSwap?{token:0,amountIn:'1',quotedOut:'1',minOut:'1',amountOut:'1',
   priceAfter:String(postSwapPrice),feeValue:'0',shortfallValue:'0',source:frame.source}:null,
  candidate,simulationHash:'a'.repeat(64),inventory:{position:{tickLower:candidateRange.tickLower,tickUpper:candidateRange.tickUpper,
   liquidity:String(mint.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  kernelSnapshot,modeledCosts:{status:'provisional',expectedValue:'100',boundValue:'123',
   expectedWei:'40',boundWei:'50',requiredReserveWei:'100',marketGasPriceWei:'40',
   gasPriceBoundWei:'50'}};
 const booking={...bookingBody,modelHash:contentHash(bookingBody)};
 return {draft,previousMark,booking,frame};
}

test('recenter booking advances exactly one epoch from latest persisted inventory and preserves no new capital-in',()=>{
 const f=fixture(),result=buildRangeKeeperPaperRecenterBooking({draft:f.draft,
  previousMark:f.previousMark,booking:f.booking,frame:f.frame});
 assert.equal(result.inventory.position.tickLower,-120);
 assert.equal(result.inventory.position.liquidity,f.booking.candidate.liquidity);
 assert.deepEqual(result.inventory.idle,f.booking.inventory.idle);
 assert.equal(result.ledger.fromEpoch,0);assert.equal(result.ledger.toEpoch,1);
 assert.equal(result.ledger.capitalIn,'0');assert.equal(result.ledger.paidCostsAvailable,false);
 assert.equal(result.provenance.modelHash,f.booking.modelHash);
});

test('recenter booking replays mint at the verified post-swap price and resulting swap inventory',()=>{
 const f=fixture(true),result=buildRangeKeeperPaperRecenterBooking({draft:f.draft,
  previousMark:f.previousMark,booking:f.booking,frame:f.frame});
 assert.equal(result.inventory.position.liquidity,f.booking.candidate.liquidity);
 assert.deepEqual(result.inventory.idle,f.booking.inventory.idle);
 const canonicalPrincipal=principalAmounts({liquidity:BigInt(f.booking.candidate.liquidity),
  tickLower:f.booking.candidate.range.tickLower,tickUpper:f.booking.candidate.range.tickUpper,
  sqrtPriceX96:f.frame.sqrtPriceX96});
 assert.equal(result.provenance.kernelSnapshot.released0,String(canonicalPrincipal.amount0));
 assert.equal(result.provenance.mintSqrtPriceX96,f.booking.swap!.priceAfter);
 assert.notEqual(result.provenance.kernelSnapshot.released0,
  replayPaperMint(BigInt(f.booking.swap!.priceAfter),f.booking.candidate.range,
   BigInt(f.booking.candidate.amount0Desired),BigInt(f.booking.candidate.amount1Desired),0n).amount0.toString());
 const forged=structuredClone(f.booking);assert(forged.swap);forged.swap.priceAfter=String(Q96);
 forged.candidateReferenceProofHash='1'.repeat(64);
 const {modelHash:_hash,...body}=forged;forged.modelHash=contentHash(body);
 assert.throws(()=>buildRangeKeeperPaperRecenterBooking({draft:f.draft,previousMark:f.previousMark,
  booking:forged,frame:f.frame}),/candidate_hash_invalid/);
});

test('post-recenter observation preserves the current epoch inventory and campaign baseline',()=>{
 const f=fixture(),booked=buildRangeKeeperPaperRecenterBooking({draft:f.draft,
  previousMark:f.previousMark,booking:f.booking,frame:f.frame}),
  frame={source:source('30',180),sqrtPriceX96:Q96,tick:0,poolLiquidity:10_000_000n},
  principal=principalAmounts({liquidity:BigInt(booked.inventory.position.liquidity),
   tickLower:booked.inventory.position.tickLower,tickUpper:booked.inventory.position.tickUpper,
   sqrtPriceX96:frame.sqrtPriceX96}),
  priorKernel=f.booking.kernelSnapshot,
  kernel={...priorKernel,source:frame.source,state:{...priorKernel.state,
   lastEligible:{block:'30',hash:frame.source.hash,timestamp:180}},
   released0:String(principal.amount0),released1:String(principal.amount1)},
  latest={id:'11',markHash:'9'.repeat(64),source:f.frame.source,epoch:1,
   classification:'rangekeeper_paper_recenter_v1' as const,candidate:f.booking.candidate,
   candidateHash:f.booking.candidateHash,inventory:booked.inventory,kernelSnapshot:kernel,
   provenance:{...booked.provenance,poolState:f.booking.poolState}};
 const observed=buildRangeKeeperPaperEpochObservationPayload({epoch:1,source:frame.source,
  previousMark:latest,frame,kernelSnapshot:kernel});
 assert.equal(observed.provenance.epoch,1);
 assert.equal(observed.provenance.candidateHash,f.booking.candidateHash);
 assert.deepEqual(observed.inventory,booked.inventory);
 assert.equal(kernel.campaignStartValue,priorKernel.campaignStartValue);
});

test('recenter booking rejects changed prior mark, collection mismatch, and forged result inventory',()=>{
 const f=fixture();
 assert.throws(()=>buildRangeKeeperPaperRecenterBooking({draft:f.draft,frame:f.frame,booking:f.booking,
  previousMark:{...f.previousMark,markHash:'d'.repeat(64)}}),/prior_epoch_invalid/);
 const changedCollection=structuredClone(f.booking);changedCollection.collected.amount0=
  String(BigInt(changedCollection.collected.amount0)+1n);
 changedCollection.modelHash=contentHash((({modelHash:_h,...body})=>body)(changedCollection));
 assert.throws(()=>buildRangeKeeperPaperRecenterBooking({draft:f.draft,previousMark:f.previousMark,
  frame:f.frame,booking:changedCollection}),/withdrawal_replay_mismatch/);
 const changedInventory=structuredClone(f.booking);changedInventory.inventory.idle.token1=
  String(BigInt(changedInventory.inventory.idle.token1)+1n);
 changedInventory.modelHash=contentHash((({modelHash:_h,...body})=>body)(changedInventory));
 assert.throws(()=>buildRangeKeeperPaperRecenterBooking({draft:f.draft,previousMark:f.previousMark,
  frame:f.frame,booking:changedInventory}),/result_inventory_mismatch/);
 const changedProof=structuredClone(f.booking);changedProof.reference.proof.fixture='changed';
 changedProof.modelHash=contentHash((({modelHash:_h,...body})=>body)(changedProof));
 assert.throws(()=>buildRangeKeeperPaperRecenterBooking({draft:f.draft,previousMark:f.previousMark,
  frame:f.frame,booking:changedProof}),/reference_proof_invalid/);
});

test('recenter cost booking freezes an exact 25 percent gas price ceiling',()=>{
 const booking=fixture().booking;
 assert.equal(validateRangeKeeperPaperRecenterBooking(booking).modeledCosts?.gasPriceBoundWei,'50');
 const {modelHash:_hash,...body}=booking;
 const altered={...body,modeledCosts:{...body.modeledCosts!,gasPriceBoundWei:'49'}};
 assert.throws(()=>validateRangeKeeperPaperRecenterBooking({...altered,modelHash:contentHash(altered)}),
  /gas_price_bound_invalid/);
});
