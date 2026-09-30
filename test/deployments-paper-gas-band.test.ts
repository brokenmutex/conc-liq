import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {PAPER_GAS_BAND_DIVISOR,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES,
 costIndicativePaperOpenPreview,paperGasBand,paperGasModelSchema,
 type PaperGasProfileRow} from '../src/deployments/paper-cost.js';

const poolAddress='0x'+'a'.repeat(40);
const now=Date.now();
const range={tickLower:218280,tickUpper:218400};
// The point the band is sampled at: 250 USDG deployed, 3,682 ppm of the pool.
const sampled={range,deployedValue:'250000000000000000000',dilutedSharePpm:'3682'};

function bandRows(candidate:typeof sampled,schemaVersion:1|2=2):PaperGasProfileRow[]{
 const band=schemaVersion===1
  ?{sizeMinValue:candidate.deployedValue,sizeMaxValue:candidate.deployedValue,
    shareMinPpm:candidate.dilutedSharePpm,shareMaxPpm:candidate.dilutedSharePpm}
  :paperGasBand(candidate);
 return PAPER_STATIC_GAS_STAGES.map((stage,index)=>{
  const source={block:'76499708',hash:'0x'+'2'.repeat(64),
   estimatedAt:new Date(now-10_000).toISOString(),
   callHash:'0x'+String(index+1).repeat(64),method:'owned_fork_nitro_exact_call_v1' as const};
  const model={schemaVersion,source,gasUnitsExpected:'100000',gasUnitsBound:'130000',
   ...band,tickLower:range.tickLower,tickUpper:range.tickUpper};
  return {id:`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,version:1,
   poolAddress,pathVersion:PAPER_STATIC_GAS_PATH,stage,allowanceState:'zero',
   sizeBand:'range_test',component:'gas_units',status:'provisional',
   evidenceClass:'fork_estimated',model,sourceHash:contentHash(source),
   observedUntil:new Date(now-10_000)};
 });
}
const cost=(candidate:typeof sampled,rows:PaperGasProfileRow[])=>
 costIndicativePaperOpenPreview({status:'indicative',candidate},rows,poolAddress,
  10n**18n,1_000_000_000n,now);

test('the band envelope is the documented multiple of the sampled point',()=>{
 const band=paperGasBand(sampled);
 assert.equal(band.sizeMinValue,String(BigInt(sampled.deployedValue)/PAPER_GAS_BAND_DIVISOR));
 assert.equal(band.sizeMaxValue,String(BigInt(sampled.deployedValue)*PAPER_GAS_BAND_DIVISOR));
 assert.equal(band.shareMinPpm,'920');
 assert.equal(band.shareMaxPpm,'14728');
 // A share that would exceed a million ppm saturates instead of producing a
 // band the resolver rejects outright.
 assert.equal(paperGasBand({deployedValue:'1',dilutedSharePpm:'400000'}).shareMaxPpm,'1000000');
 assert.equal(paperGasModelSchema.safeParse({...bandRows(sampled)[0]!.model}).success,true);
});

test('one sampled band serves every candidate across the measured envelope',()=>{
 // This is the change's whole purpose: gas was measured flat across 40x
 // capital and 39x share at a fixed tick range, so a single sample must now
 // cost candidates at other sizes instead of forcing a fresh fork sample.
 const rows=bandRows(sampled);
 const quarter={...sampled,deployedValue:'62500000000000000000',dilutedSharePpm:'920'};
 const quadruple={...sampled,deployedValue:'1000000000000000000000',dilutedSharePpm:'14728'};
 for(const candidate of [sampled,quarter,quadruple])
  assert.equal(cost(candidate,rows).costs.status,'provisional',
   `candidate at ${candidate.deployedValue} should reuse the sampled band`);
 // Outside the envelope it must still fail closed rather than extrapolate.
 const tooLarge={...sampled,deployedValue:'1000000000000000000001',dilutedSharePpm:'14728'};
 const tooSmall={...sampled,deployedValue:'62499999999999999999',dilutedSharePpm:'920'};
 for(const candidate of [tooLarge,tooSmall])
  assert.equal(cost(candidate,rows).costs.status,'unavailable',
   `candidate at ${candidate.deployedValue} is outside the measured envelope`);
});

test('the tick range stays pinned exactly, because it carries the gas variance',()=>{
 const rows=bandRows(sampled);
 for(const moved of [{tickLower:218290,tickUpper:218400},{tickLower:218280,tickUpper:218410}])
  assert.equal(cost({...sampled,range:moved},rows).costs.status,'unavailable',
   'a different range must never reuse a band, however close');
});

test('version 1 point evidence still resolves and is not widened by the new band',()=>{
 const rows=bandRows(sampled,1);
 assert.equal(cost(sampled,rows).costs.status,'provisional');
 // A version 1 row is a band of width zero, so a neighbouring size that a
 // version 2 band would cover must not resolve against it.
 assert.equal(cost({...sampled,deployedValue:'62500000000000000000',dilutedSharePpm:'920'},
  rows).costs.status,'unavailable');
});
