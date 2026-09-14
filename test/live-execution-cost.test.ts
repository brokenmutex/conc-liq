import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedSwapApproval,replayBoundedApprovals,compareCostedRoutes,type AllowanceAction,type CostedRoute} from '../src/research/live-execution-cost.js';

test('approval budget excludes unavailable/reserved inventory and reuses adequate allowance',()=>{
  assert.equal(boundedSwapApproval(40n,90n,0n),90n);
  assert.equal(boundedSwapApproval(41n,90n,90n),null);
  assert.throws(()=>boundedSwapApproval(91n,90n,0n));
  assert.throws(()=>boundedSwapApproval(0n,90n,0n));
  assert.throws(()=>boundedSwapApproval(1n,90n,-1n));
});

function fixture():AllowanceAction[]{return [
  {id:'a',nonce:7,reverted:false,before:{r:'0'},after:{r:'40'},spends:[],approval:{key:'r',amount:'40',managedAvailable:'90',swapRouter:true},gasQuote:'10'},
  {id:'b',nonce:8,reverted:false,before:{r:'40'},after:{r:'41'},spends:[],approval:{key:'r',amount:'41',managedAvailable:'90',swapRouter:true},gasQuote:'5'},
  {id:'trade',nonce:9,reverted:false,before:{r:'41'},after:{r:'0'},spends:[{key:'r',amount:'41'}],gasQuote:'30'},
  {id:'revoke',nonce:10,reverted:false,before:{r:'0'},after:{r:'0'},spends:[],approval:{key:'r',amount:'0',managedAvailable:'49',swapRouter:true},gasQuote:'3'},
];}
test('rising swap requirement omits approval while preserving trade funding and exit revocation',()=>{
  const r=replayBoundedApprovals(fixture());
  assert.equal(r.omittedApprovals,1);assert.equal(r.omittedRecordedGasQuote,'5');
  assert.equal(r.rows[0]!.replacement,'90');assert.equal(r.rows[2]!.replacement,'0');
  assert.deepEqual(r.endingAllowances,{r:'0'});assert.equal(r.executionEligible,false);
});
test('receipt continuity, missing nonce, insufficient budget and missing gas fail closed',()=>{
  let a=fixture();a[1]!.before.r='39';assert.throws(()=>replayBoundedApprovals(a));
  a=fixture();a[1]!.nonce=9;assert.throws(()=>replayBoundedApprovals(a));
  a=fixture();a[0]!.approval!.managedAvailable='39';assert.throws(()=>replayBoundedApprovals(a));
  a=fixture();a[1]!.gasQuote=null;assert.equal(replayBoundedApprovals(a).omittedRecordedGasQuote,null);
});
test('reverted approval does not change allowance or count as a saving',()=>{
  const a=fixture();a[1]!.reverted=true;a[1]!.after.r='40';a[2]!.before.r='40';a[2]!.spends[0]!.amount='40';
  assert.equal(replayBoundedApprovals(a).omittedApprovals,0);
});
test('new allowance leftovers must be revoked at each recorded closed boundary',()=>{
  const a=fixture().slice(0,3);a[2]!.clearAtBoundary=true;
  const result=replayBoundedApprovals(a);
  assert.deepEqual(result.endingAllowances,{r:'0'});
  assert.deepEqual(result.additionalRevocations,[{afterId:'trade',key:'r',amount:'49',gasQuote:null}]);
});
const base:CostedRoute={id:'base',sourceBlock:'100',sourceHash:'0xAB',referencePriceX18:String(200n*10n**18n),amount0:'50000000',amount1:String(10n**18n),gasQuote:'50000',complete:true};
test('higher output loses when incremental gas is larger; idle inventory is included',()=>{
  const candidate={...base,id:'other',amount0:'50010000',gasQuote:'70000'};
  assert.deepEqual(compareCostedRoutes(base,candidate),{grossDeltaQuote:'10000',gasDeltaQuote:'20000',netDeltaQuote:'-10000',preferred:false,executionEligible:false});
  assert.equal(compareCostedRoutes(base,{...candidate,gasQuote:'55000'}).netDeltaQuote,'5000');
});
test('unavailable gas or incomplete mint cannot create an eligible preferred route',()=>{
  assert.equal(compareCostedRoutes(base,{...base,gasQuote:null}).netDeltaQuote,null);
  assert.equal(compareCostedRoutes(base,{...base,complete:false}).preferred,false);
  assert.throws(()=>compareCostedRoutes(base,{...base,sourceBlock:'101'}));
  assert.throws(()=>compareCostedRoutes(base,{...base,sourceHash:'0xCD'}));
  assert.throws(()=>compareCostedRoutes(base,{...base,referencePriceX18:'1'}));
});
