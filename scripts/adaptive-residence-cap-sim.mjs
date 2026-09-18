// Forward simulation of the deployed adaptive strategy with the forecast
// horizon replaced by a residence cap: horizon = min(cap, time to next
// 13:30 UTC weekday open). Fees over that horizon are E[min(exit, horizon)]
// through the existing occupancy integral, so this is the amortized gate.
// Usage: SIM_START=... SIM_END=... <release>/bin/node scripts/adaptive-residence-cap-sim.mjs CAP_MINUTES OUT.json [--no-open-cut]
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
// Runs the deployed release's compiled strategy code, not the working tree.
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {AdaptiveLpReplay}=await import(R+'/dist/src/research/adaptive-lp.js');
const {agileForecastStats}=await import(R+'/dist/src/research/agile-forecast.js');
const {ExperimentMarket}=await import(R+'/dist/src/experiment/market.js');
const {marketValue,marketPriceX18,marketTokens}=await import(R+'/dist/src/paper/market.js');
// The checkpoint query is read from the DEPLOYED release even when the
// strategy under test comes from a fresh build: the working tree's
// `sourceSql` reads `indexer_cursors.covered_through_block`, which arrives
// with migration 3, and that migration cannot be applied while the running
// collectors are on a release whose readiness check demands exactly two
// migrations. Override with CONC_LIQ_SOURCE_RELEASE once they are upgraded.
const SOURCE_RELEASE=process.env.CONC_LIQ_SOURCE_RELEASE
  ??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const {sourceSql}=await import(SOURCE_RELEASE+'/dist/src/paper/store.js');
const {readSourceRows}=await import('./sim-source.mjs');

const [capArg,outPath,...flags]=process.argv.slice(2);
const capMs=Number(capArg)*60000;assert(capMs>0);
const openCut=!flags.includes('--no-open-cut');
const config=JSON.parse(readFileSync('/root/conc-liq/config/adaptive-paper-60m.json','utf8'));
const START=Date.parse(process.env.SIM_START??'2026-09-16T14:22:31Z'),WARMUP=75*60000;
const END=Date.parse(process.env.SIM_END??'2026-09-17T14:05:00Z');

function msToOpen(at){
  // Next weekday 13:30 UTC strictly after `at`.
  const d=new Date(at);let day=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
  for(let i=0;i<8;i++){const open=day+13.5*3600000,dow=new Date(open).getUTCDay();if(open>at&&dow>=1&&dow<=5)return open-at;day+=86400000;}
  return Infinity;
}
let now=START;
// Calibrated modeled fee share (W0). 1,000,000 = the deployed 100% assumption.
const FEE_PPM=Number(process.env.SIM_FEE_PPM??1000000);
const policyFor=(costs)=>({name:`cap_${capArg}m`,halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,budget:BigInt(config.budgetQuote),
  decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,feeBufferPpm:config.feeBufferPpm,
  gasMultiplier:1,feePpm:FEE_PPM,failEveryRecenter:0,
  get horizonMs(){const h=openCut?Math.min(capMs,msToOpen(now)):capMs;return Math.max(60000,Math.floor(h));}});

const db=new pg.Client({connectionString:'postgresql://root@localhost/conc_liq?host=/var/run/postgresql'});
await db.connect();
const out={cap:Number(capArg),openCut,feePpm:FEE_PPM,start:new Date(START).toISOString(),end:new Date(END).toISOString(),assets:{}};
try{
  for(const item of config.assets){try{
    const market=item.market,costs=Object.fromEntries(Object.entries(item.costs).map(([k,v])=>[k,BigInt(v)]));
    const rows=await readSourceRows(db,sourceSql,{streamKey:config.streamKey,rwa:market.rwa.toLowerCase(),
      pool:market.pool.toLowerCase(),since:new Date(START-WARMUP).toISOString(),end:END});
    const unique=[];for(const r of rows){const p=unique.at(-1);if(p?.checkpoint.block===r.checkpoint.block)unique[unique.length-1]=r;else unique.push(r);}
    const first=unique[0];
    // Seed exactly as the runner does: Mint/Burn/SetFeeProtocol up to the first checkpoint.
    const seedEvents=(await db.query(`SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn','SetFeeProtocol') ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),first.checkpoint.block])).rows;
    const ticks=new Map();let protocol0=0,protocol1=0;
    for(const e of seedEvents){const a=e.event_args;
      if(e.event_name==='SetFeeProtocol'){protocol0=Number(a.feeProtocol0New);protocol1=Number(a.feeProtocol1New);continue;}
      const change=BigInt(a.amount)*(e.event_name==='Burn'?-1n:1n);
      for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);
        if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}
    }
    const cp0=first.checkpoint;
    const seed={price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1,protocol0,protocol1,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
    const book=new ExperimentMarket(seed);book.verify({price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1});
    const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),cp0.block,unique.at(-1).checkpoint.block])).rows;
    const model=new AdaptiveLpReplay(market,costs,policyFor(costs));
    const samples=[];let lastSampleAt=-Infinity,growth0=0n,growth1=0n,ei=0;
    const sample=(at)=>{if(at-lastSampleAt<60000)return;samples.push({at,price:book.price,growth0,growth1});lastSampleAt=at;while(samples.length>1&&samples[1].at<at-7200000)samples.shift();};
    sample(Date.parse(cp0.blockTimestamp));
    const marks=[];let decisions=0,unavailable=0;let lastMarkAt=-Infinity;
    for(const row of unique.slice(1)){
      const cp=row.checkpoint,at=Date.parse(cp.blockTimestamp);now=at;
      while(ei<events.length&&BigInt(events[ei].block)<=BigInt(cp.block))for(const {segment,protocol} of book.apply(events[ei++])){
        const g=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
        if(segment.token===0)growth0+=g;else growth1+=g;model.accrue(segment,protocol);
      }
      book.verify({price:cp.sqrtPriceX96,tick:cp.tick,liquidity:cp.liquidity,global0:cp.feeGrowth0,global1:cp.feeGrowth1});
      sample(at);
      const m={...book.source(),at,block:cp.block};
      if(at<START){model.mark(m);continue;}
      const stats=agileForecastStats(samples,at,config.forecast);
      if(stats)decisions++;else unavailable++;
      const before=model.actions.length;
      await model.step(m,stats);
      const action=model.actions.length>before?model.actions.at(-1):null;
      if(action||at-lastMarkAt>=900000){
        const b=model.balances(m),nav=marketValue(market,m.price,b.amount0,b.amount1)-model.gas,q0=marketTokens(market).quoteIsToken0;
        const risky=marketValue(market,m.price,q0?0n:b.amount0,q0?b.amount1:0n);
        const inRange=!!model.position&&m.tick>=model.position.tickLower&&m.tick<model.position.tickUpper;
        marks.push({at,nav:String(nav),price:String(marketPriceX18(market,m.price)),inRange,exposurePpm:nav>0n?Number(risky*1000000n/nav):0,
          range:model.position?[model.position.tickLower,model.position.tickUpper]:null,horizonMin:model.policy.horizonMs/60000,
          action:action?{kind:action.kind,width:(action.tickUpper-action.tickLower)/2,gas:action.gasQuote,token:action.token,amountIn:action.amountIn,amountOut:action.amountOut}:null});
        lastMarkAt=at;
      }
    }
    const last=unique.at(-1).checkpoint,mEnd={...book.source(),at:Date.parse(last.blockTimestamp),block:last.block};
    const q0=marketTokens(market).quoteIsToken0;
    const summary=model.summary(mEnd,{amount0:q0?BigInt(config.budgetQuote):0n,amount1:q0?0n:BigInt(config.budgetQuote)});
    const {actions,economicScores,...rest}=summary;
    out.assets[market.symbol]={rows:unique.length,decisions,unavailable,summary:rest,actions:actions.map(a=>({at:a.at,kind:a.kind,tickLower:a.tickLower,tickUpper:a.tickUpper,gas:a.gasQuote,token:a.token,amountIn:a.amountIn,amountOut:a.amountOut})),
      accepted:economicScores.filter(s=>s.accepted).length,scored:economicScores.length,marks};
    console.error(market.symbol,'cap',capArg,'rows',unique.length,'decisions',decisions,'nav',rest.markedNavQuote,'recenters',rest.recenters,'rejected',JSON.stringify(rest.rejected));
  }catch(e){console.error(item.market.symbol,'FAILED',e instanceof Error?e.message:String(e));out.assets[item.market.symbol]={error:e instanceof Error?e.message:String(e)};}}
}finally{await db.end();}
writeFileSync(outPath,JSON.stringify(out,(k,v)=>typeof v==='bigint'?String(v):v));
