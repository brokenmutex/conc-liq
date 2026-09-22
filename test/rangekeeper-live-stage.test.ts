import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {keccak256} from 'viem';
import {initialRangeKeeperState,parseRangeKeeperConfig,rangeKeeperConfigHash} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage,RangeKeeperMintUnavailableError,RangeKeeperStaleCandidateError} from '../src/strategy/rangekeeper/live-stage.js';
import {assertCostedRangeKeeperResume,assertRangeKeeperWidthMigration,assertUntradedRangeKeeperRearm,
 assertRangeKeeperCountMigration,assertRangeKeeperStaleRecenterMigration,
 settleRangeKeeperStaleStage} from '../src/strategy/rangekeeper/live-controller.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperChain} from '../src/strategy/rangekeeper/chain.js';
import {verifyRangeKeeperWalletCode} from '../src/strategy/rangekeeper/wallet-code.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';
import type {RobinhoodClient} from '../src/client.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const stageConfig={...config,limits:{...config.limits,maxDeploymentValue:300n*10n**18n,minDeploymentPpm:900000}};
const p=config.pool,price0=999991430000000000n,price1=335529829280000000000n;
test('post-withdraw stale recenter discards only the candidate and retains settled custody and cost scope',()=>{
 const candidate={kind:'recenter'} as RangeKeeperLiveState['candidate'];
 const state={phase:'recenter',desired:'running',haltReason:null,lastReason:'withdraw_collected',
  policy:initialRangeKeeperState(config,'test-build'),candidate,withdrawDone:true,swapDone:false,
  activeTokenId:null,retiredTokenIds:['1271827'],actionStartCostIndex:4,reservedActionCost:10n} as RangeKeeperLiveState;
 assert.equal(settleRangeKeeperStaleStage(state,new RangeKeeperStaleCandidateError('Current swap would leave the approved range')),
  'stale_recenter_replan');
 assert.equal(state.phase,'recenter');assert.equal(state.desired,'running');
 assert.equal(state.haltReason,null);assert.equal(state.candidate,null);
 assert.deepEqual(state.retiredTokenIds,['1271827']);
 assert.equal(state.swapDone,false);assert.equal(state.withdrawDone,true);
 assert.equal(state.actionStartCostIndex,4);assert.equal(state.reservedActionCost,0n);
 const unsent={...state,phase:'recenter' as const,withdrawDone:false,desired:'running' as const,haltReason:null};
 assert.equal(settleRangeKeeperStaleStage(unsent,new RangeKeeperStaleCandidateError('stale')),null);
 assert.equal(unsent.phase,'recenter');
});
test('stale recenter build migration requires the exact withdrawn campaign and unchanged config',()=>{
 const old={id:'31802d63-9ec8-423c-bc1b-f781f8b44f92',buildId:'old-build',
  configHash:rangeKeeperConfigHash(config),policy:initialRangeKeeperState(config,'old-build'),
  phase:'recenter',desired:'running',haltReason:null,candidate:{kind:'recenter'},
  withdrawDone:true,swapDone:false,activeTokenId:null,closedAt:null,
  retiredTokenIds:['1271827'],last:{position:{tokenId:1271827n,liquidity:0n}}} as RangeKeeperLiveState;
 const recorded=JSON.parse(rangeKeeperJson(config));
 const guard=(state:RangeKeeperLiveState=old,proposal=config,stored:unknown=recorded)=>
  assertRangeKeeperStaleRecenterMigration(state,stored,proposal,old.id,'old-build','new-build');
 assert.doesNotThrow(()=>guard());
 assert.throws(()=>guard({...old,withdrawDone:false}),/reconciled post-withdraw/);
 assert.throws(()=>guard({...old,swapDone:true}),/reconciled post-withdraw/);
 assert.throws(()=>guard({...old,activeTokenId:1271827n}),/reconciled post-withdraw/);
 assert.throws(()=>guard(old,{...config,limits:{...config.limits,maxActionCost:config.limits.maxActionCost+1n}}),/configuration changed/);
 assert.throws(()=>guard(old,config,{...recorded,operator:'0x0000000000000000000000000000000000000000'}),/config changed/);
});
test('closed costed campaign may change only 200-tick width to 40 ticks',()=>{
 const previous={...config,limits:{...config.limits,fullWidthSpacings:20}};
 const stored=JSON.parse(rangeKeeperJson(previous));
 assert.doesNotThrow(()=>assertRangeKeeperWidthMigration(rangeKeeperConfigHash(previous),stored,config));
 assert.throws(()=>assertRangeKeeperWidthMigration(rangeKeeperConfigHash(previous),stored,
  {...config,limits:{...config.limits,maxCampaignCost:config.limits.maxCampaignCost+1n}}),
  /beyond range width/);
 assert.throws(()=>assertRangeKeeperWidthMigration(rangeKeeperConfigHash(previous),stored,
  {...config,limits:{...config.limits,fullWidthSpacings:2}}),
  /reviewed 200-to-40-tick/);
});
test('active count migration changes only both stops and retains the held NFT and policy ledger',()=>{
 const prior={...config,campaignScope:{maxDurationSeconds:0,maxEconomicActions:2}};
 const next={...prior,campaignScope:{...prior.campaignScope,maxEconomicActions:0},
  limits:{...prior.limits,maxRecenters:0}};
 const id='31802d63-9ec8-423c-bc1b-f781f8b44f92';
 const old={id,operator:prior.operator!,buildId:'old-build',configHash:rangeKeeperConfigHash(prior),
  policy:initialRangeKeeperState(prior,'old-build'),phase:'holding',desired:'running',activeTokenId:1271827n,
  last:{position:{tokenId:1271827n}},candidate:null,swapDone:false,withdrawDone:false,
  closedAt:null,haltReason:null,economicActions:2,recenters:1,
  costEvents:[{gasValue:1n,swapFeeValue:0n,swapShortfallValue:0n}]} as unknown as RangeKeeperLiveState;
 const stored=JSON.parse(rangeKeeperJson(prior));
 const guard=(state:RangeKeeperLiveState=old,proposal=next,recorded:unknown=stored)=>
  assertRangeKeeperCountMigration(state,recorded,proposal,id,'old-build','new-build');
 assert.doesNotThrow(()=>guard());
 assert.throws(()=>guard(old,{...next,limits:{...next.limits,maxRecenters:4}}),/recenter count cap/);
 assert.throws(()=>guard(old,{...next,limits:{...next.limits,maxCampaignCost:next.limits.maxCampaignCost+1n}}),
  /beyond the reviewed count limits/);
 assert.throws(()=>guard({...old,candidate:{} as RangeKeeperLiveState['candidate']}),/settled/);
 assert.throws(()=>guard({...old,activeTokenId:null}),/settled/);
 assert.throws(()=>guard({...old,configHash:`0x${'11'.repeat(32)}`}),/hash/);
 assert.throws(()=>guard(old,next,{...stored,limits:{...stored.limits,maxRecenters:3}}),/reviewed count limits/);
 assert.throws(()=>assertRangeKeeperCountMigration(old,stored,next,id,'old-build','old-build'),/new sealed build/);
});
test('rearm accepts only the exact closed no-transaction campaign and new build',()=>{
 const old={id:'470e5f84-ab82-4735-92f9-57e96c05b344',buildId:'old-build',
  configHash:rangeKeeperConfigHash(config),operator:config.operator!,phase:'closed',desired:'stopped',
  lastReason:'complete_exit_reconciled',closedAt:1000,economicActions:0,recenters:0,
  activeTokenId:null,retiredTokenIds:[],candidate:null,swapDone:false,gasSpentWei:0n,costEvents:[]} as unknown as RangeKeeperLiveState;
 const guard=(state:RangeKeeperLiveState=old,buildId='new-build')=>
  assertUntradedRangeKeeperRearm(state,old.id,'old-build',buildId,old.configHash,old.operator);
 assert.doesNotThrow(()=>guard());
 assert.throws(()=>guard({...old,economicActions:1}),/no economic action/);
 assert.throws(()=>guard({...old,costEvents:[{} as RangeKeeperLiveState['costEvents'][number]]}),/no economic action/);
 assert.throws(()=>guard({...old,phase:'entry'}),/completely reconciled/);
 assert.throws(()=>guard(old,'old-build'),/new sealed build/);
});
test('costed resume retains the closed campaign and rejects changed custody or exhausted spend',()=>{
 const old={id:'470e5f84-ab82-4735-92f9-57e96c05b344',buildId:'old-build',
  configHash:rangeKeeperConfigHash(config),operator:config.operator!,phase:'closed',desired:'stopped',
  lastReason:'complete_exit_reconciled',closedAt:1000,economicActions:0,recenters:0,
  activeTokenId:null,retiredTokenIds:[],candidate:null,legacyNftCount:43n,
  last:{position:null,wallet1:0n,nftCount:43n,allowances:[]},gasSpentWei:1n,
  costEvents:[{gasValue:1n,swapFeeValue:0n,swapShortfallValue:0n}]} as unknown as RangeKeeperLiveState;
 const guard=(state:RangeKeeperLiveState=old)=>assertCostedRangeKeeperResume(state,old.id,'old-build',
  'new-build',old.configHash,old.operator,config.limits);
 assert.doesNotThrow(()=>guard());
 assert.throws(()=>guard({...old,last:{...old.last,wallet1:1n}}),/fully exited/);
 assert.throws(()=>guard({...old,costEvents:[]}),/retained receipt costs/);
 assert.throws(()=>guard({...old,costEvents:[{gasValue:config.limits.maxCampaignCost,
  swapFeeValue:0n,swapShortfallValue:0n} as RangeKeeperLiveState['costEvents'][number]]}),/budget/);
});
test('wallet-code gate pins the delegated operator and target bytecode',async()=>{
 const source={block:10n,hash:`0x${'aa'.repeat(32)}` as const,timestamp:100};
 const target=config.walletCode.kind==='eip7702'?config.walletCode.delegate:null;
 assert(target);
 const client={getBytecode:async({address}:{address:string})=>address.toLowerCase()===config.operator!.toLowerCase()
  ?`0xef0100${target.slice(2)}`:'0x6001',getBlock:async()=>({hash:source.hash})} as unknown as RobinhoodClient;
 const testConfig={...config,walletCode:{kind:'eip7702' as const,delegate:target,
  delegateCodeHash:keccak256('0x6001')}};
 await verifyRangeKeeperWalletCode(client,source,config.operator!,testConfig);
 await assert.rejects(verifyRangeKeeperWalletCode(client,source,config.operator!,config),/bytecode changed/);
});
test('an approval delay refreshes the same approved swap amount from a canonical quote',async()=>{
 const candidate={kind:'entry' as const,range:{tickLower:218030,tickUpper:218230},
  swap:{token:0 as const,amountIn:142826815n,quotedOut:424258098123899961n,
   minOut:422136807633280461n,priceAfter:4319138612071811613011853512028125n,
   feeValue:71412795487097725n,shortfallValue:402930944538710073n},
  amount0Desired:152344047n,amount1Desired:424258098123899961n,amount0Min:127011598n,
  amount1Min:422136807633280215n,liquidity:1477897525261538n,
  deployedValue:270000001274972199326n,sourceBlock:1n,sourceHash:`0x${'11'.repeat(32)}` as const,
  expiresAt:90};
 const state={phase:'entry',candidate,swapDone:false,activeTokenId:null,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const source={block:2n,hash:`0x${'22'.repeat(32)}` as const,timestamp:500};
 const snapshot={source,operator:config.operator!,wallet0:295170862n,wallet1:0n,
  nativeWei:10n**16n,position:null,tick:218130,sqrtPriceX96:0n,
  allowances:[{token:p.token0,spender:p.router,amount:candidate.swap.amountIn},
   {token:p.token0,spender:p.positionManager,amount:295170862n},
   {token:p.token1,spender:p.router,amount:0n},
   {token:p.token1,spender:p.positionManager,amount:stageConfig.limits.maxDeploymentValue*10n**18n/price1}]} as RangeKeeperSnapshot;
 let quoted=0;
 const chain={quote:async()=>{quoted++;return {amountOut:candidate.swap.quotedOut,
  priceAfter:candidate.swap.priceAfter,feeValue:candidate.swap.feeValue,
  shortfallValue:candidate.swap.shortfallValue,sourceBlock:source.block,sourceHash:source.hash};}} as unknown as RangeKeeperChain;
 const plan=await nextRangeKeeperStage(state,snapshot,stageConfig,chain,{price0,price1});
 assert.equal(plan?.kind,'swap');assert.equal(quoted,1);
 if(plan?.kind==='swap'){
  assert.equal(plan.amountIn,candidate.swap.amountIn);
  assert.equal(plan.minOut,candidate.swap.quotedOut*9950n/10000n);
  assert.equal(plan.deadline,800n);
 }
});
test('a capped swap preapproves both mint legs and the router before trading',async()=>{
 const capped={...config,limits:{...config.limits,maxDeploymentValue:250n*10n**18n,minDeploymentPpm:980000}};
 const source={block:2n,hash:`0x${'22'.repeat(32)}` as const,timestamp:500};
 const candidate={kind:'entry' as const,range:{tickLower:218050,tickUpper:218250},
  swap:{token:0 as const,amountIn:128866313n,quotedOut:383538180808486242n,
   minOut:381620489904443810n,priceAfter:4323357006059969185046779627547153n,
   feeValue:64432604307848795n,shortfallValue:72748885621983026n},
  amount0Desired:121135770n,amount1Desired:383538180808486242n,
  amount0Min:115691606n,amount1Min:381620489904443689n,
  liquidity:1340762399459297n,deployedValue:245000001666406247232n,
  sourceBlock:1n,sourceHash:`0x${'11'.repeat(32)}` as const,expiresAt:90};
 const state={phase:'entry',candidate,swapDone:false,activeTokenId:null,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const allowances=[{token:p.token0,spender:p.router,amount:0n},
  {token:p.token0,spender:p.positionManager,amount:0n},
  {token:p.token1,spender:p.router,amount:0n},
  {token:p.token1,spender:p.positionManager,amount:0n}];
 const before={source,operator:config.operator!,wallet0:275170862n,wallet1:0n,
  nativeWei:10n**16n,position:null,tick:218155,sqrtPriceX96:candidate.swap.priceAfter,
  allowances} as RangeKeeperSnapshot;
 const chain={quote:async()=>({...candidate.swap,amountOut:candidate.swap.quotedOut,
  sourceBlock:source.block,sourceHash:source.hash})} as unknown as RangeKeeperChain;
 const livePrices={price0,price1:335632887590000000000n};
 const approval=await nextRangeKeeperStage(state,before,capped,chain,livePrices);
 assert.equal(approval?.kind,'approve');
 if(approval?.kind==='approve'){
  assert.equal(approval.spender,'positionManager');
  assert.equal(approval.token,0);
  assert.equal(approval.amount,before.wallet0);
 }
 const withUsdManager={...before,allowances:allowances.map(a=>a.token===p.token0&&a.spender===p.positionManager?
  {...a,amount:before.wallet0}:a)};
 const stockApproval=await nextRangeKeeperStage(state,withUsdManager,capped,chain,livePrices);
 const stockCap=capped.limits.maxDeploymentValue*10n**18n/livePrices.price1;
 assert.deepEqual(stockApproval,{kind:'approve',token:1,spender:'positionManager',amount:stockCap});
 const withManagers={...withUsdManager,allowances:withUsdManager.allowances.map(a=>a.token===p.token1&&a.spender===p.positionManager?
  {...a,amount:stockCap}:a)};
 const routerApproval=await nextRangeKeeperStage(state,withManagers,capped,chain,livePrices);
 assert.deepEqual(routerApproval,{kind:'approve',token:0,spender:'router',amount:before.wallet0});
 const withApproval={...withManagers,allowances:withManagers.allowances.map(a=>a.token===p.token0&&a.spender===p.router?
  {...a,amount:before.wallet0}:a)};
 assert.equal((await nextRangeKeeperStage(state,withApproval,capped,chain,livePrices))?.kind,'swap');
 const after={...withApproval,wallet0:before.wallet0-candidate.swap.amountIn,
  wallet1:candidate.swap.quotedOut};
 const mint=await nextRangeKeeperStage({...state,swapDone:true},after,capped,chain,livePrices);
 assert.equal(mint?.kind,'mint');
 if(mint?.kind==='mint'){
  assert(mint.candidate.deployedValue>=245n*10n**18n);
  assert(mint.candidate.deployedValue<=250n*10n**18n);
 }
});
test('a drifted post-swap mint scales excess value down and rejects an underfunded range',async()=>{
 const capped={...config,limits:{...config.limits,maxDeploymentValue:250n*10n**18n,minDeploymentPpm:980000}};
 const source={block:2n,hash:`0x${'22'.repeat(32)}` as const,timestamp:500};
 const candidate={kind:'entry' as const,range:{tickLower:218050,tickUpper:218250},swap:{token:0 as const,
  amountIn:128866313n,quotedOut:383538180808486242n,minOut:381620489904443810n,
  priceAfter:4323357006059969185046779627547153n,feeValue:0n,shortfallValue:0n},
  amount0Desired:150000000n,amount1Desired:470000000000000000n,amount0Min:0n,amount1Min:0n,
  liquidity:1n,deployedValue:245n*10n**18n,sourceBlock:1n,
  sourceHash:`0x${'11'.repeat(32)}` as const,expiresAt:90};
 const state={phase:'entry',candidate,swapDone:true,activeTokenId:null,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const allowances=[{token:p.token0,spender:p.router,amount:0n},
  {token:p.token0,spender:p.positionManager,amount:150000000n},
  {token:p.token1,spender:p.router,amount:0n},
  {token:p.token1,spender:p.positionManager,amount:470000000000000000n}];
 const snapshot={source,operator:config.operator!,wallet0:180000000n,wallet1:470000000000000000n,
  nativeWei:10n**16n,position:null,tick:218155,sqrtPriceX96:candidate.swap.priceAfter,
  allowances} as RangeKeeperSnapshot;
 const prices={price0,price1:335632887590000000000n};
 const mint=await nextRangeKeeperStage(state,snapshot,capped,{} as RangeKeeperChain,prices);
 assert.equal(mint?.kind,'mint');
 if(mint?.kind==='mint'){
  assert(mint.candidate.amount0Desired<candidate.amount0Desired);
  assert(mint.candidate.deployedValue>=245n*10n**18n);
  assert(mint.candidate.deployedValue<=250n*10n**18n);
 }
 await assert.rejects(nextRangeKeeperStage(state,{...snapshot,wallet1:200000000000000000n},
  capped,{} as RangeKeeperChain,prices),RangeKeeperMintUnavailableError);
});
test('the failed 40-tick entry could mint before approval delay and use idle USDG on later ticks',async()=>{
 const candidate={kind:'entry' as const,range:{tickLower:218090,tickUpper:218130},
  swap:{token:0 as const,amountIn:143040867n,quotedOut:423931823296336723n,
   minOut:421812164179855039n,priceAfter:4314246143813801979750295328179705n,
   feeValue:71519820569884905n,shortfallValue:0n},
  amount0Desired:106961202n,amount1Desired:423931823296336723n,
  amount0Min:105897734n,amount1Min:421812164179855027n,
  liquidity:6794153103498356n,deployedValue:249500000064287647351n,
  sourceBlock:68907827n,sourceHash:`0x${'cc'.repeat(32)}` as const,expiresAt:1790004921};
 const state={phase:'entry',candidate,swapDone:true,activeTokenId:null,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
 const stockPrice=337485935960000000000n;
 const snapshot={source:{block:68909156n,hash:`0x${'aa'.repeat(32)}` as const,timestamp:1790004965},
  operator:config.operator!,wallet0:132152696n,wallet1:423955610653043361n,
  nativeWei:10n**16n,position:null,tick:218113,
  sqrtPriceX96:4314292042204425506861169193207304n,
  allowances:[{token:p.token0,spender:p.router,amount:132152696n},
   {token:p.token0,spender:p.positionManager,amount:275193563n},
   {token:p.token1,spender:p.router,amount:0n},
   {token:p.token1,spender:p.positionManager,
    amount:config.limits.maxDeploymentValue*10n**18n/stockPrice}]} as RangeKeeperSnapshot;
 const prices={price0:999991430000000000n,price1:stockPrice};
 const immediate=await nextRangeKeeperStage(state,snapshot,config,{} as RangeKeeperChain,prices);
 assert.equal(immediate?.kind,'mint');
 if(immediate?.kind==='mint'){
  assert(immediate.candidate.deployedValue>=245n*10n**18n);
  assert(immediate.candidate.deployedValue<=250n*10n**18n);
 }
 const later={...snapshot,source:{...snapshot.source,block:68909889n,timestamp:1790005039},
  tick:218110,sqrtPriceX96:4313623716782692767893606704481265n};
 const repriced=await nextRangeKeeperStage(state,later,config,{} as RangeKeeperChain,
  {price0:1000080000000000000n,price1:stockPrice});
 assert.equal(repriced?.kind,'mint');
 if(repriced?.kind==='mint'){
  assert(repriced.candidate.amount0Desired>candidate.amount0Desired,
   'Previously idle USDG is admitted only after the completed swap');
  assert(repriced.candidate.deployedValue>=245n*10n**18n);
  assert(repriced.candidate.deployedValue<=250n*10n**18n);
 }
 await assert.rejects(nextRangeKeeperStage(state,{...later,
  source:{...later.source,block:68910599n,timestamp:1790005108},tick:218107,
  sqrtPriceX96:4313136158835044232948535785310267n},config,{} as RangeKeeperChain,
  {price0:1000080000000000000n,price1:stockPrice}),RangeKeeperMintUnavailableError);
});
