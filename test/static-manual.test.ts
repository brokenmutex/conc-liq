import assert from 'node:assert/strict';
import {it} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {alignManualRange,decideStaticManual,type ManualFrame} from '../src/strategy/static-manual/planner.js';

const frame:ManualFrame={continuity:'canonical',tick:0,sqrtPriceX96:sqrtRatioAtTick(0),
 amount0:1000000000000000000n,amount1:1000000000000000000n,
 price0:10n**18n,price1:10n**18n,decimals0:18,decimals1:18,quoteToken:1,
 position:null,pending:false,entryAllowed:true,safetyExitRequired:false,expiryReached:false};
const limits={maxDeploymentValue:2n*10n**18n,minDeploymentValue:1n,maxExposurePpm:1_000_000};

it('manual range preview rounds outwards and shows actual full width',()=>{
 assert.deepEqual(alignManualRange(-19,21,10),{requestedLower:-19,requestedUpper:21,
  tickLower:-20,tickUpper:30,fullWidthTicks:50,rounded:true});
});

it('manual range holds an outside position without proposing a recenter',()=>{
 const decision=decideStaticManual({...frame,tick:100,position:{tokenId:'1',tickLower:-20,tickUpper:20}},
  {tickLower:-20,tickUpper:20},limits);
 assert.equal(decision.action,'wait');assert.equal(decision.reason,'manual_hold_outside');
 assert.equal(decision.rangeState,'outside');
});

it('deliberate one-sided entry reports no active fee earning',()=>{
 const decision=decideStaticManual({...frame,amount1:0n},{tickLower:20,tickUpper:40},limits);
 assert.equal(decision.action,'entry');
 if(decision.action==='entry'){
  assert.equal(decision.candidate.oneSided,true);
  assert.equal(decision.candidate.feeEarningAtEntry,false);
  assert.equal(decision.candidate.amount1Minted,0n);
 }
});

it('missing independent reference and source gap fail closed while safety exit still takes precedence',()=>{
 assert.equal(decideStaticManual({...frame,price0:null},{tickLower:-20,tickUpper:20},limits).reason,'independent_reference_unavailable');
 assert.equal(decideStaticManual({...frame,continuity:'gap'},{tickLower:-20,tickUpper:20},limits).reason,'source_not_canonical');
 assert.equal(decideStaticManual({...frame,continuity:'gap',safetyExitRequired:true},{tickLower:-20,tickUpper:20},limits).action,'safety_exit');
});
