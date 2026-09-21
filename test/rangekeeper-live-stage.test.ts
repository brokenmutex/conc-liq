import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {keccak256} from 'viem';
import {parseRangeKeeperConfig,rangeKeeperConfigHash} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage,RangeKeeperMintUnavailableError} from '../src/strategy/rangekeeper/live-stage.js';
import {assertCostedRangeKeeperResume,assertRangeKeeperWidthMigration,assertUntradedRangeKeeperRearm} from '../src/strategy/rangekeeper/live-controller.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperChain} from '../src/strategy/rangekeeper/chain.js';
import {verifyRangeKeeperWalletCode} from '../src/strategy/rangekeeper/wallet-code.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';
import type {RobinhoodClient} from '../src/client.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const stageConfig={...config,limits:{...config.limits,maxDeploymentValue:300n*10n**18n,minDeploymentPpm:900000}};
const p=config.pool,price0=999991430000000000n,price1=335529829280000000000n;
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
   {token:p.token0,spender:p.positionManager,amount:0n},
   {token:p.token1,spender:p.router,amount:0n},
   {token:p.token1,spender:p.positionManager,amount:0n}]} as RangeKeeperSnapshot;
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
test('a capped swap keeps wallet surplus outside both staging and mint sizing',async()=>{
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
 if(approval?.kind==='approve')assert.equal(approval.amount,before.wallet0);
 const withApproval={...before,allowances:allowances.map(a=>a.token===p.token0&&a.spender===p.router?
  {...a,amount:before.wallet0}:a)};
 assert.equal((await nextRangeKeeperStage(state,withApproval,capped,chain,livePrices))?.kind,'swap');
 const after={...before,wallet0:before.wallet0-candidate.swap.amountIn,
  wallet1:candidate.swap.quotedOut};
 const mintApproval=await nextRangeKeeperStage({...state,swapDone:true},after,capped,chain,livePrices);
 assert.equal(mintApproval?.kind,'approve');
 if(mintApproval?.kind==='approve'){
  assert.equal(mintApproval.spender,'positionManager');
  assert.equal(mintApproval.amount,after.wallet0);
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
