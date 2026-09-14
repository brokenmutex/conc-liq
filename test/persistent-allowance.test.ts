import assert from 'node:assert/strict';
import {test} from 'node:test';
import {replayPersistentAllowances} from '../src/research/persistent-allowance.js';
import type {AllowanceAction} from '../src/research/live-execution-cost.js';

const action=(nonce:number,before:string,after:string,amount?:string):AllowanceAction=>({id:String(nonce),nonce,reverted:false,before:{pair:before},after:{pair:after},gasQuote:'2',spends:amount===undefined?[{key:'pair',amount:String(BigInt(before)-BigInt(after))}]:[],...(amount===undefined?{}:{approval:{key:'pair',amount,managedAvailable:'100',swapRouter:true}})});
const policy={caps:{pair:'1000'},maximumDoesNotDecrease:[],preserveCashExitCleanup:true};
test('persistent finite budget covers repeated funding, but actual spends consume it',()=>{
  const actions=[action(0,'0','100','100'),action(1,'100','0'),action(2,'0','100','100'),action(3,'100','0')];
  const r=replayPersistentAllowances(actions,policy);assert.equal(r.grants,1);assert.equal(r.endingAllowances.pair,'800');
  assert.equal(r.cumulativeSpend.pair,'200');assert.equal(r.netGasSavingQuote,null);
  assert.equal(replayPersistentAllowances(actions,{...policy,caps:{pair:'100'}}).grants,2);
});
test('cash exits require extra revocation when the original allowance was exhausted',()=>{
  const actions=[action(0,'0','100','100'),{...action(1,'100','0'),clearAtBoundary:true},action(2,'0','100','100')];
  const r=replayPersistentAllowances(actions,policy);assert.equal(r.extraRevocations.length,1);assert.equal(r.grants,2);assert.equal(r.totalApprovalTransactions,3);
  const continuous=replayPersistentAllowances(actions,{...policy,preserveCashExitCleanup:false});assert.equal(continuous.grants,1);assert.equal(continuous.extraRevocations.length,0);
});
test('maximum sentinel behavior is explicit and token specific',()=>{
  const maximum=String((1n<<256n)-1n), actions=[action(0,'0','100','100'),action(1,'100','0')];
  const p={...policy,caps:{pair:maximum}};
  assert.equal(replayPersistentAllowances(actions,p).endingAllowances.pair,String(BigInt(maximum)-100n));
  assert.equal(replayPersistentAllowances(actions,{...p,maximumDoesNotDecrease:['pair']}).endingAllowances.pair,maximum);
});
test('reverted spending preserves allowance and malformed original receipts fail',()=>{
  const actions=[action(0,'0','100','100'),{...action(1,'100','100'),reverted:true}];
  assert.equal(replayPersistentAllowances(actions,policy).endingAllowances.pair,'1000');
  assert.throws(()=>replayPersistentAllowances([actions[0]!,action(1,'99','0')],policy),/continuity/);
  assert.throws(()=>replayPersistentAllowances(actions,{...policy,caps:{pair:'99'}}),/cannot fund/);
  assert.throws(()=>replayPersistentAllowances(actions,{...policy,caps:{other:'1000'}}),/exactly/);
});
test('missing omitted gas stays unavailable and revocations are included',()=>{
  const r=replayPersistentAllowances([action(0,'0','100','100'),{...action(1,'100','100','100'),gasQuote:null},action(2,'100','0','0')],policy);
  assert.equal(r.omittedRecordedGasQuote,null);assert.equal(r.retainedRevocations,1);assert.equal(r.endingAllowances.pair,'0');
});
