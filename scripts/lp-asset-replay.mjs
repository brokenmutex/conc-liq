// Frozen conditional replay: canonical historical depth and fees, current fork cost scenarios.
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';import {gzipSync,gunzipSync} from 'node:zlib';import {parseEnv} from 'node:util';import {createHash} from 'node:crypto';import pg from 'pg';import {parseAbi,getAddress} from 'viem';
import {createRobinhoodClient} from '../src/client.ts';import {loadIndexerConfig} from '../src/indexer/config.ts';import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';import {ExperimentMarket} from '../src/experiment/market.ts';import {AssetReplay} from '../src/research/asset-replay.ts';import {paperGasQuote} from '../src/paper/transaction-engine.ts';import {fetchFeedDirectory,selectOracleFeed} from '../src/risk/source.ts';import {loadRiskConfig} from '../src/risk/config.ts';import {ViemRiskChainReader} from '../src/risk/reader.ts';
const [envPath,dir,mode='capture']=process.argv.slice(2);assert(envPath&&dir&&['capture','replay'].includes(mode));
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),u=JSON.parse(readFileSync(dir+'/universe.json')),history=JSON.parse(readFileSync(dir+'/history-screen.json')),start=history.fromBlock-1,end=history.toBlock;
assert.equal(end,u.anchor.number,'History anchor differs from universe');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);const digest=x=>createHash('sha256').update(x).digest('hex');
if(mode==='capture'){
 const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30}),client=createRobinhoodClient(cfg.rpcUrl,20000,{beforeRequest:()=>gate.assertBulkAllowed().then(()=>{})}),db=new pg.Client({connectionString:e.DATABASE_URL});await db.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const cursor=(await db.query('SELECT i.last_scanned_block,r.complete_through_block,i.target_set_hash,r.target_set_hash AS replay_target FROM indexer_cursors i JOIN v3_replay_cursors r USING(stream_key) WHERE stream_key=$1',[cfg.streamKey])).rows[0];assert(cursor&&BigInt(cursor.last_scanned_block)>=BigInt(end)&&BigInt(cursor.complete_through_block)>=BigInt(end)&&cursor.target_set_hash===cursor.replay_target,JSON.stringify({cursor,stream:cfg.streamKey,end}));
  const abi=parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)','function liquidity() view returns(uint128)','function feeGrowthGlobal0X128() view returns(uint256)','function feeGrowthGlobal1X128() view returns(uint256)']);
  const directory=await fetchFeedDirectory(loadRiskConfig(e).feedDirectoryUrl,20000),reader=new ViemRiskChainReader(client),eth=await reader.readOracle(selectOracleFeed(directory.payload,'ETH').address,BigInt(end)),usd=await reader.readOracle(selectOracleFeed(directory.payload,'USDG').address,BigInt(end));
  assert(eth.answer>0n&&usd.answer>0n);const valuation={ethUsdAnswer:String(eth.answer),ethUsdDecimals:eth.decimals,quoteUsdAnswer:String(usd.answer),quoteUsdDecimals:usd.decimals,sourceBlock:String(end),sourceHash:u.anchor.hash,computedAt:new Date().toISOString()};
  for(const symbol of ['AAPL','GOOGL']){
   const p=u.rows.find(p=>p.symbol===symbol&&p.fee===500),pool=(await db.query('SELECT * FROM indexer_pools WHERE stream_key=$1 AND lower(pool_address)=$2',[cfg.streamKey,p.pool])).rows[0];assert(pool&&pool.rwa_address.toLowerCase()===p.address);
   const state=async block=>{const r=await Promise.all(['slot0','liquidity','feeGrowthGlobal0X128','feeGrowthGlobal1X128'].map(functionName=>client.readContract({address:getAddress(p.pool),abi,functionName,blockNumber:BigInt(block)})));return {price:String(r[0][0]),tick:r[0][1],liquidity:String(r[1]),global0:String(r[2]),global1:String(r[3]),protocol0:r[0][5]&15,protocol1:r[0][5]>>4};};
   const before=await state(start),after=await state(end),ticks=new Map();
   const changes=(await db.query("SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn') ORDER BY block_number,transaction_index,log_index",[cfg.streamKey,pool.pool_address,start])).rows;
   for(const e of changes){const a=e.event_args,d=BigInt(a.amount)*(e.event_name==='Mint'?1n:-1n);for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=d;t.net+=d*sign;assert(t.gross>=0n);if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}}
   const seed={...before,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};new ExperimentMarket(seed);
   const events=(await db.query('SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index',[cfg.streamKey,pool.pool_address,start,end])).rows;
   const fork=JSON.parse(readFileSync(dir+`/fork-${symbol}.json`));assert(fork.passed);const rt=fork.stages.roundTrip.proof,rc=fork.stages.recenter.proof;
   const buy=rt.transactions.slice(0,rt.transactions.findIndex(t=>t.action==='buy_nvda')+1).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n);
   const costs=Object.fromEntries(Object.entries({entry:rt.entryGasWei,recenter:rc.totalGasWei,exit:fork.stages.restoredExit.proof.totalGasWei,hold:String(buy)}).map(([k,v])=>[k,String(paperGasQuote(v,valuation))]));
   const out={symbol,market:fork.policy.market,fromBlock:start,toBlock:end,seed,after,events,costs,valuation,cursor,source:'read_only_canonical_event_database',capturedAt:new Date().toISOString()},raw=gzipSync(json(out)),path=dir+`/replay-source-${symbol}.json.gz`;writeFileSync(path,raw);writeFileSync(path+'.sha256',digest(raw)+'\n');console.log(json({symbol,events:events.length,seedTicks:seed.ticks.length,costs}));
  }
  assert.equal((await client.getBlock({blockNumber:BigInt(end)})).hash,u.anchor.hash);await db.query('COMMIT');
 }finally{await db.end();await gate.close();}
}else{
 assert(existsSync(dir+'/history-screen.json'),'Complete broad history capture first');
 const times=new Map(),hashes=new Map();for(const name of JSON.parse(readFileSync(dir+'/history-screen.json')).pages.map(p=>`${p.from}-${p.toExclusive}.json.gz`)){const page=JSON.parse(gunzipSync(readFileSync(dir+'/history-private/'+name)));for(const b of page.blocks){times.set(Number(b.number),Number(BigInt(b.timestamp))*1000);hashes.set(Number(b.number),b.hash);}}
 for(const symbol of ['AAPL','GOOGL']){
  const path=dir+`/replay-source-${symbol}.json.gz`,raw=readFileSync(path);assert.equal(digest(raw),readFileSync(path+'.sha256','utf8').trim());const d=JSON.parse(gunzipSync(raw)),book=new ExperimentMarket(d.seed),costs=Object.fromEntries(Object.entries(d.costs).map(([k,v])=>[k,BigInt(v)]));
  const models=[new AssetReplay(d.market,costs,30),new AssetReplay(d.market,costs,60),new AssetReplay(d.market,costs,30,2,500000)];
  let prev=null;for(let i=0;i<d.events.length;i++){
   const e=d.events[i],next=d.events[i+1];for(const {segment,protocol} of book.apply(e))for(const m of models)m.accrue(segment,protocol);
   if(e.name==='Swap'){assert.equal(e.hash.toLowerCase(),hashes.get(Number(e.block))?.toLowerCase(),'Independent log source mismatch');prev=times.get(Number(e.block));assert(prev);}
   if((!next||next.block!==e.block)&&prev!==null&&times.has(Number(e.block)))for(const m of models)await m.decision(book.source(),times.get(Number(e.block)));
  }
  book.verify(d.after);const out={symbol,fromBlock:d.fromBlock,toBlock:d.toBlock,sourceSha256:digest(raw),budgetQuote:'5000000000',halfWidthTicks:20,costs:d.costs,models:models.map(m=>({delaySeconds:m.delaySeconds,gasMultiplier:m.gasMultiplier,feePpm:m.feePpm,...m.summary(book.source())})),
   limitations:['Conditional historical market-path scenario, not a replay of historical oracle or infrastructure eligibility.','Exact canonical swap/depth replay verified to ending slot, liquidity and fee growth. Hypothetical fees use range clipping and own-liquidity dilution.','Own swaps affect that action but the next observed market state resumes the canonical path; this is not a market-impact equilibrium model.','Decisions sample event blocks with known timestamps at least 30/60 seconds apart; fills require a later sample within 90 seconds.','Gas uses each asset\'s pinned fork costs and oracle conversion, not historical receipts; stress doubles gas and halves fee income.','A full terminal liquidation is priced separately. Invalid scenarios are unsuitable for profitability ranking.'],executionEligible:false};writeFileSync(dir+`/replay-${symbol}.json`,json(out)+'\n');console.log(json({...out,models:out.models.map(({actions,...x})=>({...x,actions:actions.length}))}));
 }
}
