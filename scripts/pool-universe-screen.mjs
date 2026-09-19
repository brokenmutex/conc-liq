// W3.2: fee yield per unit of pool liquidity across the indexed universe.
//
// Capital is the one lever the forecast note found that changes the ratio the
// recenter gate fails on, and NVDA-500 and GOOGL-500 are the only papered
// books with capacity headroom. Spreading capital needs a per-pool ranking of
// what a unit of liquidity earns, plus the share a given budget would take.
//
// Gross fees come from the recorded Swap amounts: the pool charges `fee` pips
// of the input token, so a swap with amount0 > 0 paid amount0*fee/1e6 of
// token0. Both legs are valued in USDG at the pool's own mean price over the
// window. Active liquidity is time-weighted from the strategy checkpoints,
// which is the same book the paper runner decides on.
//
// Read-only. Usage: [RESEARCH_DATABASE_URL=...] <release>/bin/node scripts/pool-universe-screen.mjs OUT.json
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {sizeLiquidityForQuoteBudget}=await import(R+'/dist/src/simulator/math.js');
const {sqrtRatioAtTick}=await import(R+'/dist/src/backtest/principal.js');
const {researchDatabaseUrl}=await import('./sim-source.mjs');

const USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SPACING={500:10,3000:60,10000:200,100:1};
const [outPath]=process.argv.slice(2);
assert(outPath,'usage: pool-universe-screen.mjs OUT.json');
const SINCE=process.env.SCREEN_SINCE??'2026-09-13T15:00:00Z';
const UNTIL=process.env.SCREEN_UNTIL??new Date().toISOString();
const BUDGETS=[1000n,2500n,5000n].map(n=>n*1000000n);

const pools=JSON.parse(readFileSync('/root/conc-liq/config/indexer-pools.json','utf8')).pools;
const db=new pg.Client({connectionString:researchDatabaseUrl(),
  options:'-c default_transaction_read_only=on -c statement_timeout=600000'});
await db.connect();
await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

// Map the window to blocks once, from the checkpoint runs.
const bounds=(await db.query(`SELECT min(block_number)::text AS lo,max(block_number)::text AS hi
  FROM v3_strategy_checkpoint_runs WHERE stream_key='robinhood-v3-rwa-usdg-v1'
    AND block_timestamp>=$1 AND block_timestamp<=$2`,[SINCE,UNTIL])).rows[0];
assert(bounds.lo&&bounds.hi,'no checkpoints in the window');
console.error(`window ${SINCE} -> ${UNTIL}, blocks ${bounds.lo}..${bounds.hi}`);

const rows=[];
for(const pool of pools){
  const address=pool.address.toLowerCase(),spacing=SPACING[pool.fee];
  assert(spacing,`unknown tick spacing for fee ${pool.fee}`);
  // Checkpoint series: time-weighted liquidity and price, plus session split.
  const checkpoints=(await db.query(`SELECT c.block_number::text AS block,c.block_timestamp,p.token0,p.token1,p.liquidity::text AS liquidity,
      p.sqrt_price_x96::text AS price,p.tick
    FROM v3_strategy_checkpoint_runs c JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id
    WHERE c.stream_key='robinhood-v3-rwa-usdg-v1' AND lower(p.pool_address)=$1
      AND c.block_timestamp>=$2 AND c.block_timestamp<=$3 ORDER BY c.block_number`,[address,SINCE,UNTIL])).rows;
  if(checkpoints.length<2){rows.push({symbol:pool.rwaSymbol,fee:pool.fee,pool:pool.address,error:'no checkpoints'});continue;}
  const blockOf=checkpoints.map(c=>c.block);
  const quoteIsToken0=checkpoints[0].token0.toLowerCase()===USDG;
  assert(quoteIsToken0||checkpoints[0].token1.toLowerCase()===USDG,`${pool.rwaSymbol}: neither token is USDG`);
  let weightedLiquidity=0n,totalMs=0n,priceSum=0n;
  for(let i=1;i<checkpoints.length;i++){
    const dt=BigInt(Date.parse(checkpoints[i].block_timestamp)-Date.parse(checkpoints[i-1].block_timestamp));
    if(dt<=0n||dt>900000n)continue;
    weightedLiquidity+=BigInt(checkpoints[i-1].liquidity)*dt;totalMs+=dt;priceSum+=BigInt(checkpoints[i-1].price)*dt;
  }
  if(totalMs===0n){rows.push({symbol:pool.rwaSymbol,fee:pool.fee,pool:pool.address,error:'no observed time'});continue;}
  const meanLiquidity=weightedLiquidity/totalMs,meanPrice=priceSum/totalMs;
  const lastPrice=BigInt(checkpoints.at(-1).price),lastTick=checkpoints.at(-1).tick;

  // Gross fees and volume from the recorded swaps. `v3_pool_events` carries no
  // block timestamp, so swaps are aggregated into 1,000-block buckets (about
  // 3.4 minutes at the observed 4.9 blocks/s) and each bucket is dated by
  // interpolating the checkpoint series. Totals are exact; only the session
  // split carries the bucket's quantisation.
  const buckets=(await db.query(`SELECT (floor(block_number/1000))::bigint AS bucket, count(*)::int AS swaps,
      sum(GREATEST((event_args->>'amount0')::numeric,0))::text AS in0,
      sum(GREATEST((event_args->>'amount1')::numeric,0))::text AS in1
    FROM v3_pool_events WHERE stream_key='robinhood-v3-rwa-usdg-v1' AND lower(pool_address)=$1 AND event_name='Swap'
      AND block_number BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`,[address,bounds.lo,bounds.hi])).rows;
  const anchors=checkpoints.map((c,i)=>({block:Number(blockOf[i]),at:Date.parse(c.block_timestamp)}));
  const dateOf=(block)=>{
    let lo=0,hi=anchors.length-1;
    if(block<=anchors[0].block)return anchors[0].at;
    if(block>=anchors[hi].block)return anchors[hi].at;
    while(hi-lo>1){const mid=(lo+hi)>>1;if(anchors[mid].block<=block)lo=mid;else hi=mid;}
    const a=anchors[lo],b=anchors[hi];
    return a.at+(b.at-a.at)*(block-a.block)/(b.block-a.block||1);
  };
  const fees=new Map();
  for(const b of buckets){
    const at=dateOf(Number(b.bucket)*1000+500),d=new Date(at);
    const dow=d.getUTCDay(),minute=d.getUTCHours()*60+d.getUTCMinutes();
    const bucket=dow===0||dow===6?'weekend':minute>=810&&minute<900?'open':minute>=1200||minute<480?'overnight':'other';
    const row=fees.get(bucket)??{bucket,swaps:0,in0:0n,in1:0n};
    row.swaps+=b.swaps;row.in0+=BigInt(String(b.in0).split('.')[0]||0);row.in1+=BigInt(String(b.in1).split('.')[0]||0);
    fees.set(bucket,row);
  }
  const sessions=[...fees.values()].map(r=>({bucket:r.bucket,swaps:r.swaps,in0:String(r.in0),in1:String(r.in1)}));
  rows.push({symbol:pool.rwaSymbol,fee:pool.fee,tickSpacing:spacing,pool:pool.address,quoteIsToken0,
    checkpoints:checkpoints.length,observedMinutes:Number(totalMs/60000n),
    meanLiquidity:String(meanLiquidity),meanPrice:String(meanPrice),lastTick,lastPrice:String(lastPrice),
    sessions,
    // Share is reported at two half-widths because it scales as 1/width: the
    // pool's narrowest candidate (one tick spacing, which the occupancy ranker
    // picks often) and a band near +/-0.40% in price, rounded up to the grid.
    // Both are stated so a 3000-tier book is not flattered by its coarser grid.
    budgets:BUDGETS.flatMap(budget=>[spacing,Math.max(spacing,Math.ceil(40/spacing)*spacing)].map(half=>{
      const base=Math.floor(lastTick/spacing)*spacing;
      const range={tickLower:base-half,tickUpper:base+half};
      const size=sizeLiquidityForQuoteBudget({budgetQuote:budget,sqrtPriceX96:lastPrice,
        token0:quoteIsToken0?'USDG':'RWA',token1:quoteIsToken0?'RWA':'USDG',quoteToken:'USDG',...range});
      return {budgetQuote:String(budget),halfWidthTicks:half,liquidity:String(size.liquidity),
        sharePpm:meanLiquidity>0n?Number(size.liquidity*1000000n/(size.liquidity+meanLiquidity)):null};
    }))});
  console.error(`${pool.rwaSymbol}-${pool.fee} checkpoints=${checkpoints.length} meanL=${meanLiquidity}`);
}
await db.query('COMMIT');await db.end();
writeFileSync(outPath,JSON.stringify({generatedAt:new Date().toISOString(),since:SINCE,until:UNTIL,
  fromBlock:bounds.lo,toBlock:bounds.hi,usdg:USDG,pools:rows},null,1));
console.error('wrote',outPath);
