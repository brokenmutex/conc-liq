import assert from 'node:assert/strict';
import test from 'node:test';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {allowancePolicyFromUses,buildWalletAllowanceScope,readRangeKeeperWalletAllowanceUses,retainedAllowancePairs,
 type RangeKeeperWalletAllowanceUse} from '../src/deployments/live-wallet-allowance-scope.js';
import {RANGEKEEPER_ALLOWANCE_POLICY,allowanceCeiling,allowancePairKey,assertAllowancesWithinCaps,assertWalletAllowancesInPolicy,
 rangeKeeperAllowanceExposure,walletAllowanceCaps,walletAllowanceViolation} from '../src/strategy/rangekeeper/allowance-policy.js';

const addr=(n:number)=>`0x${BigInt(n).toString(16).padStart(40,'0')}`;
const hash=`0x${'a'.repeat(64)}` as const;
const [usdg,aapl,nvda,router,manager]=[addr(0x10),addr(0x20),addr(0x30),addr(0x50),addr(0x60)];
const pool=(risk:string,poolAddress:number)=>marketProfileSchema.parse({pool:{chainId:4663,factory:addr(0x70),pool:addr(poolAddress),
 token0:usdg,token1:risk,quoteToken:0,decimals0:6,decimals1:18,fee:500,tickSpacing:10,positionManager:manager,router,quoter:addr(0x80),
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:'USDG/USD',reference1:'RISK/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:300,maxPoolDeviationPpm:50_000}});
const aaplProfile=pool(aapl,0x41),nvdaProfile=pool(nvda,0x42);
// USDG token0 sorts before both stocks in this fixture.
const use=(campaignId:string,profile:typeof aaplProfile,lifecycle:string,initial:[bigint,bigint],deployable:bigint):RangeKeeperWalletAllowanceUse=>
 ({campaignId,lifecycle,pool:profile.pool,exposure:rangeKeeperAllowanceExposure({initial,maxDeploymentValue:deployable,decimals:[6,18],prices:[10n**18n,10n**18n]})});
const A=use('A',aaplProfile,'active',[1000n,0n],250n*10n**18n),B=use('B',nvdaProfile,'active',[100n,0n],100n*10n**18n),
 closed=use('C',aaplProfile,'closed',[4000n,0n],1000n*10n**18n);
const pair=(token:string,spender:string)=>allowancePairKey(token,spender);

test('scope allows only pairs an active campaign uses and bounds them by the largest exposure of any wallet campaign',()=>{
 const scope=buildWalletAllowanceScope([A,B,closed],[aaplProfile,nvdaProfile]);
 assert(scope.used.has(pair(usdg,router))&&scope.used.has(pair(aapl,manager))&&scope.used.has(pair(nvda,router)));
 assert.equal(scope.ceiling.get(usdg),allowanceCeiling(closed.exposure[0]),'a closed campaign still bounds what its left-over allowance may be');
 assert(closed.exposure[0]>A.exposure[0]);
 const nonzero=(token:string,spender:string,amount:bigint)=>({token,spender,amount});
 assert.equal(walletAllowanceViolation(nonzero(usdg,router,0n),scope),null,'zero is always in policy');
 assert.equal(walletAllowanceViolation(nonzero(usdg,manager,allowanceCeiling(closed.exposure[0])),scope),null,'exactly the cap is in policy');
 assert.equal(walletAllowanceViolation(nonzero(usdg,manager,allowanceCeiling(closed.exposure[0])+1n),scope),'above_cap');
 assert.equal(walletAllowanceViolation(nonzero(usdg,addr(0x99),1n),scope),'unregistered_spender');
 assert.equal(walletAllowanceViolation(nonzero(addr(0x98),router,1n),scope),'unregistered_token');
 assert.throws(()=>assertWalletAllowancesInPolicy([nonzero(aapl,manager,1n),nonzero(usdg,addr(0x99),1n)],scope),/unregistered_spender/);
});
test('an allowance remaining after the last user closed is out of policy, a sibling-used pair is not',()=>{
 // A is closing: its own stock pairs must be zero, the USDG pairs are still B's.
 const closing=buildWalletAllowanceScope([A,B],[aaplProfile,nvdaProfile],'A');
 assert.equal(walletAllowanceViolation({token:aapl,spender:manager,amount:1n},closing),'unused_pair');
 assert.equal(walletAllowanceViolation({token:usdg,spender:manager,amount:5n},closing),null);
 assert.equal(walletAllowanceViolation({token:nvda,spender:manager,amount:5n},closing),null);
 // The last user closing leaves nothing allowed.
 const last=buildWalletAllowanceScope([B],[nvdaProfile],'B');
 assert.equal(last.used.size,0);
 assert.equal(walletAllowanceViolation({token:usdg,spender:router,amount:1n},last),'unused_pair');
 assert.deepEqual(walletAllowanceCaps(last),[]);
 assert.throws(()=>assertAllowancesWithinCaps([{token:usdg,spender:router,amount:'1'}],walletAllowanceCaps(last)),/no active campaign uses/);
 assert.doesNotThrow(()=>assertAllowancesWithinCaps([{token:usdg,spender:router,amount:'0'}],walletAllowanceCaps(last)));
});
test('queue-side cap proof accepts in-cap pairs and rejects above-cap or malformed amounts',()=>{
 const caps=walletAllowanceCaps(buildWalletAllowanceScope([A],[aaplProfile]));
 assert.equal(caps.length,4);assert(caps.every(c=>c.cap===String(allowanceCeiling(A.exposure[c.token===usdg?0:1]))));
 const usdgCap=caps.find(c=>c.token===usdg)!.cap;
 assert.doesNotThrow(()=>assertAllowancesWithinCaps([{token:usdg,spender:router,amount:usdgCap}],caps));
 assert.throws(()=>assertAllowancesWithinCaps([{token:usdg,spender:router,amount:String(BigInt(usdgCap)+1n)}],caps),/exceeds the persistent_capped_v1 cap/);
 assert.throws(()=>assertAllowancesWithinCaps([{token:usdg,spender:router,amount:'-1'}],caps),/malformed/);
});
test('retained pairs and the campaign policy come from the same wallet read',()=>{
 const retainedByB=retainedAllowancePairs([A,B,closed],'B');
 assert(retainedByB.has(pair(usdg,router))&&retainedByB.has(pair(aapl,manager)),'A and not the closed campaign keeps its pairs');
 assert(!retainedByB.has(pair(nvda,router)),'a closing campaign never retains its own exclusive pairs');
 const policy=allowancePolicyFromUses([A,B],'A');
 assert.equal(policy.kind,RANGEKEEPER_ALLOWANCE_POLICY);assert.deepEqual(policy.exposure,A.exposure);
 assert(policy.retain!.has(pair(nvda,router))&&!policy.retain!.has(pair(aapl,router)));
 assert.throws(()=>allowancePolicyFromUses([A],'missing'),/missing from the wallet allowance scope/);
});
test('the wallet read derives exposure from the initial allocation, the frozen deployment cap and frozen prices',async()=>{
 const rows=[{id:'A',lifecycle:'active',profile:aaplProfile,initial0:'1000',initial1:'0',allocated:null,
   max_deployment_value:String(250n*10n**18n),price0:String(10n**18n),price1:String(300n*10n**18n)},
  // An opening campaign has no runtime row yet: its reserved allocation is its initial amount.
  {id:'B',lifecycle:'opening',profile:nvdaProfile,initial0:null,initial1:null,allocated:{[usdg]:'100',[nvda]:'7'},
   max_deployment_value:null,price0:null,price1:null}];
 let calls=0;
 const db={query:async()=>{calls++;return calls===1?{rows:[{ok:true}]}:{rows};}} as never;
 const uses=await readRangeKeeperWalletAllowanceUses(db,'0xAbC');
 assert.deepEqual(uses.map(u=>[u.campaignId,u.lifecycle]),[['A','active'],['B','opening']]);
 assert.deepEqual(uses[0]!.exposure,[250n*10n**6n*10n**18n/10n**18n,250n*10n**18n*10n**18n/(300n*10n**18n)],'the larger of the allocation and the deployment cap per token');
 assert.deepEqual(uses[1]!.exposure,[100n,7n]);
 // A schema without the live runtime tables has no live campaigns, hence no allowed pair.
 assert.deepEqual(await readRangeKeeperWalletAllowanceUses({query:async()=>({rows:[{ok:false}]})} as never,'0xabc'),[]);
 // An unreadable profile of a live campaign stops the wallet instead of being skipped.
 let n=0;
 await assert.rejects(readRangeKeeperWalletAllowanceUses({query:async()=>(++n===1?{rows:[{ok:true}]}:{rows:[{...rows[0],profile:{}}]})} as never,'0xabc'),/unreadable/);
});
