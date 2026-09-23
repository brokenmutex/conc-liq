import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {assertRangeKeeperPaperTerminalInventory,rangeKeeperPaperCandidateFunding,
 rangeKeeperPaperTerminalAllowances,sampleRangeKeeperPaperGasStages} from '../src/deployments/rangekeeper-paper-gas-sampler.js';
import {replayPaperMint} from '../src/v3/position-math.js';
import type {RangeKeeperCandidate} from '../src/strategy/rangekeeper/domain.js';

const base:RangeKeeperCandidate={kind:'entry',range:{tickLower:-10,tickUpper:10},swap:null,
 amount0Desired:100n,amount1Desired:50n,amount0Min:99n,amount1Min:49n,liquidity:1n,
 deployedValue:150n,sourceBlock:7n,sourceHash:`0x${'1'.repeat(64)}`,expiresAt:1_000};

describe('RangeKeeper owned-fork gas sampler inventory',()=>{
 it('keeps trusted draft idle inventory when replaying either swap direction',()=>{
  const candidate={...base,swap:{token:0 as const,amountIn:20n,quotedOut:15n,minOut:14n,
   priceAfter:1n,feeValue:0n,shortfallValue:0n}};
  assert.deepEqual(rangeKeeperPaperCandidateFunding(candidate,[140n,55n]),[120n,70n]);
  assert.deepEqual(rangeKeeperPaperCandidateFunding({...candidate,swap:{...candidate.swap,token:1}},[140n,75n]),[155n,55n]);
 });
 it('fails closed if trusted draft inventory cannot fund the swap or mint',()=>{
  const candidate={...base,amount1Desired:14n,swap:{token:0 as const,amountIn:20n,quotedOut:15n,
   minOut:14n,priceAfter:1n,feeValue:0n,shortfallValue:0n}};
  assert.throws(()=>rangeKeeperPaperCandidateFunding(candidate,[100n,50n]),/cannot fund frozen mint candidate/);
  assert.throws(()=>rangeKeeperPaperCandidateFunding(candidate,[10n,50n]),/cannot fund frozen swap input/);
 });
 it('reconstructs persisted terminal idle balances and exact residual approvals',()=>{
  const minted=replayPaperMint(1n<<96n,base.range,base.amount0Desired,base.amount1Desired,0n);
  const result=rangeKeeperPaperTerminalAllowances({candidate:{...base,liquidity:minted.liquidity},
   allocation:{token0Raw:String(minted.amount0+7n),token1Raw:String(minted.amount1+9n)},
   openSqrtPriceX96:1n<<96n,openPrice0:1n,openPrice1:1n,decimals0:0,decimals1:0,
   maxDeploymentValue:1_000n});
  assert.equal(result.idle0,7n);assert.equal(result.idle1,9n);
  assert.equal(result.manager0,7n);assert.equal(result.manager1,9n);
  assert.equal(result.router0,0n);assert.equal(result.router1,0n);
 });
 it('rejects terminal inventory that differs from the saved mark',()=>{
  const fake={previous:{idle:{token0:'7',token1:'9'}},kernel:{wallet0:7n,wallet1:9n,
   released0:0n,released1:0n}} as any;
  const frame={sqrtPriceX96:1n<<96n} as any;
  assert.throws(()=>assertRangeKeeperPaperTerminalInventory(fake,base,frame,{idle0:8n,idle1:9n}),
   /differs from saved mark/);
 });
 it('explicitly rejects convert-exit without a saved conversion quote contract',async()=>{
  await assert.rejects(()=>sampleRangeKeeperPaperGasStages({kind:'convert_exit'} as any,{} as any),
   /persisted conversion quote contract/);
 });
});
