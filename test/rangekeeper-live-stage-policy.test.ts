import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage} from '../src/strategy/rangekeeper/live-stage.js';
import {RANGEKEEPER_ALLOWANCE_POLICY,allowanceCeiling,allowancePairKey,persistentAllowanceGrant,rangeKeeperAllowanceExposure,
 type RangeKeeperAllowancePolicy} from '../src/strategy/rangekeeper/allowance-policy.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperChain} from '../src/strategy/rangekeeper/chain.js';

// persistent_capped_v1 stage planning on the live AAPL/USDG profile (token0 USDG, token1 stock token).
const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const capped={...config,limits:{...config.limits,maxDeploymentValue:250n*10n**18n,minDeploymentPpm:980000}};
const p=config.pool,price0=999991430000000000n,price1=335632887590000000000n,prices={price0,price1};
const source={block:2n,hash:`0x${'22'.repeat(32)}` as const,timestamp:500};
const candidate={kind:'entry' as const,range:{tickLower:218050,tickUpper:218250},
 swap:{token:0 as const,amountIn:128866313n,quotedOut:383538180808486242n,minOut:381620489904443810n,
  priceAfter:4323357006059969185046779627547153n,feeValue:64432604307848795n,shortfallValue:72748885621983026n},
 amount0Desired:121135770n,amount1Desired:383538180808486242n,amount0Min:115691606n,amount1Min:381620489904443689n,
 liquidity:1340762399459297n,deployedValue:245000001666406247232n,sourceBlock:1n,sourceHash:`0x${'11'.repeat(32)}` as const,expiresAt:90};
const entry={phase:'entry',candidate,swapDone:false,activeTokenId:null,reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
const chain={quote:async()=>({...candidate.swap,amountOut:candidate.swap.quotedOut,sourceBlock:source.block,sourceHash:source.hash})} as unknown as RangeKeeperChain;
const noChain={} as RangeKeeperChain;
// Pair order: USDG/router, USDG/manager, stock/router, stock/manager.
const pairs=[[p.token0,p.router],[p.token0,p.positionManager],[p.token1,p.router],[p.token1,p.positionManager]] as const;
type Four=[bigint,bigint,bigint,bigint];
const wallet=(amounts:Four,extra:Partial<RangeKeeperSnapshot>={})=>({source,operator:config.operator!,wallet0:275170862n,wallet1:0n,
 nativeWei:10n**16n,position:null,tick:218155,sqrtPriceX96:candidate.swap.priceAfter,
 allowances:pairs.map(([token,spender],i)=>({token,spender,amount:amounts[i]!})),...extra}) as RangeKeeperSnapshot;
const applyApproval=(s:RangeKeeperSnapshot,plan:{token:0|1;spender:'router'|'positionManager';amount:bigint})=>
 wallet(s.allowances.map(a=>a.token===(plan.token===0?p.token0:p.token1)&&a.spender===(plan.spender==='router'?p.router:p.positionManager)?
  plan.amount:a.amount) as Four,{wallet0:s.wallet0,wallet1:s.wallet1});
const exposure=rangeKeeperAllowanceExposure({initial:[275170862n,0n],maxDeploymentValue:capped.limits.maxDeploymentValue,
 decimals:[p.decimals0,p.decimals1],prices:[price0,price1]});
const [cap0,cap1]=[allowanceCeiling(exposure[0]),allowanceCeiling(exposure[1])];
const policy=(retain?:readonly string[]):RangeKeeperAllowancePolicy=>({kind:RANGEKEEPER_ALLOWANCE_POLICY,exposure,...(retain?{retain:new Set(retain)}:{})});
const key=(i:number)=>allowancePairKey(pairs[i]![0],pairs[i]![1]);

test('exposure covers an acquired token through the deployment cap and the cap is a finite 5x',()=>{
 assert.equal(exposure[0],275170862n,'the allocated USDG exceeds the $250 deployment cap');
 assert.equal(exposure[1],250n*10n**18n*10n**18n/price1,'a token acquired by swap is held at zero: the deployment cap bounds it');
 assert(cap0===5n*exposure[0]&&cap1===5n*exposure[1]&&cap0<(1n<<256n)-1n);
 assert.deepEqual(rangeKeeperAllowanceExposure({initial:[7n,0n],maxDeploymentValue:100n,decimals:[0,0],prices:null}),[7n,0n],
  'without frozen prices only the allocation counts');
});
test('no approval is planned while every canonical allowance already covers the stage',async()=>{
 const swap=await nextRangeKeeperStage(entry,wallet([cap0,cap0,0n,cap1]),capped,chain,prices,policy());
 assert.equal(swap?.kind,'swap','sufficient allowances: the first stage is the swap itself');
 const after=wallet([cap0-candidate.swap.amountIn,cap0-146000000n,0n,cap1-candidate.swap.quotedOut],
  {wallet0:146304549n,wallet1:candidate.swap.quotedOut});
 const mint=await nextRangeKeeperStage({...entry,swapDone:true},after,capped,chain,prices,policy());
 assert.equal(mint?.kind,'mint','the mint needs no approval either');
});
test('one capped approval per short pair, straight to max(requirement, 5x exposure), then the swap',async()=>{
 const sequence:Awaited<ReturnType<typeof nextRangeKeeperStage>>[]=[];let snapshot=wallet([0n,0n,0n,0n]);
 for(let i=0;i<6;i++){
  const plan=await nextRangeKeeperStage(entry,snapshot,capped,chain,prices,policy());
  sequence.push(plan);if(plan?.kind!=='approve')break;snapshot=applyApproval(snapshot,plan);
 }
 assert.deepEqual(sequence.slice(0,3),[{kind:'approve',token:0,spender:'positionManager',amount:cap0},
  {kind:'approve',token:1,spender:'positionManager',amount:cap1},{kind:'approve',token:0,spender:'router',amount:cap0}]);
 assert.equal(sequence[3]?.kind,'swap','three approvals then the swap: no reset, no repeated grant, no cleanup');
 assert.equal(sequence.length,4);
});
test('a depleted allowance is topped up with a single approval, not reset then granted',async()=>{
 const depleted=wallet([0n,5n,0n,cap1]);
 assert.deepEqual(await nextRangeKeeperStage(entry,depleted,capped,chain,prices,policy()),
  {kind:'approve',token:0,spender:'positionManager',amount:cap0});
 assert.deepEqual(await nextRangeKeeperStage(entry,depleted,capped,chain,prices),
  {kind:'approve',token:0,spender:'positionManager',amount:0n},'the legacy planner still resets first');
});
test('a stage requirement above the cap is granted exactly; the grant helper never returns less than the need or the sentinel',async()=>{
 const tiny:RangeKeeperAllowancePolicy={kind:RANGEKEEPER_ALLOWANCE_POLICY,exposure:[1n,1n]};
 assert.deepEqual(await nextRangeKeeperStage(entry,wallet([0n,0n,0n,0n]),capped,chain,prices,tiny),
  {kind:'approve',token:0,spender:'positionManager',amount:275170862n},'the whole inventory beats a 5-unit cap');
 assert.equal(persistentAllowanceGrant({current:9n,needed:9n,exposure:0n}),null);
 assert.equal(persistentAllowanceGrant({current:0n,needed:0n,exposure:0n}),null);
 assert.equal(persistentAllowanceGrant({current:3n,needed:4n,exposure:0n}),4n);
 assert.equal(persistentAllowanceGrant({current:3n,needed:4n,exposure:10n}),50n);
 assert.throws(()=>persistentAllowanceGrant({current:0n,needed:1n,exposure:(1n<<256n)/5n}),/finite/);
});
test('a holding campaign is never cleaned up under the policy, while the legacy planner still zeroes',async()=>{
 const holding={phase:'holding',desired:'running',candidate:null,activeTokenId:7n,reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const dirty=wallet([5n,6n,0n,7n]);
 assert.equal(await nextRangeKeeperStage(holding,dirty,capped,noChain,prices,policy()),null);
 assert.deepEqual(await nextRangeKeeperStage(holding,dirty,capped,noChain,prices),{kind:'approve',token:0,spender:'router',amount:0n});
});
test('a close zeroes only the pairs no sibling uses, leaves sibling pairs untouched, and clears everything for the last user',async()=>{
 const exit={phase:'exit',desired:'stopped',exitMode:'retain',activeTokenId:null,candidate:null,reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const drain=async(start:RangeKeeperSnapshot,retain?:readonly string[])=>{
  let snapshot=start;const zeroed:string[]=[];
  for(let i=0;i<5;i++){
   const plan=await nextRangeKeeperStage(exit,snapshot,capped,noChain,prices,policy(retain));
   if(!plan)break;assert(plan.kind==='approve'&&plan.amount===0n);zeroed.push(`${plan.token}:${plan.spender}`);snapshot=applyApproval(snapshot,plan);
  }
  return {zeroed,snapshot};
 };
 // A sibling still uses the USDG pairs: only the stock-token pairs are revoked, the USDG allowances stay exactly as they were.
 const sibling=await drain(wallet([cap0,cap0,3n,cap1]),[key(0),key(1)]);
 assert.deepEqual(sibling.zeroed,['1:router','1:positionManager']);
 assert.deepEqual(sibling.snapshot.allowances.map(a=>a.amount),[cap0,cap0,0n,0n]);
 // The last user's close revokes the remaining pairs.
 const last=await drain(sibling.snapshot);
 assert.deepEqual(last.zeroed,['0:router','0:positionManager']);assert(last.snapshot.allowances.every(a=>a.amount===0n));
 // Pre-policy campaigns hold only zero allowances: a close has nothing to revoke.
 assert.equal(await nextRangeKeeperStage(exit,wallet([0n,0n,0n,0n]),capped,noChain,prices,policy([key(0)])),null);
});

// Stage sequences produced by the real planner over a small canonical wallet model.
type Plan=NonNullable<Awaited<ReturnType<typeof nextRangeKeeperStage>>>;
async function runStages(initial:RangeKeeperLiveState,start:RangeKeeperSnapshot,pol:RangeKeeperAllowancePolicy,limit=12){
 let state=structuredClone(initial),snapshot=start;const kinds:string[]=[];
 for(let i=0;i<limit;i++){
  const plan=await nextRangeKeeperStage(state,snapshot,capped,chain,prices,pol) as Plan|null;
  if(!plan)break;
  kinds.push(plan.kind==='approve'?`approve${plan.amount===0n?'0':''}:${plan.token}:${plan.spender}`:plan.kind);
  if(plan.kind==='approve')snapshot=applyApproval(snapshot,plan);
  else if(plan.kind==='swap'){
   snapshot={...snapshot,wallet0:snapshot.wallet0-plan.amountIn,wallet1:snapshot.wallet1+candidate.swap.quotedOut,
    allowances:snapshot.allowances.map(a=>a.token===p.token0&&a.spender===p.router?{...a,amount:a.amount-plan.amountIn}:a)};
   state.swapDone=true;
  }else if(plan.kind==='mint'){
   const c=plan.candidate;
   snapshot={...snapshot,wallet0:snapshot.wallet0-c.amount0Desired,wallet1:snapshot.wallet1-c.amount1Desired,
    allowances:snapshot.allowances.map(a=>a.spender!==p.positionManager?a:{...a,amount:a.amount-(a.token===p.token0?c.amount0Desired:c.amount1Desired)}),position:null};
   kinds.push('(holding)');break;
  }else if(plan.kind==='withdraw'){
   snapshot={...snapshot,wallet0:snapshot.wallet0+120_000_000n,wallet1:snapshot.wallet1,position:null};
   state={...state,activeTokenId:null,withdrawDone:true};
  }
 }
 return {kinds,snapshot};
}
test('stage sequences: first campaign opens with three approvals, a second one on the pair with none, a recenter tops up only what depleted',async()=>{
 // First campaign on a fresh wallet: 3 capped approvals + swap + mint, no cleanup (was 3 + swap + mint + 3 cleanup).
 const first=await runStages(entry,wallet([0n,0n,0n,0n]),policy());
 assert.deepEqual(first.kinds,['approve:0:positionManager','approve:1:positionManager','approve:0:router','swap','mint','(holding)']);
 assert(first.snapshot.allowances.find(a=>a.token===p.token0&&a.spender===p.positionManager)!.amount>0n,'the grant outlives the stage');
 // Second campaign on the same pair, allowances inherited from the first: swap + mint only.
 const second=await runStages(entry,wallet(first.snapshot.allowances.map(a=>a.amount) as Four,{wallet0:275170862n,wallet1:0n}),policy());
 assert.deepEqual(second.kinds,['swap','mint','(holding)']);
 // Recenter: withdraw, then only the pair a prior mint depleted below the requirement is topped up.
 const recenter={phase:'recenter',desired:'running',candidate:{...candidate,kind:'recenter' as const},swapDone:false,withdrawDone:false,activeTokenId:7n,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const held=(amounts:Four)=>wallet(amounts,{wallet0:155_170_862n,wallet1:0n,position:{tokenId:7n,owner:config.operator!,token0:p.token0,token1:p.token1,fee:p.fee,
  tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,liquidity:10n**15n,tokensOwed0:0n,tokensOwed1:0n}});
 const covered=await runStages(recenter,held([cap0,cap0,0n,cap1]),policy());
 assert.deepEqual(covered.kinds,['withdraw','swap','mint','(holding)'],'sufficient allowances: no approval, no cleanup');
 const depleted=await runStages(recenter,held([50n,cap0,0n,cap1]),policy());
 assert.deepEqual(depleted.kinds,['withdraw','approve:0:router','swap','mint','(holding)'],'one top-up for the depleted router allowance');
});
test('stage sequences: a retained close is withdraw only beside a same-pool sibling, one revoke beside a stable-only sibling, every revoke for the last user',async()=>{
 const exit={phase:'exit',desired:'stopped',exitMode:'retain',activeTokenId:7n,candidate:null,reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const pos=(amounts:Four)=>wallet(amounts,{wallet0:5n,wallet1:7n,position:{tokenId:7n,owner:config.operator!,token0:p.token0,token1:p.token1,fee:p.fee,
  tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,liquidity:10n**15n,tokensOwed0:0n,tokensOwed1:0n}});
 const held:Four=[cap0-1n,cap0-1n,0n,cap1-1n];
 assert.deepEqual((await runStages(exit,pos(held),policy([0,1,2,3].map(key)))).kinds,['withdraw'],'a sibling on the same pool keeps every pair');
 assert.deepEqual((await runStages(exit,pos(held),policy([key(0),key(1)]))).kinds,['withdraw','approve0:1:positionManager'],
  'a sibling that shares only the stable keeps its pairs; only the stock-token pair is revoked');
 assert.deepEqual((await runStages(exit,pos(held),policy())).kinds,['withdraw','approve0:0:router','approve0:0:positionManager','approve0:1:positionManager'],
  'the last user revokes every non-zero pair (a zero pair needs no transaction)');
});
