import assert from 'node:assert/strict';
import {describe,it} from 'node:test';
import {rangeKeeperPaperCandidateFunding} from '../src/deployments/rangekeeper-paper-gas-sampler.js';
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
});
