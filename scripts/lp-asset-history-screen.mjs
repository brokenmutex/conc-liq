import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {decodeEventLog,toEventSelector,createPublicClient,http} from 'viem';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {loadHistoryConfig} from '../src/history/client.ts';
import {NativeHyperSync} from '../src/history/hypersync.ts';
import {v3PoolEventsAbi} from '../src/indexer/abi.ts';
import {marketSession} from '../src/paper/session-performance.ts';
import {marketRange} from '../src/paper/market.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
const dir=process.argv[2];assert(dir,'Usage: node --import tsx scripts/lp-asset-history-screen.mjs ARTIFACT_DIRECTORY [READ_ONLY_ENV]');
const e=parseEnv(readFileSync(process.argv[3]??'data/live-pilot-runtime.env','utf8')),cfg=loadIndexerConfig(e),h=new NativeHyperSync({...loadHistoryConfig(cfg.rpcUrl,e),requestIntervalMs:5000},async(url,init)=>{for(let attempt=0;;attempt++){const r=await fetch(url,init);if(![429,502,503,504].includes(r.status)||attempt>=10)return r;console.log(JSON.stringify({retry:attempt,status:r.status,retryAfter:r.headers.get('retry-after'),body:(await r.text()).slice(0,200)}));await new Promise(resolve=>setTimeout(resolve,Math.max(10000,Math.min(30000,Number(r.headers.get('retry-after')??2**attempt)*1000))));}}),c=createPublicClient({transport:http(cfg.rpcUrl,{timeout:60000,retryCount:0,maxResponseBodySize:128*1024*1024})});
const universeText=readFileSync(dir+'/universe.json','utf8'),u=JSON.parse(universeText),end=u.anchor.number;
u.rows=u.rows.filter(r=>!r.reasons.length);
const usePrivate=process.env.ASSET_SCREEN_SOURCE==='private_rpc';
const gate=usePrivate?new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:0,maxSampleAgeSeconds:30}):null;
try{
const folder=dir+(usePrivate?'/history-private':'/history-narrow');mkdirSync(folder,{recursive:true});
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x,2)+'\n';
const integer=x=>Number(typeof x==='string'&&x.startsWith('0x')?BigInt(x):x);
assert.equal((await c.getBlock({blockNumber:BigInt(end)})).hash,u.anchor.hash);
const target=u.anchor.timestamp-7*86400;let low=0,high=end;
while(low<high){const mid=Math.floor((low+high)/2),b=await c.getBlock({blockNumber:BigInt(mid)});if(integer(b.timestamp)<target)low=mid+1;else high=mid;}
const start=low,addresses=u.rows.map(r=>r.pool),byPool=new Map(u.rows.map(r=>[r.pool,r]));
const records=new Map(addresses.map(p=>[p,{swaps:0,turnover:0n,feeProxy:0n,minTick:null,maxTick:null,first:null,last:null,lastTick:null,absoluteTickMovement:0,crossings:0,unplaceableRangeSwaps:0,range:null,days:{},sessions:{},largestSwap:0n}]));
const pages=[];let total=0;const sessionCache=new Map();
for(let from=start;from<=end;from+=20000){
 const to=Math.min(end+1,from+20000),path=folder+`/${from}-${to}.json.gz`;let page;
 if(existsSync(path))page=JSON.parse(gunzipSync(readFileSync(path)).toString());else{
  if(usePrivate){
   await gate.assertBulkAllowed();const anchor=await c.getBlock({blockNumber:BigInt(to-1)});
   const raw=await c.request({method:'eth_getLogs',params:[{address:addresses,topics:[toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')],fromBlock:'0x'+from.toString(16),toBlock:'0x'+(to-1).toString(16)}]});
   const blocks=new Map();const logs=raw.map(l=>{assert(l.removed===false&&l.blockTimestamp,'Missing canonical log timestamp');const n=integer(l.blockNumber);assert(n>=from&&n<to);const header={number:n,hash:l.blockHash,timestamp:l.blockTimestamp};if(blocks.has(n))assert.deepEqual(blocks.get(n),header);blocks.set(n,header);return {address:l.address,block_number:n,block_hash:l.blockHash,transaction_hash:l.transactionHash,transaction_index:integer(l.transactionIndex),log_index:integer(l.logIndex),data:l.data,topic0:l.topics[0],topic1:l.topics[1],topic2:l.topics[2]};});
   assert.equal((await c.getBlock({blockNumber:BigInt(to-1)})).hash,anchor.hash);
   if(blocks.size){const first=blocks.values().next().value;const b=await c.getBlock({blockNumber:BigInt(first.number)});assert.equal(b.hash,first.hash);assert.equal(Number(b.timestamp),integer(first.timestamp));}
   page={blocks:[...blocks.values()],logs,transactions:[],provider:'private_rpc_canonical_logs_with_blockTimestamp',anchor:{block:String(anchor.number),hash:anchor.hash}};
   await new Promise(resolve=>setTimeout(resolve,1000));
  }else page=await h.query(from,to,{logs:[{address:addresses,topics:[[toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)')]]}],field_selection:{block:['number','hash','timestamp'],log:['address','block_number','block_hash','transaction_hash','transaction_index','log_index','data','topic0','topic1','topic2','topic3']}});
  writeFileSync(path,gzipSync(JSON.stringify(page)));
 }
 const headers=new Map(page.blocks.map(b=>[integer(b.number),b]));
 const logs=page.logs.sort((a,b)=>integer(a.block_number)-integer(b.block_number)||integer(a.transaction_index)-integer(b.transaction_index)||integer(a.log_index)-integer(b.log_index));
 let previousKey=null;
 for(const l of logs){
  const block=integer(l.block_number),head=headers.get(block);assert(head&&block>=from&&block<to);if(l.block_hash)assert.equal(l.block_hash.toLowerCase(),head.hash.toLowerCase());
  const key=`${block}/${l.transaction_index}/${l.log_index}`;assert.notEqual(key,previousKey,'Duplicate log');previousKey=key;
  const p=byPool.get(l.address.toLowerCase());assert(p);const r=records.get(p.pool),time=integer(head.timestamp),day=new Date(time*1000).toISOString().slice(0,10),session=sessionCache.get(Math.floor(time/60))??marketSession(time*1000).group;sessionCache.set(Math.floor(time/60),session);
  const args=decodeEventLog({abi:v3PoolEventsAbi,eventName:'Swap',data:l.data,topics:[l.topic0,l.topic1,l.topic2].filter(Boolean),strict:true}).args;
  const raw=p.token0==='0x5fc5360d0400a0fd4f2af552add042d716f1d168'?args.amount0:args.amount1,turnover=raw<0n?-raw:raw,fee=turnover*BigInt(p.fee)/1000000n;
  const add=b=>{b.swaps++;b.turnover+=turnover;b.feeProxy+=fee};add(r);add(r.days[day]??={swaps:0,turnover:0n,feeProxy:0n});add(r.sessions[session]??={swaps:0,turnover:0n,feeProxy:0n});
  r.first??=time;r.last=time;r.minTick=r.minTick===null?args.tick:Math.min(r.minTick,args.tick);r.maxTick=r.maxTick===null?args.tick:Math.max(r.maxTick,args.tick);r.largestSwap=r.largestSwap>turnover?r.largestSwap:turnover;
  if(r.lastTick!==null)r.absoluteTickMovement+=Math.abs(args.tick-r.lastTick);r.lastTick=args.tick;
  if(40%p.spacing===0){if(r.range&&(args.tick<r.range.lower||args.tick>=r.range.upper)){r.crossings++;r.range=null;}if(!r.range){try{const range=marketRange(args.sqrtPriceX96,args.tick,20,p.spacing);r.range={lower:range.tickLower,upper:range.tickUpper};}catch{r.unplaceableRangeSwaps++;}}}
 }
 total+=logs.length;pages.push({from,toExclusive:to,logs:logs.length,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
 if(pages.length%10===0)console.log(json({pages:pages.length,through:to-1,totalSwaps:total}).trim());
}
assert.equal((await c.getBlock({blockNumber:BigInt(end)})).hash,u.anchor.hash);
const rows=u.rows.map(p=>{
 const r=records.get(p.pool);const potential=p.sharePpm===null?null:r.feeProxy*BigInt(p.sharePpm)/1000000n;
 const eligible=p.reasons.length===0&&r.swaps>0&&p.entryQuote?.shortfallPpm!==undefined&&BigInt(p.entryQuote.shortfallPpm??'1000000')<=5000n;
 return {...p,history:{...r,range:undefined,lastTick:undefined},screenFeeProxyQuote:potential,screenFeePerCrossingQuote:potential===null?null:potential/BigInt(r.crossings+1),deepReplayCandidate:eligible,
  screenReasons:[...p.reasons,...(r.swaps===0?['no_swaps_in_screen_window']:[]),...(p.entryQuote?.shortfallPpm&&BigInt(p.entryQuote.shortfallPpm)>5000n?['buy_probe_exceeds_50_bps_slippage']:[])]};
}).sort((a,b)=>Number(BigInt(b.screenFeePerCrossingQuote??0)-BigInt(a.screenFeePerCrossingQuote??0)));
const out={version:1,computedAt:new Date().toISOString(),budgetQuote:'5000000000',halfWidthTicks:20,fromBlock:start,toBlock:end,fromTimestamp:target,toTimestamp:u.anchor.timestamp,universeSha256:createHash('sha256').update(universeText).digest('hex'),pages,totalSwaps:total,rows,
 limitations:['Descriptive historical activity only; not net LP returns or a deployment ranking.','Fee proxy is absolute USDG swap turnover times fee tier, valued in USDG without assuming its USD peg.','Position income proxy uses current liquidity share, not historical range-clipped earning segments.','Crossings assume immediate recentering at each observed swap; no execution delays or costs.','First/last partial days must not be treated as full days; multiple pools for the same asset are separate.','Current zero liquidity is an entry screen, not proof of historical inactivity.'],executionEligible:false};
writeFileSync(dir+'/history-screen.json',json(out));console.log(json({totalSwaps:total,candidates:rows.filter(r=>r.deepReplayCandidate).map(r=>({symbol:r.symbol,pool:r.pool,swaps:r.history.swaps,crossings:r.history.crossings,sharePpm:r.sharePpm}))}));

}finally{await gate?.close();}
