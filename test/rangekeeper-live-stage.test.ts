import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {keccak256} from 'viem';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {nextRangeKeeperStage} from '../src/strategy/rangekeeper/live-stage.js';
import type {RangeKeeperLiveState,RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import type {RangeKeeperChain} from '../src/strategy/rangekeeper/chain.js';
import {verifyRangeKeeperWalletCode} from '../src/strategy/rangekeeper/wallet-code.js';
import type {RobinhoodClient} from '../src/client.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync(new URL('../config/rangekeeper-v1-aapl-disabled.json',import.meta.url),'utf8')));
const stageConfig={...config,limits:{...config.limits,maxDeploymentValue:300n*10n**18n,minDeploymentPpm:900000}};
const p=config.pool,price0=999991430000000000n,price1=335529829280000000000n;
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
