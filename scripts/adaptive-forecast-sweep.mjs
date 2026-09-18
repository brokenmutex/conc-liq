// Decoupled forecast sweep: varies the volatility timescale and the fee
// timescale independently, against the CURRENTLY DEPLOYED occupancy ranker.
//
// Motivation: agileForecastStats derives two estimates from one window --
// varianceTicksPerMs (drives width selection) and growth0/growth1 (drives the
// economic gate). The deployed config uses a hard 60-minute cutoff for both.
// Width candidates are spaced 2x apart, so occupancy differs 4x between
// neighbours and the variance estimate does not need precision; the fee
// estimate feeds the gate and wants stability. The two want different windows.
//
// All arms replay in ONE pass over a shared order book and a shared sample
// buffer, so every arm sees identical data admission. Only the forecast spec
// and the resulting decisions differ. The forecast horizon stays at the
// deployed 10 minutes; this sweep does not re-litigate the horizon.
//
// Usage:
//   SIM_START=... SIM_END=... <release>/bin/node scripts/adaptive-forecast-sweep.mjs OUT.json [--intersect] [--marks] [--arms FILE]
//
// --intersect  only decide at observations where EVERY arm has a forecast,
//              isolating estimator effects from missing-data admission.
//              Without it, long-lookback arms are additionally penalised by
//              the >15-minute gap rule, which is a real but separate property.
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
const {sourceSql}=await import(R+'/dist/src/paper/store.js');

const [outPath,...flags]=process.argv.slice(2);
assert(outPath,'usage: adaptive-forecast-sweep.mjs OUT.json [--intersect] [--marks] [--arms FILE]');
const intersect=flags.includes('--intersect'),keepMarks=flags.includes('--marks');
const armsFileIndex=flags.indexOf('--arms');
const config=JSON.parse(readFileSync('/root/conc-liq/config/adaptive-paper-60m.json','utf8'));

const MIN=60000;
// Grid arms share a 6h lookback and are separated only by half-lives, so the
// volatility and fee timescales move independently. `null` half-life = flat
// weighting over the whole window (the slow end). The 6h/2h/60 admission
// matches the 2026-09-14 agility study's EWMA arms so those are comparable.
const GRID_LOOKBACK={lookbackMs:6*3600000,minimumSpanMs:2*3600000,minimumSamples:60};
const VOL=[['vol7m5',7.5*MIN],['vol15m',15*MIN],['vol30m',30*MIN],['vol60m',60*MIN],['volFlat',null]];
const FEE=[['fee15m',15*MIN],['fee30m',30*MIN],['fee60m',60*MIN],['feeFlat',null]];
const defaultArms=[
  // Controls. live_60m is the exact deployed config.
  {name:'live_60m',forecast:{lookbackMs:3600000,minimumSpanMs:2400000,minimumSamples:40}},
  {name:'rolling_30m',forecast:{lookbackMs:1800000,minimumSpanMs:1200000,minimumSamples:20}},
  {name:'rolling_120m',forecast:{lookbackMs:7200000,minimumSpanMs:2400000,minimumSamples:40}},
  ...VOL.flatMap(([vn,vh])=>FEE.map(([fn,fh])=>({name:`${vn}_${fn}`,forecast:{...GRID_LOOKBACK,
    ...(vh===null?{}:{volatilityHalfLifeMs:vh}),...(fh===null?{}:{feeHalfLifeMs:fh,weightedFeePpm:1000000})}}))),
];
const arms=armsFileIndex>=0?JSON.parse(readFileSync(flags[armsFileIndex+1],'utf8')):defaultArms;
assert(arms.length,'no arms');
for(const a of arms)assert(a.name&&a.forecast?.lookbackMs>0,`bad arm ${a.name}`);

// Every arm must hold a full window before the first decision, or long-lookback
// arms would be judged on a cold start rather than on their estimates.
const maxLookback=Math.max(...arms.map(a=>a.forecast.lookbackMs));
const WARMUP=maxLookback+30*MIN,RETAIN=maxLookback+10*MIN;
const START=Date.parse(process.env.SIM_START??'2026-09-08T02:00:00Z');
const END=Date.parse(process.env.SIM_END??new Date().toISOString());
assert(START<END);

const policyFor=(name)=>({name,halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,budget:BigInt(config.budgetQuote),
  decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,feeBufferPpm:config.feeBufferPpm,
  gasMultiplier:1,feePpm:1000000,failEveryRecenter:0,horizonMs:config.horizonMs});

const db=new pg.Client({connectionString:'postgresql://root@localhost/conc_liq?host=/var/run/postgresql'});
await db.connect();
const out={generatedAt:new Date().toISOString(),release:R,intersect,horizonMs:config.horizonMs,
  halfWidthsTicks:config.halfWidthsTicks,start:new Date(START).toISOString(),end:new Date(END).toISOString(),
  warmupMs:WARMUP,arms:arms.map(a=>({name:a.name,forecast:a.forecast})),assets:{}};
try{
  for(const item of config.assets){try{
    const market=item.market,costs=Object.fromEntries(Object.entries(item.costs).map(([k,v])=>[k,BigInt(v)]));
    // The indexer cursor intermittently reads back an old block, which marks
    // every row uncovered for a moment. Retry until coverage looks sane.
    let rows=[];
    for(let attempt=0;attempt<10;attempt++){
      const raw=(await db.query(sourceSql+' AND c.block_timestamp>=$4 ORDER BY c.block_number,c.id',[config.streamKey,market.rwa.toLowerCase(),market.pool.toLowerCase(),new Date(START-WARMUP).toISOString()])).rows;
      rows=raw.filter(r=>r.canonical===true&&r.covered===true&&r.coverage_identity_valid===true&&Date.parse(r.checkpoint.blockTimestamp)<=END);
      if(raw.length&&rows.length>=raw.length*0.9)break;
      console.error(market.symbol,'coverage flake: raw',raw.length,'covered',rows.length,'retrying');rows=[];
      await new Promise(r=>setTimeout(r,3000));
    }
    assert(rows.length,'no covered rows');
    const unique=[];for(const r of rows){const p=unique.at(-1);if(p?.checkpoint.block===r.checkpoint.block)unique[unique.length-1]=r;else unique.push(r);}
    const first=unique[0];
    const warmupSpan=START-Date.parse(first.checkpoint.blockTimestamp);
    if(warmupSpan<maxLookback)console.error(market.symbol,'WARNING: only',(warmupSpan/MIN).toFixed(0),'min of warmup for a',(maxLookback/MIN).toFixed(0),'min lookback');
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
    // One book for every arm: the replay models capacity dilution analytically
    // and never feeds our own position back into the historical path.
    const book=new ExperimentMarket(seed);book.verify({price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1});
    const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),cp0.block,unique.at(-1).checkpoint.block])).rows;
    const state=arms.map(a=>({arm:a,model:new AdaptiveLpReplay(market,costs,policyFor(a.name)),decisions:0,unavailable:0,skipped:0,marks:[],lastMarkAt:-Infinity}));
    const samples=[];let lastSampleAt=-Infinity,growth0=0n,growth1=0n,ei=0;
    const sample=(at)=>{if(at-lastSampleAt<60000)return;samples.push({at,price:book.price,growth0,growth1});lastSampleAt=at;
      while(samples.length>1&&samples[1].at<at-RETAIN)samples.shift();};
    sample(Date.parse(cp0.blockTimestamp));
    let observations=0,intersectSkipped=0;
    for(const row of unique.slice(1)){
      const cp=row.checkpoint,at=Date.parse(cp.blockTimestamp);
      while(ei<events.length&&BigInt(events[ei].block)<=BigInt(cp.block))for(const {segment,protocol} of book.apply(events[ei++])){
        const g=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
        if(segment.token===0)growth0+=g;else growth1+=g;
        for(const s of state)s.model.accrue(segment,protocol);
      }
      book.verify({price:cp.sqrtPriceX96,tick:cp.tick,liquidity:cp.liquidity,global0:cp.feeGrowth0,global1:cp.feeGrowth1});
      sample(at);
      const m={...book.source(),at,block:cp.block};
      if(at<START){for(const s of state)s.model.mark(m);continue;}
      observations++;
      const stats=state.map(s=>agileForecastStats(samples,at,s.arm.forecast));
      const all=stats.every(x=>x!==null);
      if(intersect&&!all)intersectSkipped++;
      for(let i=0;i<state.length;i++){
        const s=state[i];
        if(intersect&&!all){s.skipped++;s.model.mark(m);continue;}
        if(stats[i])s.decisions++;else s.unavailable++;
        const before=s.model.actions.length;
        await s.model.step(m,stats[i]);
        const action=s.model.actions.length>before?s.model.actions.at(-1):null;
        if(keepMarks&&(action||at-s.lastMarkAt>=900000)){
          const b=s.model.balances(m),nav=marketValue(market,m.price,b.amount0,b.amount1)-s.model.gas,q0=marketTokens(market).quoteIsToken0;
          const risky=marketValue(market,m.price,q0?0n:b.amount0,q0?b.amount1:0n);
          const inRange=!!s.model.position&&m.tick>=s.model.position.tickLower&&m.tick<s.model.position.tickUpper;
          s.marks.push({at,nav:String(nav),price:String(marketPriceX18(market,m.price)),inRange,exposurePpm:nav>0n?Number(risky*1000000n/nav):0,
            range:s.model.position?[s.model.position.tickLower,s.model.position.tickUpper]:null,
            action:action?{kind:action.kind,width:(action.tickUpper-action.tickLower)/2,gas:action.gasQuote}:null});
          s.lastMarkAt=at;
        }
      }
    }
    const last=unique.at(-1).checkpoint,mEnd={...book.source(),at:Date.parse(last.blockTimestamp),block:last.block};
    const q0=marketTokens(market).quoteIsToken0;
    out.assets[market.symbol]={rows:unique.length,observations,intersectSkipped,
      warmupMinutes:Math.round(warmupSpan/MIN),
      firstAt:first.checkpoint.blockTimestamp,lastAt:last.blockTimestamp,arms:{}};
    for(const s of state){
      const summary=s.model.summary(mEnd,{amount0:q0?BigInt(config.budgetQuote):0n,amount1:q0?0n:BigInt(config.budgetQuote)});
      const {actions,economicScores,...rest}=summary;
      out.assets[market.symbol].arms[s.arm.name]={decisions:s.decisions,unavailable:s.unavailable,skipped:s.skipped,summary:rest,
        accepted:economicScores.filter(x=>x.accepted).length,scored:economicScores.length,
        widths:actions.filter(a=>a.tickUpper!==undefined&&a.tickLower!==undefined).map(a=>(a.tickUpper-a.tickLower)/2),
        actions:actions.map(a=>({at:a.at,kind:a.kind,tickLower:a.tickLower,tickUpper:a.tickUpper,gas:a.gasQuote,token:a.token,amountIn:a.amountIn,amountOut:a.amountOut})),
        ...(keepMarks?{marks:s.marks}:{})};
      console.error(market.symbol,s.arm.name.padEnd(16),'dec',String(s.decisions).padStart(5),'unavail',String(s.unavailable).padStart(5),
        'nav',rest.markedNavQuote,'recenters',rest.recenters);
    }
  }catch(e){console.error(item.market.symbol,'FAILED',e instanceof Error?e.stack:String(e));out.assets[item.market.symbol]={error:e instanceof Error?e.message:String(e)};}}
}finally{await db.end();}
writeFileSync(outPath,JSON.stringify(out,(k,v)=>typeof v==='bigint'?String(v):v));
console.error('wrote',outPath);
