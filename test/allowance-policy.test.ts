import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getAddress} from 'viem';
import {allowancePolicySchema,canonicalAllowancePolicy,assertAllowancePairs,assertAllowancePolicyMatches,planAllowance,authorizeAllowance,type AllowancePolicy} from '../src/execution/allowance-policy.js';
const token=getAddress('0x0000000000000000000000000000000000000011'),stock=getAddress('0x0000000000000000000000000000000000000022');
const router=getAddress('0x0000000000000000000000000000000000000033'),manager=getAddress('0x0000000000000000000000000000000000000044');
const policy:AllowancePolicy={kind:'persistent_finite_v1',grants:[{token,spender:router,amountRaw:'5000000000'},{token:stock,spender:manager,amountRaw:'1700000000'}]};
const input={policy,token,spender:router,required:100000000n,available:200000000n,allowance:0n};
test('stock-independent raw budgets reuse and replenish without decimals or balance assumptions',()=>{
 assert.equal(planAllowance(input),5000000000n);
 assert.equal(planAllowance({...input,allowance:5000000000n-input.required}),null);
 assert.equal(planAllowance({...input,allowance:1n}),5000000000n);
 // A different stock, spender and decimal scale use the identical engine.
 assert.equal(planAllowance({policy,token:stock,spender:manager,required:1200000000n,available:1500000000n,allowance:0n}),1700000000n);
 assert.equal(planAllowance({...input,required:0n,available:0n}),null);
});
test('large permission never increases managed trade funding or crosses a configured cap',()=>{
 assert.throws(()=>planAllowance({...input,required:input.available+1n,allowance:5000000000n}),/managed inventory/);
 assert.throws(()=>planAllowance({...input,required:6000000000n,available:6000000000n}),/budget/);
 assert.throws(()=>planAllowance({...input,spender:manager}),/no allowance budget/);
 authorizeAllowance({...input,amount:5000000000n});
 assert.throws(()=>authorizeAllowance({...input,amount:4999999999n}),/finite budget/);
 authorizeAllowance({...input,amount:0n});
});
test('legacy exact authorization still excludes reserve and cleanup remains available',()=>{
 assert.equal(planAllowance({...input,policy:undefined}),input.required);
 assert.throws(()=>authorizeAllowance({...input,policy:undefined,amount:input.available+1n}),/managed inventory/);
 authorizeAllowance({...input,policy:undefined,amount:0n});
});
test('configuration rejects maximum sentinel, malformed raw units, duplicates and extra pairs',()=>{
 for(const amountRaw of ['0','-1','1.5','01','abc',String((1n<<256n)-1n),String(1n<<256n)])
  assert.throws(()=>allowancePolicySchema.parse({kind:'persistent_finite_v1',grants:[{token,spender:router,amountRaw}]}));
 assert.throws(()=>allowancePolicySchema.parse({...policy,grants:[policy.grants[0],policy.grants[0]]}),/Duplicate/);
 assertAllowancePairs(policy,policy.grants);
 assert.throws(()=>assertAllowancePairs(policy,[{token,spender:router}]),/exactly/);
 assert.throws(()=>planAllowance({...input,allowance:-1n}));
});
test('saved policy identity ignores ordering, but never accepts silent budget changes',()=>{
 const reverse={...policy,grants:[...policy.grants].reverse()};
 assert.deepEqual(canonicalAllowancePolicy(policy),canonicalAllowancePolicy(reverse));
 assertAllowancePolicyMatches(policy,reverse);assertAllowancePolicyMatches(undefined,{kind:'exact_v1'});
 assert.throws(()=>assertAllowancePolicyMatches(undefined,policy),/saved campaign/);
 assert.throws(()=>assertAllowancePolicyMatches(policy,{...policy,grants:policy.grants.map(g=>({...g,amountRaw:'20'}))}),/saved campaign/);
});
