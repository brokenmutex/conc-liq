import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe,it} from 'node:test';
import {configSchema} from '../src/adaptive-paper.js';

const load=(name:string)=>configSchema.parse(JSON.parse(readFileSync(`config/${name}.json`,'utf8')));
const V3_TICK_SPACING:Record<number,number>={500:10,3000:60};

describe('shipped adaptive paper configurations',()=>{
 it('accepts the deployed three-book config unchanged',()=>{
  const c=load('adaptive-paper-60m');
  assert.equal(c.assets.length,3);
  assert.equal(c.forecast.lookbackMs,3600000);
  assert.equal(c.residualRange,undefined,'the deployed policy must not gain the residual rule by accident');
  assert.equal(c.feePpm,undefined);
  for(const a of c.assets)assert.equal(a.budgetQuote,undefined);
 });
 it('accepts the proposed restart config, with its per-asset overrides',()=>{
  const c=load('adaptive-paper-restart-2026-09-18');
  assert.equal(c.residualRange,true);
  assert.equal(c.feePpm,1000000);
  assert.equal(c.forecast.lookbackMs,21600000);
  assert.equal(c.forecast.feeHalfLifeMs,900000);
  assert.equal(c.assets.length,5);
  assert.equal(c.assets.filter(a=>a.holdout).length,1,'exactly one holdout book');
  // Every band ladder must fit its own pool's grid, on both tiers.
  for(const a of c.assets){
   assert.equal(V3_TICK_SPACING[a.market.fee],a.market.tickSpacing,a.market.symbol);
   for(const w of a.halfWidthsTicks??c.halfWidthsTicks)
    assert.equal(w%a.market.tickSpacing,0,`${a.market.symbol} half-width ${w}`);
   for(const w of a.residualWidthsTicks??c.residualWidthsTicks??[])
    assert.equal(w%a.market.tickSpacing,0,`${a.market.symbol} residual span ${w}`);
  }
  assert.equal(c.assets.filter(a=>a.market.fee===3000).length,2);
 });
 it('rejects a forecast window that cannot cover its own minimum span',()=>{
  const c=JSON.parse(readFileSync('config/adaptive-paper-60m.json','utf8'));
  c.forecast.lookbackMs=600000;
  assert.throws(()=>configSchema.parse(c),/minimum span/);
 });
 it('rejects a fee tier paired with the wrong tick spacing',()=>{
  const c=JSON.parse(readFileSync('config/adaptive-paper-60m.json','utf8'));
  c.assets[0].market.tickSpacing=60;
  assert.throws(()=>configSchema.parse(c),/Tick spacing/);
 });
});
