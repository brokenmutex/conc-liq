// Two-source mechanical rehearsal with synthetic ~$250 one-sided inventory.
// Upstream reads are pinned; only the owned local Anvil receives transactions.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {openPaperFork} from '../src/paper/fork.ts';
import {quotePaperRecenter,simulatePaperRecenter} from '../src/paper/execution-recenter.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {livePilotConfig} from '../src/live-pilot/config.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.ts';
import {PAPER_NVDA} from '../src/paper/engine.ts';
import {PAPER_ROUTER} from '../src/paper/execution-abi.ts';
const [envPath,readinessPath,output,direction]=process.argv.slice(2);
assert(envPath&&readinessPath&&output&&['buy','sell'].includes(direction),'Usage: ENV READINESS_JSON OUTPUT_JSON buy|sell');
Object.assign(process.env,parseEnv(readFileSync(envPath,'utf8')));process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const config=loadIndexerConfig(),policy=livePilotConfig(JSON.parse(readFileSync('config/live-pilot-nvda-250.json'))).strategy;
const cp=JSON.parse(readFileSync(readinessPath)).checkpoint,center=Math.floor(cp.tick/10)*10;
const price=BigInt(cp.sqrtPriceX96),cash=BigInt(policy.budgetQuote)-1n;
const lower=direction==='buy'?center+100:center-100;
const inventory={tickLower:lower,tickUpper:lower+40,liquidity:'1000',
 idle0:direction==='buy'?String(cash):'0',idle1:direction==='sell'?String(cash*price*price/(1n<<192n)):'0',
 fee0:'0',fee1:'0',allowances:[USDG,PAPER_NVDA].flatMap(token=>[PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].map(spender=>({token,spender,amount:'0'}))),nativeBalanceWei:'1000000000000000000'};
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{});
const client=createRobinhoodClient(config.rpcUrl,config.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
let fork;
try{
 const source=await client.getBlock({blockNumber:BigInt(cp.block)});assert.equal(source.hash.toLowerCase(),cp.hash.toLowerCase());
 const previous=await client.getBlock({blockNumber:source.number-1n});
 const open=block=>openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:config.rpcUrl,beforeRead,maxRequests:650,timeoutMs:240000});
 fork=await open(previous);const intent=await quotePaperRecenter(fork,policy,inventory);
 assert.equal(intent.token,direction==='buy'?0:1);
 console.log(JSON.stringify({phase:'quoted',direction,source:intent.sourceBlock,amountIn:intent.amountIn}));
 await fork.close();fork=await open(source);
 const result=await simulatePaperRecenter(fork,policy,inventory,intent);
 const raw=JSON.stringify({computedAt:new Date().toISOString(),scope:'synthetic_250_two_source_recenter_mechanics',executionEligible:false,
  direction,inventory,intent,result,limitations:['Synthetic inventory restored on owned fork; no real custody or forward earnings','One-block delay does not cover pending/revert/reorg recovery']},null,2)+'\n';
 writeFileSync(output,raw,{flag:'wx'});writeFileSync(output+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});
 console.log(JSON.stringify({phase:'passed',direction,transactions:result.transactions.length,gasWei:result.totalGasWei,exitReserveWei:result.exitGasWei}));
}finally{await fork?.close();await gate.close();}
