// Read-only canonical capture. Late-created pools remain unavailable until their verified seed block.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {createPublicClient,http,parseAbi,getAddress,decodeEventLog,toEventSelector} from 'viem';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {v3PoolEventsAbi} from '../src/indexer/abi.ts';
const [envPath,root='data/adaptive-lp-universe-study-2026-09-13']=process.argv.slice(2);assert(envPath);
const planPath='notes/adaptive-lp-universe-study-2026-09-13/plan.json',planRaw=readFileSync(planPath),plan=JSON.parse(planRaw);
const hash=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v),read=p=>JSON.parse(readFileSync(p));
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),db=new pg.Client({connectionString:e.DATABASE_URL});
const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const transport=url=>http(url,{timeout:60000,retryCount:0,maxResponseBodySize:128*1024*1024,onFetchRequest:async()=>{await gate.assertBulkAllowed();}});
const c=createPublicClient({transport:transport(cfg.rpcUrl)}),archive=createPublicClient({transport:transport(e.RH_ARCHIVE_RPC_URL??cfg.rpcUrl)});
const abi=parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)','function liquidity() view returns(uint128)','function feeGrowthGlobal0X128() view returns(uint256)','function feeGrowthGlobal1X128() view returns(uint256)','function ticks(int24) view returns(uint128,int128,uint256,uint256,int56,uint160,uint32,bool)']);
const state=async(pool,block)=>{const r=await Promise.all(['slot0','liquidity','feeGrowthGlobal0X128','feeGrowthGlobal1X128'].map(functionName=>archive.readContract({address:getAddress(pool),abi,functionName,blockNumber:BigInt(block)})));return {price:String(r[0][0]),tick:r[0][1],liquidity:String(r[1]),global0:String(r[2]),global1:String(r[3]),protocol0:r[0][5]&15,protocol1:r[0][5]>>4};};
const header=async n=>{const b=await c.getBlock({blockNumber:BigInt(n)});return {number:Number(b.number),hash:b.hash,timestamp:Number(b.timestamp)};};
const frozenRoot='data/asset-expansion-2026-09-13',frozenRaw=readFileSync(frozenRoot+'/history-screen.json'),frozen=JSON.parse(frozenRaw);assert.equal(hash(frozenRaw),plan.sourceHashes[frozenRoot+'/history-screen.json']);
const frozenPageCache=new Map(),frozenPagesUsed=new Map(),nonSwapTopics=v3PoolEventsAbi.filter(a=>a.type==='event'&&a.name!=='Swap').map(a=>toEventSelector(a));
function frozenSwaps(addresses,from,to){const allowed=new Set(addresses.map(a=>a.toLowerCase())),out=[];let covered=from;
 for(const p of frozen.pages){if(p.toExclusive<=from||p.from>to)continue;assert(p.from<=covered&&p.toExclusive>covered);covered=p.toExclusive;const file=`history-private/${p.from}-${p.toExclusive}.json.gz`;let page=frozenPageCache.get(file);
  if(!page){const raw=readFileSync(frozenRoot+'/'+file);assert.equal(hash(raw),p.sha256);page=JSON.parse(gunzipSync(raw));frozenPageCache.set(file,page);if(frozenPageCache.size>12)frozenPageCache.delete(frozenPageCache.keys().next().value);}frozenPagesUsed.set(file,p.sha256);
  const blocks=new Map(page.blocks.map(b=>[Number(b.number),b]));for(const l of page.logs){const n=Number(l.block_number);if(n<from||n>to||!allowed.has(l.address.toLowerCase()))continue;const b=blocks.get(n);assert(b);assert.equal(l.block_hash,b.hash);out.push({address:l.address,blockNumber:'0x'+n.toString(16),blockHash:b.hash,blockTimestamp:b.timestamp,transactionHash:l.transaction_hash,transactionIndex:'0x'+Number(l.transaction_index).toString(16),logIndex:'0x'+Number(l.log_index).toString(16),data:l.data,topics:[l.topic0,l.topic1,l.topic2,l.topic3].filter(Boolean),removed:false});}
 }assert(covered>to,'Frozen swap pages do not cover request');return out;
}
const logs=async(address,from,to,topics)=>{if(!topics&&from>=frozen.fromBlock&&to<=frozen.toBlock)return [...frozenSwaps(address,from,to),...await logs(address,from,to,[nonSwapTopics])];if(to-from>=25000){const result=[];for(let b=from;b<=to;b+=25000)result.push(...await logs(address,b,Math.min(to,b+24999),topics));return result;}await gate.assertBulkAllowed();try{return await c.request({method:'eth_getLogs',params:[{address,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),...(topics?{topics}: {})}]});}catch(error){
 const detail=String(error.details??'')+' '+String(error.shortMessage??'');if(to-from<5000||!/(terminated|timed out|HTTP request failed|response.*(large|size))/i.test(detail))throw error;
 console.log(json({stage:'split_interrupted_log_request',from,to}));const mid=Math.floor((from+to)/2),left=await logs(address,from,mid,topics),right=await logs(address,mid+1,to,topics);return [...left,...right];}};
const decode=l=>{assert(l.removed===false&&l.blockTimestamp,'Missing canonical log timestamp');const d=decodeEventLog({abi:v3PoolEventsAbi,data:l.data,topics:l.topics,strict:true});return {pool:l.address.toLowerCase(),block:String(BigInt(l.blockNumber)),hash:l.blockHash,tx:Number(BigInt(l.transactionIndex)),log:Number(BigInt(l.logIndex)),name:d.eventName,args:d.args,at:Number(BigInt(l.blockTimestamp))*1000,transactionHash:l.transactionHash,rawData:l.data,rawTopics:l.topics};};
const ordered=(a,b)=>Number(a.block)-Number(b.block)||a.tx-b.tx||a.log-b.log;
async function main(){
 mkdirSync(root+'/pages',{recursive:true});mkdirSync(root+'/seed-pages',{recursive:true});assert(!existsSync(root+'/completed.json'));await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL statement_timeout='60s'");assert.equal(await c.getChainId(),4663);
 let meta;
 if(existsSync(root+'/capture.json')){meta=read(root+'/capture.json');assert.equal(meta.planSha256,hash(planRaw));}
 else{
  const old=read('data/adaptive-lp-long-study-2026-09-13/capture.json');assert.equal(old.plan.warmupFrom,plan.warmupFrom);assert.equal(old.plan.to,plan.to);
  assert.equal((await header(old.start.number)).hash,old.start.hash);assert.equal((await header(old.end.number)).hash,old.end.hash);
  const u=read(root+'/universe.json');const pools=plan.symbols.map(symbol=>{const p=u.rows.find(p=>p.symbol===symbol&&p.fee===500);assert(p);return p;});
  const addresses=pools.map(p=>p.pool),initPath=root+'/initializations.json';
  if(!existsSync(initPath)){const ev=[];for(const pool of pools){for(let from=pool.createdBlock;from<=old.end.number;from+=100000){const to=Math.min(old.end.number,from+99999),p=root+`/seed-pages/init-${pool.symbol}-${from}-${to}.json`;if(!existsSync(p))writeFileSync(p,json((await logs([pool.pool],from,to,[toEventSelector('Initialize(uint160,int24)')])).map(decode))+'\n');const found=read(p);ev.push(...found);if(found.length)break;}console.log(json({stage:'initialization',symbol:pool.symbol,found:ev.length}));}ev.sort(ordered);writeFileSync(initPath,json(ev)+'\n');}
  const initializations=read(initPath);assert.equal(initializations.length,pools.length);
  const seedEnd=Math.max(old.start.number,...initializations.map(x=>Number(x.block)));
  const ticks=new Map(pools.map(p=>[p.pool,new Map()])),seedBlocks=new Map(pools.map(p=>[p.pool,Math.max(old.start.number,Number(initializations.find(i=>i.pool===p.pool).block))]));
  const seedPages=[];
  for(let from=Math.min(...pools.map(p=>p.createdBlock));from<=seedEnd;from+=100000){const to=Math.min(seedEnd,from+99999),path=root+`/seed-pages/${from}-${to}.json.gz`;let events;
   if(existsSync(path)){assert.equal(hash(readFileSync(path)),readFileSync(path+'.sha256','utf8').trim());events=JSON.parse(gunzipSync(readFileSync(path)));}
   else{const active=pools.filter(p=>p.createdBlock<=to&&seedBlocks.get(p.pool)>=from).map(p=>p.pool);events=(active.length?await logs(active,from,to,[[toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)'),toEventSelector('Burn(address,int24,int24,uint128,uint256,uint256)')]]):[]).map(decode).sort(ordered);const raw=gzipSync(json(events));writeFileSync(path,raw);writeFileSync(path+'.sha256',hash(raw)+'\n');}
   for(const v of events){if(Number(v.block)>seedBlocks.get(v.pool))continue;const book=ticks.get(v.pool),a=v.args,d=BigInt(a.amount)*(v.name==='Mint'?1n:-1n);for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){const t=book.get(tick)??{gross:0n,net:0n};t.gross+=d;t.net+=d*sign;assert(t.gross>=0n);if(t.gross===0n){assert.equal(t.net,0n);book.delete(tick);}else book.set(tick,t);}}
   if(seedPages.length%20===0)console.log(json({stage:'seed_changes',through:to}));seedPages.push({file:`seed-pages/${from}-${to}.json.gz`,sha256:hash(readFileSync(path)),events:events.length});
  }
  const indexed=(await db.query('SELECT rwa_symbol,pool_address FROM indexer_pools WHERE stream_key=$1 AND fee=500 AND enabled',[cfg.streamKey])).rows;
  meta={planPath,planSha256:hash(planRaw),plan,start:old.start,end:old.end,assets:[],pageBlocks:100000,seedPages,initializationsSha256:hash(readFileSync(initPath)),createdAt:new Date().toISOString()};
  for(const p of pools){const seedBlock=seedBlocks.get(p.pool),before=await state(p.pool,seedBlock),after=await state(p.pool,old.end.number),ts=ticks.get(p.pool);assert(BigInt(before.price)>0n);
   for(const [tick,t] of ts){const a=await archive.readContract({address:getAddress(p.pool),abi,functionName:'ticks',args:[tick],blockNumber:BigInt(seedBlock)});assert.equal(a[0],t.gross);assert.equal(a[1],t.net);}
   const seed={...before,ticks:[...ts].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};new ExperimentMarket(seed);
   const dbPool=indexed.find(a=>a.pool_address.toLowerCase()===p.pool)?.pool_address??null;
   meta.assets.push({symbol:p.symbol,pool:p.pool,market:{symbol:p.symbol,rwa:getAddress(p.address),pool:getAddress(p.pool),fee:500,tickSpacing:p.spacing,rwaDecimals:p.decimals},seedBlock,seedHeader:await header(seedBlock),initialization:initializations.find(i=>i.pool===p.pool),seed,after,dbPool,seedTicksVerified:ts.size});
   console.log(json({stage:'seed_verified',symbol:p.symbol,seedBlock,ticks:ts.size,dbCrossCheck:!!dbPool}));
  }
  writeFileSync(root+'/capture.json',json(meta)+'\n');
 }
 const books=new Map(meta.assets.map(a=>[a.symbol,new ExperimentMarket(a.seed)])),byPool=new Map(meta.assets.map(a=>[a.pool,a])),pages=[];let total=0,dbTotal=0,lastTime=0;
 const pendingFetch=new Map();
 async function fetchPage(from){const to=Math.min(meta.end.number+1,from+meta.pageBlocks),anchor=await header(to-1),events=(await logs(meta.assets.map(a=>a.pool),from,to-1)).map(decode).map(v=>({...v,symbol:byPool.get(v.pool).symbol})).sort(ordered);assert.equal((await header(to-1)).hash,anchor.hash);if(events.length){const h=await header(Number(events[0].block));assert.equal(h.hash,events[0].hash);assert.equal(h.timestamp*1000,events[0].at);}return {from,toExclusive:to,anchor,events,provider:'canonical_rpc_with_hash_verified_frozen_swaps_when_covered'};}
 function prefetch(from){const to=Math.min(meta.end.number+1,from+meta.pageBlocks);if(from<=meta.end.number&&!existsSync(root+`/pages/${from}-${to}.json.gz`)&&!pendingFetch.has(from))pendingFetch.set(from,fetchPage(from).then(page=>({page}),error=>({error})));}
 for(let from=meta.start.number+1;from<=meta.end.number;from+=meta.pageBlocks){
  const to=Math.min(meta.end.number+1,from+meta.pageBlocks),path=root+`/pages/${from}-${to}.json.gz`;let page;const cached=existsSync(path);prefetch(from);prefetch(from+meta.pageBlocks);
  if(existsSync(path)){assert.equal(hash(readFileSync(path)),readFileSync(path+'.sha256','utf8').trim());page=JSON.parse(gunzipSync(readFileSync(path)));}
  else{const fetched=await pendingFetch.get(from);pendingFetch.delete(from);if(fetched.error)throw fetched.error;page=fetched.page;const raw=gzipSync(json(page));writeFileSync(path,raw);writeFileSync(path+'.sha256',hash(raw)+'\n');}
  assert.equal(page.from,from);assert.equal(page.toExclusive,to);
  const rows=(await db.query('SELECT pool_address,block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,transaction_hash,raw_data,raw_topics FROM v3_pool_events WHERE stream_key=$1 AND pool_address=ANY($2) AND block_number>=$3 AND block_number<$4 ORDER BY block_number,transaction_index,log_index',[cfg.streamKey,meta.assets.flatMap(a=>a.dbPool?[a.dbPool]:[]),from,to])).rows;
  const comparable=page.events.filter(v=>byPool.get(v.pool).dbPool);assert.equal(rows.length,comparable.length,'Indexed pool canonical and DB counts differ');
  for(let i=0;i<rows.length;i++){const r=rows[i],v=comparable[i];assert.equal(r.pool_address.toLowerCase(),v.pool);for(const k of ['block','hash','tx','log'])assert.equal(r[k],v[k]);assert.equal(r.transaction_hash,v.transactionHash);assert.equal(r.raw_data,v.rawData);assert.deepEqual(r.raw_topics,v.rawTopics);}
  for(let i=0;i<page.events.length;i++){const v=page.events[i];assert(v.at>=lastTime);lastTime=v.at;if(i)assert(ordered(page.events[i-1],v)<0,'Unordered or duplicate event');if(Number(v.block)>byPool.get(v.pool).seedBlock)books.get(v.symbol).apply(v);}
  total+=page.events.length;dbTotal+=rows.length;pages.push({file:`pages/${from}-${to}.json.gz`,from,toExclusive:to,events:page.events.length,dbComparedEvents:rows.length,sha256:hash(readFileSync(path))});
  if(pages.length%5===0)console.log(json({stage:'verified_pages',pages:pages.length,through:to-1,events:total}));
  if(!cached)await new Promise(resolve=>setTimeout(resolve,300));
 }
 for(const a of meta.assets){const b=books.get(a.symbol);b.verify(a.after);assert.equal(b.protocol0,a.after.protocol0);assert.equal(b.protocol1,a.after.protocol1);}
 assert.equal((await header(meta.end.number)).hash,meta.end.hash);
 writeFileSync(root+'/completed.json',json({planSha256:hash(planRaw),captureSha256:hash(readFileSync(root+'/capture.json')),pages,events:total,dbComparedEvents:dbTotal,dbComparedSymbols:meta.assets.filter(a=>a.dbPool).map(a=>a.symbol),indexedDbLogsExactMatch:true,canonicalEndsVerified:true,frozenSwapSource:{historySha256:hash(frozenRaw),pagesUsed:Object.fromEntries(frozenPagesUsed)},completedAt:new Date().toISOString()})+'\n');await db.query('COMMIT');console.log(json({stage:'complete',events:total,pages:pages.length}));
}
try{await main();}catch(error){console.error(json({failed:true,details:String(error.details??'').replace(/https?:\/\/\S+/g,'[redacted endpoint]'),message:String(error.shortMessage??error.message).replace(/https?:\/\/\S+/g,'[redacted endpoint]')}));process.exitCode=1;}finally{await db.end();await gate.close();}
