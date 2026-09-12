// Test existing-balance mode after synthetic funding on an owned fork.
// Nothing here funds or sends a transaction to the real chain.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {livePilotConfig} from '../src/live-pilot/config.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {openPaperFork} from '../src/paper/fork.ts';
import {createPaperExecutionContext,fundPaperFixture,simulatePaperRoundTrip} from '../src/paper/execution.ts';
import {solveRecenterSwap} from '../src/paper/execution-recenter.ts';
import {USDG} from '../src/constants.ts';
import {PAPER_NVDA,paperEntryRange} from '../src/paper/engine.ts';
const [envPath,readinessPath,output]=process.argv.slice(2);assert(envPath&&readinessPath&&output);
const pilot=livePilotConfig(JSON.parse(readFileSync('config/live-pilot-nvda-250.json')));assert(pilot.operator);
const runtimeEnv=parseEnv(readFileSync(envPath,'utf8'));
if(pilot.signer?.kind==='env_file'){delete runtimeEnv[pilot.signer.variable];delete process.env[pilot.signer.variable];}
Object.assign(process.env,runtimeEnv);process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const cp=JSON.parse(readFileSync(readinessPath)).checkpoint,config=loadIndexerConfig();
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{}),client=createRobinhoodClient(config.rpcUrl,config.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
let fork;
try {
 const block=await client.getBlock({blockNumber:BigInt(cp.block)});assert.equal(block.hash.toLowerCase(),cp.hash.toLowerCase());
 fork=await openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:config.rpcUrl,beforeRead,maxRequests:650,timeoutMs:240000});
 const context=await createPaperExecutionContext(fork,pilot.strategy,undefined,pilot.operator),range=paperEntryRange(cp,pilot.strategy);
 const budget=BigInt(pilot.initialCapitalQuote),extra=25000000n;
 const net=await solveRecenterSwap(context.sourceSlot[0],range,budget,0n,async(amount,token)=>{
  const q=await context.quoteSwap(token===0?USDG:PAPER_NVDA,token===0?PAPER_NVDA:USDG,amount);
  return {amountOut:BigInt(q.amountOut),price:BigInt(q.sqrtPriceAfter)};
 });assert.equal(net.token,0);
 await fundPaperFixture(context,{quote:budget+extra,rwa:0n});const seeded=await context.balances();
 const result=await simulatePaperRoundTrip(fork,pilot.strategy,undefined,{...range,swapAmountQuote:String(net.amount),minRwaOut:String(net.amountOut*9950n/10000n)},
  {account:pilot.operator,funding:'existing'});
 assert.deepEqual(result.balances.before,seeded,'Existing mode must not replace or reset wallet funding');
 assert.equal(result.reservedQuote,String(extra));assert(BigInt(result.balances.afterMint.quote)>=extra);
 assert(BigInt(result.balances.inventory.quote)-BigInt(result.minted0)>=extra);
 const raw=JSON.stringify({computedAt:new Date().toISOString(),scope:'synthetically_prefunded_operator_existing_balance_mode',executionEligible:false,
  checks:{preservedStartingBalances:true,extra25UsdgReserved:true,roundtrip:true},result,
  limitations:['275 USDG and 1 ETH were seeded only on the owned fork','No proof that the real wallet is funded']},null,2)+'\n';
 writeFileSync(output,raw,{flag:'wx'});writeFileSync(output+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});
 console.log(JSON.stringify({phase:'passed',account:pilot.operator,initialQuote:result.balances.before.quote,pilotBudget:pilot.initialCapitalQuote,reservedQuote:result.reservedQuote,gasWei:result.totalGasWei}));
}finally{await fork?.close();await gate.close();}
