import assert from 'node:assert/strict';
import {test} from 'node:test';
import {advanceEphemeralStaticPaperFeeCarry} from '../src/deployments/paper-close-convert-ephemeral-fees.js';
import type {PaperFeeCarry,CanonicalPaperFeeInterval} from '../src/deployments/paper-fee-replay.js';

const h=(digit:string)=>`0x${digit.repeat(64)}`;
const previous:PaperFeeCarry={kind:'paper_fee_carry_v1',pool:'0x'+'1'.repeat(40),
 token0Address:'0x'+'2'.repeat(40),token1Address:'0x'+'3'.repeat(40),fee:3000,tickSpacing:60,
 range:{tickLower:-60,tickUpper:60},
 liquidity:'1000',stream:'fee-stream',targetSetHash:h('4'),
 from:{block:'90',hash:h('5')},through:{block:'100',hash:h('6')},
 token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 intervals:1,events:0,segments:0,partialSegments:0,accounting:'modeled_hypothetical_fee_share'};
const interval:CanonicalPaperFeeInterval={kind:'paper_observed_flow_fee_interval_v1',
 pool:previous.pool,token0Address:previous.token0Address,token1Address:previous.token1Address,
 fee:previous.fee,tickSpacing:previous.tickSpacing,range:previous.range,liquidity:previous.liquidity,
 from:{block:'100',hash:h('6')},to:{block:'101',hash:h('7')},
 token0:{lowerRawQ128:'340282366920938463463374607431768211456',
  upperRawQ128:'340282366920938463463374607431768211456',lowerAmountRaw:'1',upperAmountRaw:'1'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 events:1,segments:1,partialSegments:0,accounting:'modeled_hypothetical_fee_share',
 coverage:{stream:'fee-stream',targetSetHash:h('4'),completeThroughBlock:'101',
  completeThroughHash:h('7'),chainAnchorRecheckRequired:false}};
const args={previous,interval,sampleSource:interval.to,stream:'fee-stream',targetSetHash:h('4'),
 opening:previous.from};

test('ephemeral fee replay advances adjacent complete interval only in memory',()=>{
 const result=advanceEphemeralStaticPaperFeeCarry(args);
 assert.equal(result.feeCarry.through.block,'101');
 assert.equal(result.feeCarry.token0.lowerAmountRaw,'1');
 assert.equal(result.feeCarry.intervals,2);
});

test('ephemeral fee replay rejects gaps, incomplete coverage, wrong stream, and stale anchors',()=>{
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...args,previous:{...previous,
  through:{block:'99',hash:h('8')}}}),/not_adjacent|anchor_mismatch/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...args,interval:{...interval,
  coverage:{...interval.coverage,completeThroughBlock:'100'}} as CanonicalPaperFeeInterval}),/coverage/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...args,interval:{...interval,
  coverage:{...interval.coverage,stream:'other'}} as CanonicalPaperFeeInterval}),/stream_changed/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...args,interval:{...interval,
  coverage:{...interval.coverage,chainAnchorRecheckRequired:true}} as unknown as CanonicalPaperFeeInterval}),/anchors_unverified/);
});
