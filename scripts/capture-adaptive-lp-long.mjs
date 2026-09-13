// Read-only, resumable, canonical log capture with exact DB comparison.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {createPublicClient,http,parseAbi,getAddress,decodeEventLog} from 'viem';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {v3PoolEventsAbi} from '../src/indexer/abi.ts';
const [envPath,root='data/adaptive-lp-long-study-2026-09-13']=process.argv.slice(2);assert(envPath);
const planRaw=readFileSync('notes/adaptive-lp-long-study-2026-09-13/plan.json'),plan=JSON.parse(planRaw);
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),db=new pg.Client({connectionString:e.DATABASE_URL});
const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const c=createPublicClient({transport:http(cfg.rpcUrl,{timeout:60000,retryCount:0,maxResponseBodySize:128*1024*1024,onFetchRequest:async()=>{await gate.assertBulkAllowed();}})});
const archive=createPublicClient({transport:http(e.RH_ARCHIVE_RPC_URL??cfg.rpcUrl,{timeout:60000,retryCount:0,onFetchRequest:async()=>{await gate.assertBulkAllowed();}})});
const abi=parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)','function liquidity() view returns(uint128)','function feeGrowthGlobal0X128() view returns(uint256)','function feeGrowthGlobal1X128() view returns(uint256)','function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)']);
const state=async(pool,block)=>{const r=await Promise.all(['slot0','liquidity','feeGrowthGlobal0X128','feeGrowthGlobal1X128'].map(functionName=>archive.readContract({address:getAddress(pool),abi,functionName,blockNumber:BigInt(block)})));return {price:String(r[0][0]),tick:r[0][1],liquidity:String(r[1]),global0:String(r[2]),global1:String(r[3]),protocol0:r[0][5]&15,protocol1:r[0][5]>>4};};
const header=async n=>{const b=await c.getBlock({blockNumber:BigInt(n)});return {number:Number(b.number),hash:b.hash,timestamp:Number(b.timestamp)};};
async function boundary(at){console.log(json({stage:'locating_boundary',at}));let lo=20889404,hi=61776927;const seconds=Date.parse(at)/1000;while(lo<hi){const mid=Math.floor((lo+hi)/2),b=await header(mid);if(b.timestamp<seconds)lo=mid+1;else hi=mid;}return lo;}
async function main(){
 mkdirSync(root+'/pages',{recursive:true});assert(!existsSync(root+'/completed.json'),'Capture already complete');await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='60s'");assert.equal(await c.getChainId(),4663);
 let meta;
 if(existsSync(root+'/capture.json')){meta=JSON.parse(readFileSync(root+'/capture.json'));assert.equal(meta.planSha256,hash(planRaw));}
 else{
  const start=(await boundary(plan.warmupFrom))-1,end=(await boundary(plan.to))-1;
  meta={planSha256:hash(planRaw),plan,start:await header(start),end:await header(end),assets:[],createdAt:new Date().toISOString(),pageBlocks:100000};
  meta.cursors=(await db.query('SELECT i.stream_key,i.last_scanned_block::text,r.complete_through_block::text,i.target_set_hash,r.target_set_hash AS replay_target FROM indexer_cursors i LEFT JOIN v3_replay_cursors r USING(stream_key) WHERE i.stream_key=$1',[cfg.streamKey])).rows;
  for(const symbol of plan.symbols){
   const oldRaw=readFileSync(`data/asset-expansion-2026-09-13/replay-source-${symbol}.json.gz`),old=JSON.parse(gunzipSync(oldRaw)),forkRaw=readFileSync(`data/asset-expansion-2026-09-13/fork-${symbol}.json`);
   assert.equal(hash(oldRaw),readFileSync(`data/asset-expansion-2026-09-13/replay-source-${symbol}.json.gz.sha256`,'utf8').trim());
   const pool=(await db.query('SELECT * FROM indexer_pools WHERE stream_key=$1 AND rwa_symbol=$2 AND fee=500 AND enabled',[cfg.streamKey,symbol])).rows;assert.equal(pool.length,1);const address=pool[0].pool_address;
   const before=await state(address,start),after=await state(address,end),ticks=new Map();
   const changes=(await db.query("SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index",[cfg.streamKey,address,start])).rows;
   for(const row of changes){const a=row.event_args,d=BigInt(a.amount)*(row.event_name==='Mint'?1n:-1n);for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=d;t.net+=d*sign;assert(t.gross>=0n);if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}}
   for(const [tick,t] of ticks){const onchain=await archive.readContract({address:getAddress(address),abi,functionName:'ticks',args:[tick],blockNumber:BigInt(start)});assert.equal(onchain[0],t.gross);assert.equal(onchain[1],t.net);}
   const seed={...before,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};new ExperimentMarket(seed);
   const costs=JSON.parse(readFileSync('notes/adaptive-lp-study-2026-09-13/manifest.json')).sources.find(s=>s.symbol===symbol).costs;
   meta.assets.push({symbol,pool:address,market:old.market,seed,after,costs,priorSourceSha256:hash(oldRaw),forkSha256:hash(forkRaw),costValuation:old.valuation,seedMintBurnEvents:changes.length,seedTicksVerified:ticks.size});
   console.log(json({stage:'seed_verified',symbol,ticks:ticks.size}));
  }
  writeFileSync(root+'/capture.json',json(meta)+'\n');
 }
 assert.equal((await header(meta.start.number)).hash,meta.start.hash);assert.equal((await header(meta.end.number)).hash,meta.end.hash);
 const books=new Map(meta.assets.map(a=>[a.symbol,new ExperimentMarket(a.seed)])),byPool=new Map(meta.assets.map(a=>[a.pool.toLowerCase(),a.symbol])),pages=[];let total=0,lastTime=0;
 for(let from=meta.start.number+1;from<=meta.end.number;from+=meta.pageBlocks){
  const to=Math.min(meta.end.number+1,from+meta.pageBlocks),path=root+`/pages/${from}-${to}.json.gz`;let page;
  if(existsSync(path)){const raw=readFileSync(path);assert.equal(hash(raw),readFileSync(path+'.sha256','utf8').trim());page=JSON.parse(gunzipSync(raw));}
  else{
   const anchor=await header(to-1);
   const logs=await c.request({method:'eth_getLogs',params:[{address:meta.assets.map(a=>a.pool),fromBlock:'0x'+from.toString(16),toBlock:'0x'+(to-1).toString(16)}]});
   const events=logs.map(l=>{assert(l.removed===false&&l.blockTimestamp,'Missing canonical log timestamp');const decoded=decodeEventLog({abi:v3PoolEventsAbi,data:l.data,topics:l.topics,strict:true});return {symbol:byPool.get(l.address.toLowerCase()),block:String(BigInt(l.blockNumber)),hash:l.blockHash,tx:Number(BigInt(l.transactionIndex)),log:Number(BigInt(l.logIndex)),name:decoded.eventName,args:decoded.args,at:Number(BigInt(l.blockTimestamp))*1000,transactionHash:l.transactionHash,rawData:l.data,rawTopics:l.topics};}).sort((a,b)=>Number(a.block)-Number(b.block)||a.tx-b.tx||a.log-b.log);
   assert.equal((await header(to-1)).hash,anchor.hash);
   if(events.length){const h=await header(Number(events[0].block));assert.equal(h.hash,events[0].hash);assert.equal(h.timestamp*1000,events[0].at);}
   page={from,toExclusive:to,anchor,events,provider:'canonical_private_rpc_with_blockTimestamp'};
   const raw=gzipSync(json(page));writeFileSync(path,raw);writeFileSync(path+'.sha256',hash(raw)+'\n');
  }
  assert.equal(page.from,from);assert.equal(page.toExclusive,to);
  const rows=(await db.query('SELECT pool_address,block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,transaction_hash,raw_data,raw_topics FROM v3_pool_events WHERE stream_key=$1 AND pool_address=ANY($2) AND block_number>=$3 AND block_number<$4 ORDER BY block_number,transaction_index,log_index',[cfg.streamKey,meta.assets.map(a=>a.pool),from,to])).rows;
  assert.equal(rows.length,page.events.length,'Canonical log and database counts differ');
  for(let i=0;i<rows.length;i++){const r=rows[i],v=page.events[i];assert.equal(byPool.get(r.pool_address.toLowerCase()),v.symbol);for(const k of ['block','hash','tx','log'])assert.equal(r[k],v[k]);assert.equal(r.transaction_hash,v.transactionHash);assert.equal(r.raw_data,v.rawData);assert.deepEqual(r.raw_topics,v.rawTopics);assert(v.at>=lastTime);lastTime=v.at;books.get(v.symbol).apply(v);}
  total+=rows.length;pages.push({file:`pages/${from}-${to}.json.gz`,from,toExclusive:to,events:rows.length,sha256:hash(readFileSync(path))});
  if(pages.length%5===0)console.log(json({stage:'verified_pages',pages:pages.length,through:to-1,events:total,at:new Date(lastTime).toISOString()}));
  await new Promise(resolve=>setTimeout(resolve,300));
 }
 for(const a of meta.assets){const b=books.get(a.symbol);b.verify(a.after);assert.equal(b.protocol0,a.after.protocol0);assert.equal(b.protocol1,a.after.protocol1);}
 assert.equal((await header(meta.end.number)).hash,meta.end.hash);
 writeFileSync(root+'/completed.json',json({planSha256:hash(planRaw),captureSha256:hash(readFileSync(root+'/capture.json')),pages,events:total,dbLogsExactMatch:true,canonicalEndsVerified:true,completedAt:new Date().toISOString()})+'\n');await db.query('COMMIT');console.log(json({stage:'complete',events:total,pages:pages.length}));
}
try{await main();}catch(error){console.error(JSON.stringify({failed:true,details:String(error.details??'').replace(/https?:\/\/\S+/g,'[redacted endpoint]'),message:String(error.shortMessage??error.message).replace(/https?:\/\/\S+/g,'[redacted endpoint]')}));process.exitCode=1;}finally{await db.end();await gate.close();}
