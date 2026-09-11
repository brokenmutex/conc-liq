// Read-only historical RPC, owned local Anvil writes. No paper DB mutations.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {openPaperFork} from '../src/paper/fork.ts';
import {quotePaperRecenter,simulatePaperRecenter} from '../src/paper/execution-recenter.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
const [envPath,output,direction='sell']=process.argv.slice(2);assert(envPath&&output&&['buy','sell'].includes(direction));
Object.assign(process.env,parseEnv(readFileSync(envPath,'utf8')));
process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const config=loadIndexerConfig(),policy=JSON.parse(readFileSync('config/paper-nvda-5000-recenter-offhours.json'));
const saved=JSON.parse(readFileSync('test/fixtures/paper-state-rejected-exit-recovery.json'));
const inventory={...saved.previous.position,allowances:saved.previous.execution.allowances,nativeBalanceWei:'1000000000000000000'};
// Scale the recorded holding to approximately the requested 5k deployment.
// This is a mechanics probe, not the new campaign's funding or earnings.
for(const key of ['liquidity','idle0','idle1','fee0','fee1'])inventory[key]=String(BigInt(inventory[key])*5n);
if(direction==='buy')Object.assign(inventory,{tickLower:222500,tickUpper:222540,liquidity:'1000',idle0:'5000000000',idle1:'0',fee0:'0',fee1:'0'});
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{});
const client=createRobinhoodClient(config.rpcUrl,config.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
let fork;const results=[];
try{
 const source=await client.getBlock({blockNumber:BigInt(saved.input.checkpoint.block)});
 const quoteSource=await client.getBlock({blockNumber:source.number-1n});
 const open=block=>openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:config.rpcUrl,beforeRead,maxRequests:600});
 fork=await open(quoteSource);
 const intent=await quotePaperRecenter(fork,policy,inventory);
 console.log(JSON.stringify({phase:'quote',source:intent.sourceBlock,token:intent.token,amountIn:intent.amountIn,range:[intent.tickLower,intent.tickUpper],requests:fork.budget.requests}));
 await fork.close();fork=await open(source);
 const result=await simulatePaperRecenter(fork,policy,inventory,intent);
 results.push({intent,result});
 console.log(JSON.stringify({phase:'fill',source:result.source.block,transactions:result.transactions.length,exitPreviewTransactions:result.exitPreviewTransactions.length,gasWei:result.totalGasWei,exitReserveWei:result.exitGasWei,requests:fork.budget.requests}));
 const text=JSON.stringify({computedAt:new Date().toISOString(),scope:'historical_two_source_recenter_mechanics',direction,executionEligible:false,results},null,2)+'\n';
 writeFileSync(output,text,{flag:'wx'});writeFileSync(output+'.sha256',createHash('sha256').update(text).digest('hex')+'\n',{flag:'wx'});
}finally{await fork?.close();await gate.close();}
