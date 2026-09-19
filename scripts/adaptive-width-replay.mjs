// Offline replay of the deployed adaptive ranker over today's checkpoints.
// Restores the 08:45 UTC pre-release snapshot, advances the pool book from
// canonical events, and at every 30 s decision scores all five half-widths.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {AdaptiveLpReplay}=await import(R+'/dist/src/research/adaptive-lp.js');
const {agileForecastStats}=await import(R+'/dist/src/research/agile-forecast.js');
const {forecastPortfolio}=await import(R+'/dist/src/research/adaptive-forecast.js');
const {ExperimentMarket}=await import(R+'/dist/src/experiment/market.js');
const {marketRange,marketValue,marketPriceX18}=await import(R+'/dist/src/paper/market.js');
const {sourceSql}=await import(R+'/dist/src/paper/store.js');

const [snapshotPath,outPath,untilArg]=process.argv.slice(2);
const until=untilArg?Date.parse(untilArg):Infinity;
const parse=v=>JSON.parse(v,(_k,i)=>i&&typeof i==='object'&&Object.keys(i).length===1&&typeof i.bigint==='string'?BigInt(i.bigint):i);
const state=parse(readFileSync(snapshotPath,'utf8'));
const config=state.config;
const policy={name:'rolling_60m_plus_10',halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,budget:BigInt(config.budgetQuote),
  decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,horizonMs:config.horizonMs,slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,
  feeBufferPpm:config.feeBufferPpm,gasMultiplier:1,feePpm:1000000,failEveryRecenter:0};
const db=new pg.Client({connectionString:'postgresql://root@localhost/conc_liq?host=/var/run/postgresql',options:'-c default_transaction_read_only=on'});
await db.connect();
const out={};
try{
  for(const asset of state.assets){
    const market=new ExperimentMarket(asset.seed);
    const model=new AdaptiveLpReplay(asset.market,asset.costs,policy);Object.assign(model,asset.model);
    const samples=asset.samples.map(s=>({...s}));let lastSampleAt=asset.lastSampleAt;let growth0=asset.growth0,growth1=asset.growth1;
    const rows=(await db.query(sourceSql+' AND c.block_number>$4 ORDER BY c.block_number,c.id',[config.streamKey,asset.market.rwa.toLowerCase(),asset.market.pool.toLowerCase(),asset.last.block])).rows
      .filter(r=>r.canonical===true&&r.covered===true&&r.coverage_identity_valid===true);
    const unique=[];for(const r of rows){const p=unique.at(-1);if(p?.checkpoint.block===r.checkpoint.block)unique[unique.length-1]=r;else unique.push(r);}
    const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,asset.market.pool.toLowerCase(),asset.last.block,unique.at(-1).checkpoint.block])).rows;
    let ei=0;const decisions=[];let lastDecision=model.lastDecision;
    for(const row of unique){
      const cp=row.checkpoint;const at=Date.parse(cp.blockTimestamp);if(at>until)break;
      while(ei<events.length&&BigInt(events[ei].block)<=BigInt(cp.block))for(const {segment,protocol} of market.apply(events[ei++])){
        const g=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*(1n<<128n)/segment.liquidity:0n;
        if(segment.token===0)growth0+=g;else growth1+=g;model.accrue(segment,protocol);
      }
      market.verify({price:cp.sqrtPriceX96,tick:cp.tick,liquidity:cp.liquidity,global0:cp.feeGrowth0,global1:cp.feeGrowth1});
      if(at-lastSampleAt>=60000){samples.push({at,price:market.price,growth0,growth1});lastSampleAt=at;while(samples.length>1&&samples[1].at<at-7200000)samples.shift();}
      const m={...market.source(),at,block:cp.block};
      model.mark(m);
      if(lastDecision!==null&&at-lastDecision<policy.decisionMs)continue;
      lastDecision=at;
      const inRange=model.position&&m.tick>=model.position.tickLower&&m.tick<model.position.tickUpper;
      if(inRange)continue;
      const stats=agileForecastStats(samples,at,config.forecast);
      if(!stats){decisions.push({at,reason:'forecast_unavailable'});continue;}
      const widths=[];let best=null;
      for(const width of policy.halfWidthsTicks){
        try{
          const plan=await model.plan(m,marketRange(m.price,m.tick,width,asset.market.tickSpacing));
          const f=forecastPortfolio(asset.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},stats,policy.horizonMs,model.cost('exit'),policy.feePpm,model.cost('recenter'));
          if(!f){widths.push({width,error:'forecast_null'});continue;}
          const swapIn=plan.token===null?0n:marketValue(asset.market,m.price,plan.token===0?plan.amount:0n,plan.token===1?plan.amount:0n);
          const swapOut=plan.token===null?0n:marketValue(asset.market,m.price,plan.token===1?plan.amountOut:0n,plan.token===0?plan.amountOut:0n);
          widths.push({width,terminal:String(f.terminalQuote),fees:String(f.feesQuote),occupancy:f.occupancy,exitProbability:f.exitProbability,crossing:String(f.crossingChargeQuote),swapCost:String(swapIn>swapOut?swapIn-swapOut:0n)});
          if(!best||f.terminalQuote>best.f.terminalQuote)best={width,plan,f};
        }catch(e){widths.push({width,error:e instanceof Error?e.message:String(e)});}
      }
      let gate=null;
      if(best){
        const keep=forecastPortfolio(asset.market,m,model.portfolio(),stats,policy.horizonMs,model.cost('exit'),policy.feePpm,model.cost('recenter'));
        if(keep){
          const kind=model.position?'recenter':'entry';
          const benefit=best.f.terminalQuote-model.cost(kind)-keep.terminalQuote;
          const cb=model.cost(kind)*BigInt(policy.costBufferPpm)/1000000n,fb=best.f.feesQuote*BigInt(policy.feeBufferPpm)/1000000n;
          const buffer=cb>fb?cb:fb;
          gate={benefit:String(benefit),buffer:String(buffer),keepTerminal:String(keep.terminalQuote),accepted:benefit>buffer};
        }
      }
      decisions.push({at,block:cp.block,tick:m.tick,price:String(marketPriceX18(asset.market,m.price)),sigmaTicks:Math.sqrt(stats.varianceTicksPerMs*policy.horizonMs),
        position:model.position?{tickLower:model.position.tickLower,tickUpper:model.position.tickUpper}:null,bestWidth:best?.width??null,widths,gate});
    }
    out[asset.symbol]={rows:unique.length,events:events.length,decisions,liveScoresAfter:asset.model.scores.length};
    console.error(asset.symbol,'rows',unique.length,'events',events.length,'decisions',decisions.length);
  }
}finally{await db.end();}
writeFileSync(outPath,JSON.stringify(out));
