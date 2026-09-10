import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {ExperimentSource,STREAM} from '../src/experiment/source.ts';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {PAPER_POOL} from '../src/paper/engine.ts';

const [envPath,from,to,output]=process.argv.slice(2);
assert(envPath&&from&&to&&output,'Usage: node --import tsx scripts/capture-lp-hours.mjs ENV FROM TO OUTPUT');
assert(!fs.existsSync(output));
const env=parseEnv(fs.readFileSync(envPath,'utf8')),source=new ExperimentSource(env.DATABASE_URL);
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v)+'\n';
try {
 await source.connect();
 await source.db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const rows=(await source.db.query(`SELECT c.id::text,c.block_number::text AS block,c.block_hash AS hash,
 c.block_timestamp AS source_at,c.captured_at AS observed_at,c.target_set_hash,
 p.sqrt_price_x96::text AS price,p.tick,p.liquidity::text,p.fee_growth_global0_x128::text AS global0,
 p.fee_growth_global1_x128::text AS global1,p.oracle_price_x18::text AS reference_price
 FROM v3_strategy_checkpoint_runs c JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id
 JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id
 WHERE c.stream_key=$1 AND lower(p.pool_address)=$2 AND c.block_timestamp >= $3 AND c.block_timestamp <= $4
 AND v.canonical IS TRUE AND v.block_number=c.block_number
 AND lower(v.expected_hash)=lower(c.block_hash) AND lower(v.observed_hash)=lower(c.block_hash)
 ORDER BY c.block_number,c.id`,[STREAM,PAPER_POOL,from,to])).rows;
 assert(rows.length>1);
 await source.coverage(rows.at(-1).block,rows.at(-1).target_set_hash);
 const seed=await source.seed(rows[0]);
 const events=await source.events(rows[0].block,rows.at(-1).block);
 await source.db.query('COMMIT');
 const market=new ExperimentMarket(seed),frames=[];let cursor=0;
 for(const row of rows){
  const batch=[];while(cursor<events.length&&BigInt(events[cursor].block)<=BigInt(row.block))batch.push(events[cursor++]);
  const f={id:row.id,block:row.block,hash:row.hash,sourceAt:new Date(row.source_at).toISOString(),
   capturedAt:new Date(row.observed_at).toISOString(),price:row.price,tick:row.tick,liquidity:row.liquidity,
   global0:row.global0,global1:row.global1,referencePrice:row.reference_price,events:batch};
  for(const event of batch)market.apply(event);
  market.verify(f);frames.push(f);
 }
 assert.equal(cursor,events.length);
 const out={manifest:{capturedAt:new Date().toISOString(),from,to,pool:PAPER_POOL,stream:STREAM,
  checkpoints:frames.length,events:events.length,canonical:true,eventCursorCoverage:true,
  marketVerifiedAtEveryCheckpoint:true,eventTime:'Events belong to the interval between actual source block timestamps; observed_at is not market time'},seed,frames};
 const raw=stringify(out);fs.writeFileSync(output,raw,{flag:'wx'});
 fs.writeFileSync(output+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});
 console.log(JSON.stringify(out.manifest));
}finally{await source.close();}
