// Run from the repository root with node --import tsx. Read-only database access.
// An optional second environment-file argument can supply a candidate archive URL.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
import {getAddress,encodePacked,keccak256} from 'viem';
import {createRobinhoodClient} from '../../src/client.ts';
import {loadHistoryConfig,HISTORY_TRANSPORT_URL} from '../../src/history/client.ts';
import {createHyperSyncFetch} from '../../src/history/hypersync.ts';
import {replayPoolStateAbi,replayTickAbi,replayPositionAbi} from '../../src/replay/abi.ts';
import {PostgresAccountingSourceStore} from '../../src/accounting/source-store.ts';
import {collectFeeAccountingSnapshot} from '../../src/accounting/collector.ts';
process.loadEnvFile('.env');
process.loadEnvFile('/root/arb-robinhood/.env');
if (process.argv[2]) {
 const candidate=parseEnv(readFileSync(process.argv[2],'utf8')).RH_ARCHIVE_RPC_URL;
 if(!candidate) throw new Error('Candidate environment file must contain RH_ARCHIVE_RPC_URL');
 process.env.RH_ARCHIVE_RPC_URL=candidate;
}
const config=loadHistoryConfig(process.env.ROBINHOOD_READ_HTTP_URL,{...process.env,HISTORY_REQUEST_INTERVAL_MS:'500',ARCHIVE_REQUEST_INTERVAL_MS:'100'});
const stats={archiveRequests:0,hyperSyncRequests:0,privateRequests:0,httpErrors:0,rpcErrors:0};
const observedFetch=async(url,init)=>{
 if(String(url)===config.archiveUrl) stats.archiveRequests++;
 else if(new URL(String(url)).origin===new URL(config.historyUrl).origin) stats.hyperSyncRequests++;
 else {stats.privateRequests++;throw new Error('Unexpected provider');}
 const r=await fetch(url,init);
 if(!r.ok) stats.httpErrors++;
 if(r.ok && (await r.clone().json()).error) stats.rpcErrors++;
 return r;
};
const client=createRobinhoodClient(HISTORY_TRANSPORT_URL,60000,{fetchFn:createHyperSyncFetch(config,observedFetch),retryCount:0});
const db=new pg.Client({connectionString:process.env.DATABASE_URL,options:'-c default_transaction_read_only=on'});
const sourceStore=new PostgresAccountingSourceStore(process.env.DATABASE_URL);
const evidence={startedAt:new Date().toISOString(),provider:'alchemy',chainId:null,historicalComparisons:[],forwardSample:null,stats};
const key=p=>keccak256(encodePacked(['address','int24','int24'],[getAddress(p.owner_address),p.tick_lower,p.tick_upper]));
try {
 await db.connect();
 assert.equal(await client.getChainId(),4663);
 evidence.chainId=4663;
 const runs=(await db.query('SELECT * FROM v3_fee_accounting_runs WHERE id IN ((SELECT min(id) FROM v3_fee_accounting_runs),(SELECT max(id) FROM v3_fee_accounting_runs)) ORDER BY id')).rows;
 for(const run of runs){
  const blockNumber=BigInt(run.block_number);
  const block=await client.getBlock({blockNumber});
  assert.equal(block.hash.toLowerCase(),run.block_hash.toLowerCase());
  const ar=await observedFetch(config.archiveUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['0x'+blockNumber.toString(16),false]}),signal:AbortSignal.timeout(15000),redirect:'error'});
  assert.equal((await ar.json()).result.hash.toLowerCase(),run.block_hash.toLowerCase());
  const pools=(await db.query('SELECT * FROM v3_pool_fee_accounting WHERE run_id=$1 ORDER BY pool_address',[run.id])).rows;
  for(const p of pools){
   const read=functionName=>client.readContract({address:getAddress(p.pool_address),abi:replayPoolStateAbi,functionName,blockNumber});
   const slot=await read('slot0');
   assert.equal(slot[0],BigInt(p.sqrt_price_x96));assert.equal(slot[1],p.tick);
   for(const [fn,col] of [['liquidity','liquidity'],['feeGrowthGlobal0X128','fee_growth_global0_x128'],['feeGrowthGlobal1X128','fee_growth_global1_x128']]) assert.equal(await read(fn),BigInt(p[col]));
   for(const fn of ['token0','token1']) assert.equal((await read(fn)).toLowerCase(),p[fn]);
  }
  const ticks=(await db.query('SELECT DISTINCT ON (pool_address) * FROM v3_tick_fee_accounting WHERE run_id=$1 ORDER BY pool_address,tick',[run.id])).rows;
  for(const t of ticks){
   const r=await client.readContract({address:getAddress(t.pool_address),abi:replayTickAbi,functionName:'ticks',args:[t.tick],blockNumber});
   assert.deepEqual(r.slice(0,4),['liquidity_gross','liquidity_net','fee_growth_outside0_x128','fee_growth_outside1_x128'].map(k=>BigInt(t[k])));assert.equal(r[7],true);
  }
  const positions=(await db.query('SELECT DISTINCT ON (pool_address) * FROM v3_position_fee_accounting WHERE run_id=$1 ORDER BY pool_address,liquidity DESC,owner_address,tick_lower,tick_upper',[run.id])).rows;
  for(const p of positions){
   const r=await client.readContract({address:getAddress(p.pool_address),abi:replayPositionAbi,functionName:'positions',args:[key(p)],blockNumber});
   assert.deepEqual(r,['liquidity','fee_growth_inside0_last_x128','fee_growth_inside1_last_x128','tokens_owed0','tokens_owed1'].map(k=>BigInt(p[k])));
  }
  const result={runId:run.id,blockNumber:run.block_number,blockHash:run.block_hash,pools:pools.length,ticks:ticks.length,positions:positions.length,matched:true};
  evidence.historicalComparisons.push(result);console.log(JSON.stringify({historicalComparison:result}));
 }
 const source=await sourceStore.snapshot(process.env.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1');
 const positions=source.pools.map(pool=>source.positions.find(p=>p.poolAddress===pool.poolAddress&&p.liquidity>0n)).filter(Boolean);
 const required=new Set(positions.flatMap(p=>[`${p.poolAddress}:${p.tickLower}`,`${p.poolAddress}:${p.tickUpper}`]));
 const ticks=source.ticks.filter(t=>required.has(`${t.poolAddress}:${t.tick}`));
 const snapshot=await collectFeeAccountingSnapshot({client,concurrency:4,source:{...source,positions,ticks}});
 evidence.forwardSample={blockNumber:snapshot.blockNumber.toString(),blockHash:snapshot.blockHash,pools:snapshot.pools.length,ticks:snapshot.ticks.length,positions:snapshot.positions.length,matched:true,savedToDatabase:false};
 evidence.completedAt=new Date().toISOString();
 assert.equal(stats.privateRequests,0);assert.equal(stats.httpErrors,0);assert.equal(stats.rpcErrors,0);
 writeFileSync('notes/historical-evidence-2026-09-06/alchemy-state-validation.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify(evidence));
} catch(error){
 console.error(String(error.message).replaceAll(config.archiveUrl,'[archive]').replaceAll(process.env.ENVIO_API_TOKEN,'[token]'));
 process.exitCode=1;
} finally {await db.end();await sourceStore.close();}
