import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRobinhoodClient } from '../../src/client.ts';
import { loadIndexerConfig } from '../../src/indexer/config.ts';
import { PostgresRpcHealthGate } from '../../src/rpc-health/store.ts';
import { sanitizeRiskError } from '../../src/risk/evaluate.ts';
import { openPaperFork } from '../../src/paper/fork.ts';
import { simulatePaperExit } from '../../src/paper/execution-exit.ts';
const entry = JSON.parse(await readFile('data/paper-execution.json','utf8'));
const config=loadIndexerConfig();
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
let fork;
try {
  const live=createRobinhoodClient(config.rpcUrl,15000,{retryCount:0,beforeRequest:()=>gate.assertBulkAllowed().then(()=>{})});
  assert.equal(await live.getChainId(),4663);
  const block=await live.getBlock();
  assert(block.number>BigInt(entry.source.block));
  fork=await openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:config.rpcUrl,beforeRead:()=>gate.assertBulkAllowed().then(()=>{})});
  const result=await simulatePaperExit(fork,entry.policy,{
    liquidity:entry.liquidity,...entry.range,idle0:entry.balances.afterMint.quote,idle1:entry.balances.afterMint.rwa,
    fee0:'1234',fee1:'1000000000000',allowances:entry.allowances,
    nativeBalanceWei:String(10n**18n-BigInt(entry.entryGasWei)),
  },tx=>console.log(JSON.stringify({action:tx.action,gasWei:tx.estimate.totalFeeWei})));
  const evidence={purpose:'restoration correctness test; synthetic fee inputs, not a paper performance result',
    inputEntryBlock:entry.source.block,syntheticFee0:'1234',syntheticFee1:'1000000000000',result};
  await writeFile('data/paper-exit-validation.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({passed:true,entryBlock:entry.source.block,exitBlock:result.source.block,totalGasWei:result.totalGasWei,requests:fork.budget.requests}));
}catch(error){console.error(sanitizeRiskError(error));process.exitCode=1;}
finally{await fork?.close();await gate.close();}
