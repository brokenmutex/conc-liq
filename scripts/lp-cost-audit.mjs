import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {NativeHyperSync} from '../src/history/hypersync.ts';
import {loadHistoryConfig} from '../src/history/client.ts';
import {classifyActionMix,evaluateActionCost,summarizeActionCosts} from '../src/action-cost/evaluate.ts';
import {decodeResearchActionPath} from '../src/research/action-path.ts';
import {NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.ts';

process.loadEnvFile('.env');
const output=process.argv[2];assert(output,'Usage: node --import tsx scripts/lp-cost-audit.mjs OUTPUT_DIRECTORY');
await mkdir(output,{recursive:true});
const source='data/lp-research-2026-09-07/source.jsonl.gz',timingPath='data/lp-research-2026-09-07/size-sweep-timestamps.json';
const timingText=await readFile(timingPath,'utf8'),timing=JSON.parse(timingText);
const plan={schemaVersion:1,executionEligible:false,fromBlock:timing.fromBlock,toBlock:timing.toBlock,sourceSha256:timing.sourceSha256,
 timestampSha256:createHash('sha256').update(timingText).digest('hex'),selection:'First ten chronological transactions per pool and non-swap action class; deduplicated across pools',maxPerPoolClass:10,
 methodology:'Canonical historical receipt costs and bounded complete manager calldata decoding',
 use:'Descriptive measurement audit, not an ex-ante cost model or an attribution of whole transaction fees to individual calls'};
await writeFile(`${output}/manifest.json`,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
const headers=new Map(timing.headers.map(h=>[h.number,h])),txs=new Map(),digest=createHash('sha256');let manifest,footer;
const input=createReadStream(source),unzip=createGunzip(),done=pipeline(input,unzip);done.catch(()=>{});
try { for await(const line of createInterface({input:unzip,crlfDelay:Infinity})) {
 digest.update(line+'\n');const row=JSON.parse(line);
 if(row.kind==='manifest')manifest=row.manifest;if(row.kind==='counts')footer=row.counts;
 if(row.kind!=='event')continue;const e=row.event,b=Number(e.block_number);if(b<timing.fromBlock||b>timing.toBlock)continue;
 assert.equal(headers.get(b)?.hash.toLowerCase(),e.block_hash.toLowerCase());
 let tx=txs.get(e.transaction_hash);if(!tx){tx={transactionHash:e.transaction_hash,blockNumber:BigInt(b),blockHash:e.block_hash,transactionIndex:e.transaction_index,chainId:4663,eventCounts:{},poolAddresses:[]};txs.set(e.transaction_hash,tx)}
 assert(tx.blockNumber===BigInt(b)&&tx.blockHash===e.block_hash&&tx.transactionIndex===e.transaction_index);
 tx.eventCounts[e.event_name]=(tx.eventCounts[e.event_name]??0)+1;if(!tx.poolAddresses.includes(e.pool_address))tx.poolAddresses.push(e.pool_address);
 } await done;
}finally{input.destroy();unzip.destroy()}
assert(manifest&&footer&&digest.digest('hex')===timing.sourceSha256);
const census={},selected=[],buckets={};
for(const tx of [...txs.values()].sort((a,b)=>Number(a.blockNumber-b.blockNumber)||a.transactionIndex-b.transactionIndex)) {
 tx.actionClass=classifyActionMix(tx.eventCounts);if(tx.actionClass==='swap_only')continue;let include=false;
 for(const pool of tx.poolAddresses){const key=`${pool}:${tx.actionClass}`;census[key]=(census[key]??0)+1;if((buckets[key]??0)<10){buckets[key]=(buckets[key]??0)+1;include=true}}
 if(include)selected.push(tx);
}
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
await writeFile(`${output}/selection.json`,stringify({census,selected}),{flag:'wx'});
const config=loadHistoryConfig(process.env.ROBINHOOD_READ_HTTP_URL??process.env.RH_RPC_URL??'https://rpc.mainnet.chain.robinhood.com');
const native=new NativeHyperSync(config),observations=[];
for(const candidate of selected){
 const raw=await native.transaction(candidate.transactionHash,candidate.blockNumber);
 const observation=evaluateActionCost({candidate,raw,observedAt:new Date().toISOString(),streamKey:manifest.stream});
 const managerCall=raw.to?.toLowerCase()===NONFUNGIBLE_POSITION_MANAGER.toLowerCase();
 const path=managerCall?decodeResearchActionPath(raw.input):null;
 observations.push({...observation,blockTimestamp:headers.get(Number(candidate.blockNumber)).timestamp,path,
  candidateForOurPath:!!path&&(path.simpleExit||path.simpleRecenter)&&candidate.poolAddresses.length===1&&(candidate.eventCounts.Swap??0)===0,
  comparableCostQuoteRaw:null,comparability:'Whole observed transaction cost; size and complete path comparability require further validation'});
 console.log(JSON.stringify({completed:observations.length,total:selected.length,actionClass:candidate.actionClass,path:path?.category??'external_call'}));
}
const result={manifest:plan,census,selectedTransactions:observations.length,summary:summarizeActionCosts(observations),observations,
 executionEligible:false,completeCostModel:false,conclusion:'Exact observed native-token receipt costs and decoded path candidates; no fabricated quote valuation or size-specific cost model'};
await writeFile(`${output}/receipts.json`,stringify(result),{flag:'wx'});
console.log(JSON.stringify({phase:'complete',selected:observations.length,pathCandidates:observations.filter(o=>o.candidateForOurPath).length}));
