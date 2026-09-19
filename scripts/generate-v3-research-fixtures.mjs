// Development-only differential fixture generator. Requires a compiled official
// ResearchSwap harness; instructions and pinned upstream commit are in the note.
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { swapStep } from '../src/research/swap.ts';
import { sqrtRatioAtTick, MIN_SQRT_RATIO } from '../src/backtest/principal.ts';
const root = 'data/lp-research-tools/v3-core';
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
assert.equal(commit, 'd0831dc6b8a318df3872b6d68f6de135c9f3ec29');
const artifact = JSON.parse(await readFile(`${root}/out/ResearchSwap.sol/ResearchSwap.json`, 'utf8'));
const node = spawn('/root/.foundry/bin/anvil', ['--host','127.0.0.1','--port','18659','--silent'], {stdio:'ignore'});
const rpc = createPublicClient({transport:http('http://127.0.0.1:18659', {retryCount:0,timeout:2000})});
const vectors = [], address = '0x0000000000000000000000000000000000001234';
try {
  for(let attempt=0;;attempt++) { try {await rpc.getChainId();break;} catch {if(attempt>30) throw new Error('Local Anvil did not start'); await new Promise(r=>setTimeout(r,100));} }
  const cases=[];
  for(const tick of [-223000,0,223000]) for(const sign of [-1,1]) for(const liquidity of [1000n,10n**18n,10n**32n])
    for(const amount of [1n,1000000n,10n**25n]) for(const fee of [500,3000]) for(const exactIn of [true,false]) {
      cases.push([sqrtRatioAtTick(tick),sqrtRatioAtTick(tick+sign*120),liquidity,exactIn?amount:-amount,fee]);
    }
  cases.push([sqrtRatioAtTick(223000),MIN_SQRT_RATIO+1n,10n**38n,10n**50n,500]);
  for(const input of cases) {
    const response=await rpc.call({to:address,data:encodeFunctionData({abi:artifact.abi,functionName:'step',args:input}),
      stateOverride:[{address,code:artifact.deployedBytecode.object}]});
    const expected=decodeFunctionResult({abi:artifact.abi,functionName:'step',data:response.data});
    const actual=swapStep(...input); assert.deepEqual([actual.price,actual.amountIn,actual.amountOut,actual.fee],expected);
    vectors.push({input,expected});
  }
  const fixture={upstream:'https://github.com/Uniswap/v3-core',commit,compiler:'0.7.6',method:'SwapMath.computeSwapStep via local EVM eth_call',vectors};
  await writeFile('test/fixtures/v3-research-swap-steps.json',JSON.stringify(fixture,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
  console.log(JSON.stringify({matched:vectors.length,commit}));
} finally {node.kill('SIGTERM');}
