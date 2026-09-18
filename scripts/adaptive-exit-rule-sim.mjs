// Exit-to-USDG rule simulation.
//
// The residence-cap sweep found the dominant loss is inventory stranded after
// a band is crossed on the side that leaves the book holding the RWA: the
// position is then 100% risky until something recenters it, and at 1,000 USDG
// the economic gate rarely does. Nothing in the deployed strategy ever steps
// aside -- the only close in adaptive-lp.ts is the terminal liquidation.
//
// This adds one rule on top of the deployed strategy, without modifying it:
//   * when the book is stranded on the risky side and the base strategy has
//     declined to recenter, swap the RWA to USDG and hold cash (cost: exit);
//   * re-entry from cash must then clear an economic gate of its own, against
//     the alternative of staying in cash. Without that gate, exit+entry is an
//     ungated recenter at 0.29 instead of 0.22 and the rule degenerates into
//     "always recenter" -- the `ungated` arm measures exactly that.
//
// The base class gets first refusal on every observation, so a recenter it
// accepts still happens; the exit only fires where the deployed strategy
// would have sat stranded.
//
// Usage: SIM_START=... SIM_END=... <release>/bin/node scripts/adaptive-exit-rule-sim.mjs OUT.json [--arms FILE]
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {AdaptiveLpReplay}=await import(R+'/dist/src/research/adaptive-lp.js');
const {agileForecastStats}=await import(R+'/dist/src/research/agile-forecast.js');
const {forecastPortfolio}=await import(R+'/dist/src/research/adaptive-forecast.js');
const {historicalSwapQuote}=await import(R+'/dist/src/research/portfolio-math.js');
const {ExperimentMarket}=await import(R+'/dist/src/experiment/market.js');
const {marketValue,marketPriceX18,marketTokens,marketRange}=await import(R+'/dist/src/paper/market.js');
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

const MIN=60000;

class ExitRuleReplay extends AdaptiveLpReplay {
  constructor(market,costs,policy,rule){
    super(market,costs,policy);
    this.rule=rule;this.exits=0;this.strandedSince=null;this.inCash=false;
    this.reentryScores=[];this.strandedMs=0;this.cashMs=0;this.lastSeenAt=null;
  }
  /** True when the band has been crossed on the side that leaves the book
   * holding the RWA. With the quote as token0 the position is all token1
   * above the range; with the quote as token1 it is all token0 below it. */
  isStrandedRisky(m){
    const p=this.position;if(!p)return false;
    return marketTokens(this.market).quoteIsToken0?m.tick>=p.tickUpper:m.tick<p.tickLower;
  }
  /** Entry must beat holding cash by the same buffer shape the recenter gate
   * uses. forecastPortfolio with a null position values the cash leg only. */
  async reentryWorthIt(m,stats){
    if(!stats)return false;
    const keep=forecastPortfolio(this.market,m,this.portfolio(),stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
    if(!keep)return false;
    let best=null;
    for(const width of this.policy.halfWidthsTicks){
      try{
        const plan=await this.plan(m,marketRange(m.price,m.tick,width,this.market.tickSpacing));
        const f=forecastPortfolio(this.market,m,{amount0:plan.mint.idle0,amount1:plan.mint.idle1,position:{...plan,liquidity:plan.mint.liquidity}},
          stats,this.policy.horizonMs,this.cost('exit'),this.policy.feePpm,this.cost('recenter'));
        if(f&&(!best||f.terminalQuote>best.terminalQuote))best=f;
      }catch{/* one infeasible width must not exclude the others */}
    }
    if(!best)return false;
    const benefit=best.terminalQuote-this.cost('entry')-keep.terminalQuote;
    const a=this.cost('entry')*BigInt(this.policy.costBufferPpm)/1000000n;
    const b=best.feesQuote*BigInt(this.policy.feeBufferPpm)/1000000n;
    const buffer=a>b?a:b;
    this.reentryScores.push({at:m.at,benefitQuote:String(benefit),bufferQuote:String(buffer),accepted:benefit>buffer});
    return benefit>buffer;
  }
  exitToCash(m){
    const b=this.balances(m),q0=marketTokens(this.market).quoteIsToken0;
    const risky=q0?b.amount1:b.amount0,cash=q0?b.amount0:b.amount1;
    let out=0n;
    if(risky>0n){
      let q;try{q=historicalSwapQuote(m,risky,q0?1:0,this.policy.slippageBps);}catch{this.reject('exit_quote_failed');return;}
      if(!q.fullyFilled||!q.passesSlippage){this.reject('exit_swap_unfilled');return;}
      out=q.amountOut;
    }
    this.gas+=this.cost('exit');
    if(q0){this.cash0=cash+out;this.cash1=0n;}else{this.cash1=cash+out;this.cash0=0n;}
    this.position=null;this.exits++;this.inCash=true;this.strandedSince=null;
    this.cooldownUntil=m.at+this.rule.cooldownMs;
    this.actions.push({at:m.at,block:m.block,kind:'exit',token:q0?1:0,amountIn:String(risky),amountOut:String(out),
      gasQuote:String(this.cost('exit')),tickLower:null,tickUpper:null});
  }
  async step(m,stats){
    if(this.invalid)return;
    if(this.lastSeenAt!==null){
      const dt=m.at-this.lastSeenAt;
      if(this.isStrandedRisky(m))this.strandedMs+=dt;
      if(!this.position)this.cashMs+=dt;
    }
    this.lastSeenAt=m.at;
    if(!this.rule.enabled)return super.step(m,stats);
    // Gate re-entry out of cash before the base class can mint ungated.
    if(!this.position&&this.inCash&&!this.pending&&this.rule.gateReentry){
      if(this.lastDecision!==null&&m.at-this.lastDecision<this.policy.decisionMs){this.mark(m);return;}
      if(m.at<this.cooldownUntil){this.mark(m);return;}
      if(!await this.reentryWorthIt(m,stats)){this.mark(m);this.reject('reentry_gate');return;}
    }
    const before=this.actions.length;
    await super.step(m,stats);
    if(this.position)this.inCash=false;
    if(this.invalid||this.pending||this.actions.length!==before||!this.position)return;
    if(!this.isStrandedRisky(m)){this.strandedSince=null;return;}
    this.strandedSince??=m.at;
    if(m.at-this.strandedSince<this.rule.delayMs)return;
    this.exitToCash(m);
  }
}

const [outPath,...flags]=process.argv.slice(2);
assert(outPath,'usage: adaptive-exit-rule-sim.mjs OUT.json [--arms FILE]');
const armsFileIndex=flags.indexOf('--arms');
const config=JSON.parse(readFileSync('/root/conc-liq/config/adaptive-paper-60m.json','utf8'));
const defaultArms=[
  {name:'baseline',rule:{enabled:false}},
  {name:'exit_0m',rule:{enabled:true,delayMs:0,cooldownMs:0,gateReentry:true}},
  {name:'exit_15m',rule:{enabled:true,delayMs:15*MIN,cooldownMs:0,gateReentry:true}},
  {name:'exit_60m',rule:{enabled:true,delayMs:60*MIN,cooldownMs:0,gateReentry:true}},
  {name:'exit_0m_cool30',rule:{enabled:true,delayMs:0,cooldownMs:30*MIN,gateReentry:true}},
  {name:'exit_0m_ungated',rule:{enabled:true,delayMs:0,cooldownMs:0,gateReentry:false}},
];
const arms=armsFileIndex>=0?JSON.parse(readFileSync(flags[armsFileIndex+1],'utf8')):defaultArms;
for(const a of arms){a.rule.delayMs??=0;a.rule.cooldownMs??=0;a.rule.gateReentry??=true;}

const WARMUP=75*MIN;
const START=Date.parse(process.env.SIM_START??'2026-09-08T02:00:00Z');
const END=Date.parse(process.env.SIM_END??new Date().toISOString());
// Calibrated modeled fee share (W0). 1,000,000 = the deployed 100% assumption.
const FEE_PPM=Number(process.env.SIM_FEE_PPM??1000000);
const policyFor=(name)=>({name,halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,budget:BigInt(config.budgetQuote),
  decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,feeBufferPpm:config.feeBufferPpm,
  gasMultiplier:1,feePpm:FEE_PPM,failEveryRecenter:0,horizonMs:config.horizonMs});

const db=new pg.Client({connectionString:'postgresql://root@localhost/conc_liq?host=/var/run/postgresql'});
await db.connect();
const out={generatedAt:new Date().toISOString(),release:R,feePpm:FEE_PPM,horizonMs:config.horizonMs,forecast:config.forecast,
  start:new Date(START).toISOString(),end:new Date(END).toISOString(),arms:arms.map(a=>({name:a.name,rule:a.rule})),assets:{}};
try{
  for(const item of config.assets){try{
    const market=item.market,costs=Object.fromEntries(Object.entries(item.costs).map(([k,v])=>[k,BigInt(v)]));
    const rows=await readSourceRows(db,sourceSql,{streamKey:config.streamKey,rwa:market.rwa.toLowerCase(),
      pool:market.pool.toLowerCase(),since:new Date(START-WARMUP).toISOString(),end:END});
    const unique=[];for(const r of rows){const p=unique.at(-1);if(p?.checkpoint.block===r.checkpoint.block)unique[unique.length-1]=r;else unique.push(r);}
    const first=unique[0],cp0=first.checkpoint;
    const seedEvents=(await db.query(`SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn','SetFeeProtocol') ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),cp0.block])).rows;
    const ticks=new Map();let protocol0=0,protocol1=0;
    for(const e of seedEvents){const a=e.event_args;
      if(e.event_name==='SetFeeProtocol'){protocol0=Number(a.feeProtocol0New);protocol1=Number(a.feeProtocol1New);continue;}
      const change=BigInt(a.amount)*(e.event_name==='Burn'?-1n:1n);
      for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);
        if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}
    }
    const seed={price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1,protocol0,protocol1,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
    const book=new ExperimentMarket(seed);book.verify({price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1});
    const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),cp0.block,unique.at(-1).checkpoint.block])).rows;
    const state=arms.map(a=>({arm:a,model:new ExitRuleReplay(market,costs,policyFor(a.name),a.rule)}));
    const samples=[];let lastSampleAt=-Infinity,growth0=0n,growth1=0n,ei=0;
    const sample=(at)=>{if(at-lastSampleAt<60000)return;samples.push({at,price:book.price,growth0,growth1});lastSampleAt=at;
      while(samples.length>1&&samples[1].at<at-2*3600000)samples.shift();};
    sample(Date.parse(cp0.blockTimestamp));
    let observations=0;
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
      const stats=agileForecastStats(samples,at,config.forecast);
      for(const s of state)await s.model.step(m,stats);
    }
    const last=unique.at(-1).checkpoint,mEnd={...book.source(),at:Date.parse(last.blockTimestamp),block:last.block};
    const q0=marketTokens(market).quoteIsToken0;
    out.assets[market.symbol]={rows:unique.length,observations,firstAt:cp0.blockTimestamp,lastAt:last.blockTimestamp,arms:{}};
    for(const s of state){
      const summary=s.model.summary(mEnd,{amount0:q0?BigInt(config.budgetQuote):0n,amount1:q0?0n:BigInt(config.budgetQuote)});
      const {actions,economicScores,...rest}=summary;
      out.assets[market.symbol].arms[s.arm.name]={summary:rest,exits:s.model.exits,
        strandedMinutes:Math.round(s.model.strandedMs/MIN),cashMinutes:Math.round(s.model.cashMs/MIN),
        reentryAccepted:s.model.reentryScores.filter(x=>x.accepted).length,reentryScored:s.model.reentryScores.length,
        accepted:economicScores.filter(x=>x.accepted).length,scored:economicScores.length,
        widths:actions.filter(a=>a.tickUpper!=null&&a.tickLower!=null).map(a=>(a.tickUpper-a.tickLower)/2),
        actions:actions.map(a=>({at:a.at,kind:a.kind,tickLower:a.tickLower,tickUpper:a.tickUpper,gas:a.gasQuote,token:a.token,amountIn:a.amountIn,amountOut:a.amountOut}))};
      console.error(market.symbol,s.arm.name.padEnd(16),'alpha',rest.alphaQuote,'recenters',rest.recenters,'exits',s.model.exits,'strandedMin',Math.round(s.model.strandedMs/MIN));
    }
  }catch(e){console.error(item.market.symbol,'FAILED',e instanceof Error?e.stack:String(e));out.assets[item.market.symbol]={error:e instanceof Error?e.message:String(e)};}}
}finally{await db.end();}
writeFileSync(outPath,JSON.stringify(out,(k,v)=>typeof v==='bigint'?String(v):v));
console.error('wrote',outPath);
