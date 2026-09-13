import assert from 'node:assert/strict';import {test} from 'node:test';import {toHex} from 'viem';
import {fundLocalFixtureToken} from '../src/paper/fixture-funding.js';import {NVDA_PAPER_MARKET} from '../src/paper/market.js';import type {PaperExecutionContext} from '../src/paper/execution.js';import {USDG} from '../src/constants.js';
function fixture(ambiguous=false,multiplier=1n){let balance=0n,traces=0;const writes:any[]=[],shared=toHex(1n,{size:32}),ours=toHex(98765n,{size:32}),other=toHex(87654n,{size:32});
 const context={fixtureFunding:[],policy:{market:NVDA_PAPER_MARKET},market:NVDA_PAPER_MARKET,
  local:{readContract:async()=>balance*multiplier},fork:{rpc:async(method:string,params:any[])=>{
   if(method==='debug_traceCall'){const donor=traces++%2===0;return {[USDG]:{storage:{[shared]:toHex(7n,{size:32}),[donor?ours:other]:toHex(donor?balance:900n,{size:32}),...(ambiguous&&donor?{[toHex(76543n,{size:32})]:toHex(0n,{size:32})}:{})}}};}
   assert.equal(method,'anvil_setStorageAt');writes.push(params);assert.equal(params[0],USDG);assert.equal(params[1],ours);balance=BigInt(params[2]);return true;
  }}} as unknown as PaperExecutionContext;return {context,writes};
}
test('local funding identifies only the donor balance word and funds the requested amount',async()=>{
 const f=fixture();await fundLocalFixtureToken(f.context,USDG,5000000000n);assert.equal(f.writes.length,1);assert.equal(BigInt(f.writes[0][2]),5000000000n);
 await fundLocalFixtureToken(f.context,USDG,4000000000n);assert.equal(f.writes.length,1,'An adequate balance needs no storage mutation');
});
test('local funding rejects ambiguous account storage and unsupported scaling',async()=>{
 const ambiguous=fixture(true);await assert.rejects(fundLocalFixtureToken(ambiguous.context,USDG,5000000000n),/ambiguous/);assert.equal(ambiguous.writes.length,0);
 await assert.rejects(fundLocalFixtureToken(fixture(false,2n).context,USDG,5000000000n),/unsupported multiplier/);
 const legacy=fixture();Object.assign(legacy.context,{policy:{}});await assert.rejects(fundLocalFixtureToken(legacy.context,USDG,1n),/explicit paper market/);
});
