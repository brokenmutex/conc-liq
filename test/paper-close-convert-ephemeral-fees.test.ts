import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {bindEphemeralPaperFeeCoveragePrefix} from
 '../src/deployments/paper-close-convert-ephemeral-fees.js';
import {advanceEphemeralStaticPaperFeeCarry} from
 '../src/deployments/paper-close-convert-ephemeral-fees.js';
import type {PaperFeeCarry,CanonicalPaperFeeInterval} from '../src/deployments/paper-fee-replay.js';

const source={block:'120',hash:`0x${'2'.repeat(64)}`},stream='fixture-stream',
 targetSetHash=`0x${'3'.repeat(64)}`;
const h=(digit:string)=>`0x${digit.repeat(64)}`;
const previous:PaperFeeCarry={kind:'paper_fee_carry_v1',pool:'0x'+'1'.repeat(40),
 token0Address:'0x'+'2'.repeat(40),token1Address:'0x'+'3'.repeat(40),fee:3000,tickSpacing:60,
 range:{tickLower:-60,tickUpper:60},liquidity:'1000',stream:'fee-stream',targetSetHash:h('4'),
 from:{block:'90',hash:h('5')},through:{block:'100',hash:h('6')},
 token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 intervals:1,events:0,segments:0,partialSegments:0,accounting:'modeled_hypothetical_fee_share'};
const adjacent:CanonicalPaperFeeInterval={kind:'paper_observed_flow_fee_interval_v1',
 pool:previous.pool,token0Address:previous.token0Address,token1Address:previous.token1Address,
 fee:previous.fee,tickSpacing:previous.tickSpacing,range:previous.range,liquidity:previous.liquidity,
 from:{block:'100',hash:h('6')},to:{block:'101',hash:h('7')},
 token0:{lowerRawQ128:'340282366920938463463374607431768211456',
  upperRawQ128:'340282366920938463463374607431768211456',lowerAmountRaw:'1',upperAmountRaw:'1'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 events:1,segments:1,partialSegments:0,accounting:'modeled_hypothetical_fee_share',
 coverage:{stream:'fee-stream',targetSetHash:h('4'),completeThroughBlock:'101',
  completeThroughHash:h('7'),chainAnchorRecheckRequired:false}};
const advanceArgs={previous,interval:adjacent,sampleSource:adjacent.to,stream:'fee-stream',
 targetSetHash:h('4'),opening:previous.from};
function indexedInterval(throughBlock='120',throughHash=source.hash){
 return {kind:'paper_observed_flow_fee_interval_v1',pool:`0x${'4'.repeat(40)}`,
  token0Address:`0x${'5'.repeat(40)}`,token1Address:`0x${'6'.repeat(40)}`,
  fee:3000,tickSpacing:60,from:{block:'110',hash:`0x${'1'.repeat(64)}`},to:source,
  range:{tickLower:-60,tickUpper:60},liquidity:'100',
  token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
  events:2,segments:1,partialSegments:0,accounting:'modeled_hypothetical_fee_share',
  coverage:{stream,targetSetHash,completeThroughBlock:throughBlock,
   completeThroughHash:throughHash,chainAnchorRecheckRequired:false}} as CanonicalPaperFeeInterval;
}

test('normalizes advancing replay cursors to one exact requested-prefix witness',()=>{
 const atEnd=bindEphemeralPaperFeeCoveragePrefix({interval:indexedInterval(),sampleSource:source,
   stream,targetSetHash}),later=bindEphemeralPaperFeeCoveragePrefix({
   interval:indexedInterval('140',`0x${'7'.repeat(64)}`),sampleSource:source,stream,targetSetHash});
 assert.deepEqual(atEnd.coverage,{stream,targetSetHash,completeThroughBlock:source.block,
  completeThroughHash:source.hash,chainAnchorRecheckRequired:false});
 assert.deepEqual(later.coverage,atEnd.coverage);
 assert.equal(contentHash(later),contentHash(atEnd));
});

test('rejects incomplete, target-set-mismatched, or noncanonical endpoint coverage',()=>{
 assert.throws(()=>bindEphemeralPaperFeeCoveragePrefix({interval:indexedInterval('119',source.hash),
  sampleSource:source,stream,targetSetHash}),/coverage_incomplete/);
 const wrongTarget=indexedInterval();wrongTarget.coverage.targetSetHash=`0x${'8'.repeat(64)}`;
 assert.throws(()=>bindEphemeralPaperFeeCoveragePrefix({interval:wrongTarget,
  sampleSource:source,stream,targetSetHash}),/target_set_changed/);
 assert.throws(()=>bindEphemeralPaperFeeCoveragePrefix({interval:indexedInterval('120',
  `0x${'9'.repeat(64)}`),sampleSource:source,stream,targetSetHash}),/coverage_hash_mismatch/);
});

test('endpoint event mutation remains visible in the normalized proof digest',()=>{
 const baseline=bindEphemeralPaperFeeCoveragePrefix({interval:indexedInterval('130',
  `0x${'7'.repeat(64)}`),sampleSource:source,stream,targetSetHash}),
  changed=bindEphemeralPaperFeeCoveragePrefix({interval:{...indexedInterval('131',
   `0x${'8'.repeat(64)}`),events:3},sampleSource:source,stream,targetSetHash});
 assert.notEqual(contentHash(changed),contentHash(baseline));
});

test('ephemeral fee carry advances adjacent complete interval only in memory',()=>{
 const result=advanceEphemeralStaticPaperFeeCarry(advanceArgs);
 assert.equal(result.feeCarry.through.block,'101');
 assert.equal(result.feeCarry.token0.lowerAmountRaw,'1');
 assert.equal(result.feeCarry.intervals,2);
});

test('ephemeral fee carry rejects gaps, incomplete coverage, wrong stream, and stale anchors',()=>{
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...advanceArgs,previous:{...previous,
  through:{block:'99',hash:h('8')}}}),/not_adjacent|anchor_mismatch/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...advanceArgs,interval:{...adjacent,
  coverage:{...adjacent.coverage,completeThroughBlock:'100'}}}),/coverage/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...advanceArgs,interval:{...adjacent,
  coverage:{...adjacent.coverage,stream:'other'}}}),/stream_changed/);
 assert.throws(()=>advanceEphemeralStaticPaperFeeCarry({...advanceArgs,interval:{...adjacent,
  coverage:{...adjacent.coverage,chainAnchorRecheckRequired:true}} as unknown as CanonicalPaperFeeInterval}),
 /anchors_unverified/);
});
