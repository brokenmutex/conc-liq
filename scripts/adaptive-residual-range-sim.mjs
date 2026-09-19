// W1: one-sided "residual range" instead of exiting or swapping at the band edge.
//
// The residence-cap sweep put the dominant loss on inventory stranded after a
// crossing: NVDA -57 USDG directional over nine days at 1,000 USDG, while the
// recenter gate it was built around decides amounts of 0.2-0.5 USDG. The
// exit-to-cash rule tested next was a one-way door. This tests the third
// option: leave the inventory where it is and put it back to work one-sided.
//
// When the price leaves the band and the deployed gate declines to recenter,
// the position is by construction entirely one token. Mint a band adjacent to
// the current tick on the side that keeps it one-sided in the token we already
// hold: no swap, no pool fee, no router approval. Withdraw + mint only.
// Price reversion then walks back through the band, earning fees and
// converting the inventory toward quote on the way.
//
//   held token1 (tick >= tickUpper):  [near - w, near],  near = floor(tick/s)*s
//   held token0 (tick <  tickLower):  [near, near + w],  near = floor(tick/s)*s + s
//
// The deployed forecast cannot score this. `rangeOccupancy` is expected
// in-band time *until first exit* and returns exactly zero for a position that
// starts outside its band -- which a residual range always does, by
// construction. The right quantity here is unstopped occupancy: the expected
// fraction of the horizon a driftless walk started at the edge spends inside
// the band, since the residual position keeps earning every time price comes
// back. `bandOccupancy` below computes it with the same Simpson/u-substitution
// scheme `rangeOccupancy` uses, so the two are directly comparable.
//
// The base class gets first refusal on every observation: a recenter its gate
// accepts still happens, and the residual only fires where the deployed
// strategy would have sat stranded. The `baseline` arm must reproduce
// `live_60m` to the microUSDG.
//
// Usage: SIM_START=... SIM_END=... <release>/bin/node \
//          scripts/adaptive-residual-range-sim.mjs OUT.json [--arms FILE]
// Set RESEARCH_DATABASE_URL only when replaying against an isolated archive restore.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {AdaptiveLpReplay}=await import(R+'/dist/src/research/adaptive-lp.js');
const {agileForecastStats}=await import(R+'/dist/src/research/agile-forecast.js');
const {replayPaperMint}=await import(R+'/dist/src/research/management-audit.js');
const {ExperimentMarket}=await import(R+'/dist/src/experiment/market.js');
const {marketValue,marketTokens,marketPriceX18}=await import(R+'/dist/src/paper/market.js');
// The checkpoint query is read from the DEPLOYED release even when the
// strategy under test comes from a fresh build: the working tree's
// `sourceSql` reads `indexer_cursors.covered_through_block`, which arrives
// with migration 3, and that migration cannot be applied while the running
// collectors are on a release whose readiness check demands exactly two
// migrations. Override with CONC_LIQ_SOURCE_RELEASE once they are upgraded.
const SOURCE_RELEASE=process.env.CONC_LIQ_SOURCE_RELEASE
  ??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const {sourceSql}=await import(SOURCE_RELEASE+'/dist/src/paper/store.js');
const {readSourceRows,researchDatabaseUrl}=await import('./sim-source.mjs');

const MIN=60000,Q128=1n<<128n,LOG_TICK=Math.log(1.0001);

// Abramowitz and Stegun 7.1.26, identical to src/research/adaptive-forecast.ts.
function erf(x){
  const sign=x<0?-1:1,a=Math.abs(x),t=1/(1+0.3275911*a);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-a*a);
  return sign*y;
}
const normalCdf=(z)=>0.5*(1+erf(z/Math.SQRT2));

/** Expected fraction of the horizon a driftless walk started at `x` spends
 * inside (a,b), without stopping at first exit. Unlike `rangeOccupancy` this
 * is positive for a start outside the band, which is the whole point: a
 * residual range is minted at the edge and earns when price comes back.
 * Same substitution t=T*u^2, dt=2Tu du and Simpson on u in [0,1]. */
export function bandOccupancy(x,a,b,varianceTicks){
  assert(Number.isFinite(x)&&Number.isFinite(varianceTicks)&&a<b&&varianceTicks>=0);
  if(varianceTicks===0)return x>=a&&x<b?1:0;
  const sigma=Math.sqrt(varianceTicks),n=64;
  let sum=0;
  for(let i=0;i<=n;i++){
    const u=i/n,weight=i===0||i===n?1:i%2?4:2;
    const s=sigma*u;
    const inside=s<=0?(x>=a&&x<b?1:0):normalCdf((b-x)/s)-normalCdf((a-x)/s);
    sum+=weight*2*u*inside;
  }
  return Math.min(1,Math.max(0,sum/(3*n)));
}
/** Probability the walk ends the horizon past the far edge of the band, i.e.
 * fully converted and one-sided again. This is the charge a narrow residual
 * band carries: it is the management the band is expected to need. */
function traverseProbability(x,a,b,varianceTicks,heldToken){
  if(varianceTicks<=0)return 0;
  const sigma=Math.sqrt(varianceTicks);
  // Held token1 means the band lies below x and is traversed downward past a;
  // held token0 means it lies above x and is traversed upward past b.
  return heldToken===1?normalCdf((a-x)/sigma):1-normalCdf((b-x)/sigma);
}

class ResidualRangeReplay extends AdaptiveLpReplay {
  constructor(market,costs,policy,rule){
    super(market,costs,policy);
    this.rule=rule;this.residuals=0;this.residualScores=[];
    this.swapShortfall=0n;this.strandedMs=0;this.earningMs=0;this.lastSeenAt=null;
    this.residualCooldownUntil=0;
    // Directional attribution, as in the residence-cap sweep section 4.3:
    // the exposure carried into each interval times that interval's price
    // return. Accumulated per observation rather than per 15-minute mark, so
    // it is finer than the number it is meant to be comparable with.
    this.directionalQuote=0n;this.prevMark=null;
  }
  /** 1 when the position holds only token1 (tick at or above tickUpper),
   * 0 when only token0 (tick below tickLower), null when in range. */
  heldToken(m){
    const p=this.position;if(!p)return null;
    if(m.tick>=p.tickUpper)return 1;
    if(m.tick<p.tickLower)return 0;
    return null;
  }
  /** True when the one-sided token is the RWA rather than the quote. */
  heldIsRisky(token){return marketTokens(this.market).quoteIsToken0?token===1:token===0;}
  residualRange(m,width){
    const s=this.market.tickSpacing,token=this.heldToken(m);
    assert(token!==null&&width>0&&width%s===0);
    const base=Math.floor(m.tick/s)*s;
    // token1 needs the whole band at or below the tick; token0 strictly above.
    return token===1?{tickLower:base-width,tickUpper:base}:{tickLower:base+s,tickUpper:base+s+width};
  }
  /** Forecast fee value for a hypothetical band, at the calibrated fee share
   * and current pool depth. Mirrors `fee()` in forecastPortfolio, with
   * unstopped occupancy in place of stopped occupancy. */
  forecastBandFees(m,stats,range,liquidity,occupancy){
    if(m.liquidity===0n||liquidity<=0n)return 0n;
    const occ=BigInt(Math.round(occupancy*1000000));
    const fee=(token)=>(token===0?stats.growth0:stats.growth1)*BigInt(this.policy.horizonMs)*liquidity*m.liquidity*occ*BigInt(this.policy.feePpm)/
      (BigInt(stats.spanMs)*Q128*(m.liquidity+liquidity)*1000000n*1000000n);
    return marketValue(this.market,m.price,fee(0),fee(1));
  }
  planResidual(m,range){
    const b=this.balances(m);
    const mint=replayPaperMint(m.price,range,b.amount0,b.amount1,0n);
    assert(mint.liquidity>0n,'empty_residual_mint');
    return {...range,mint};
  }
  /** Rank the width candidates on forecast fees net of the traverse charge,
   * then gate against keeping the current out-of-range position. The keep leg
   * uses the same unstopped occupancy, so a band that is already adjacent
   * scores nearly as well and the rule does not churn. */
  scoreResidual(m,stats){
    const token=this.heldToken(m),center=2*Math.log(Number(m.price)/(2**96))/LOG_TICK;
    const variance=stats.varianceTicksPerMs*this.policy.horizonMs;
    const widths=this.rule.widths??this.policy.halfWidthsTicks;
    let best=null;
    for(const width of widths){
      let plan;
      try{plan=this.planResidual(m,this.residualRange(m,width));}catch{continue;}
      const occupancy=bandOccupancy(center,plan.tickLower,plan.tickUpper,variance);
      const fees=this.forecastBandFees(m,stats,plan,plan.mint.liquidity,occupancy);
      const traverse=traverseProbability(center,plan.tickLower,plan.tickUpper,variance,token);
      const charge=this.cost('residual')*BigInt(Math.round(traverse*1000000))/1000000n;
      const net=fees-charge;
      if(!best||net>best.net)best={width,plan,occupancy,fees,charge,net};
    }
    if(!best)return null;
    const p=this.position;
    const keepOccupancy=bandOccupancy(center,p.tickLower,p.tickUpper,variance);
    const keepFees=this.forecastBandFees(m,stats,p,p.liquidity,keepOccupancy);
    const cost=this.cost('residual');
    const buffer=cost*BigInt(this.policy.costBufferPpm)/1000000n;
    const benefit=best.fees-best.charge-keepFees;
    return {...best,keepFees,keepOccupancy,cost,buffer,benefit,accepted:benefit>cost+buffer};
  }
  placeResidual(m,score){
    const {plan}=score,before=this.balances(m);
    this.gas+=this.cost('residual');
    this.cash0=plan.mint.idle0;this.cash1=plan.mint.idle1;
    this.position={tickLower:plan.tickLower,tickUpper:plan.tickUpper,liquidity:plan.mint.liquidity,fee0:0n,fee1:0n};
    this.residuals++;
    this.residualCooldownUntil=m.at+this.rule.cooldownMs;
    this.actions.push({at:m.at,block:m.block,kind:'residual',width:score.width,
      before:{amount0:String(before.amount0),amount1:String(before.amount1)},
      idle:{amount0:String(this.cash0),amount1:String(this.cash1)},
      token:null,amountIn:'0',amountOut:'0',gasQuote:String(this.cost('residual')),
      tickLower:plan.tickLower,tickUpper:plan.tickUpper,liquidity:String(plan.mint.liquidity),
      occupancy:score.occupancy,forecastFeesQuote:String(score.fees),keepFeesQuote:String(score.keepFees)});
  }
  /** Exposure-weighted price P&L over the interval just closed. */
  attributeDirectional(m){
    const b=this.balances(m),q0=marketTokens(this.market).quoteIsToken0;
    const nav=marketValue(this.market,m.price,b.amount0,b.amount1)-this.gas;
    const risky=marketValue(this.market,m.price,q0?0n:b.amount0,q0?b.amount1:0n);
    const price=marketPriceX18(this.market,m.price);
    const exposurePpm=nav>0n?risky*1000000n/nav:0n;
    if(this.prevMark&&this.prevMark.price>0n)
      this.directionalQuote+=this.prevMark.nav*this.prevMark.exposurePpm/1000000n*(price-this.prevMark.price)/this.prevMark.price;
    this.prevMark={nav,exposurePpm,price};
  }
  /** Attribution has to close the interval on the state the interval was
   * actually carried in, so it runs after any action this observation took. */
  async step(m,stats){
    try{await this.stepInner(m,stats);}finally{this.attributeDirectional(m);}
  }
  async stepInner(m,stats){
    if(this.invalid)return;
    if(this.lastSeenAt!==null){
      const dt=m.at-this.lastSeenAt,held=this.heldToken(m);
      if(this.position&&held===null)this.earningMs+=dt;
      if(this.position&&held!==null&&this.heldIsRisky(held))this.strandedMs+=dt;
    }
    this.lastSeenAt=m.at;
    const previousDecision=this.lastDecision,before=this.actions.length;
    await super.step(m,stats);
    // Attribute the pool fee and impact of any swap the base class just filled.
    for(let i=before;i<this.actions.length;i++){
      const a=this.actions[i];
      if(a.token===null||a.token===undefined||!a.before||!a.afterSwap)continue;
      const was=marketValue(this.market,m.price,BigInt(a.before.amount0),BigInt(a.before.amount1));
      const now=marketValue(this.market,m.price,BigInt(a.afterSwap.amount0),BigInt(a.afterSwap.amount1));
      this.swapShortfall+=was-now;
    }
    if(!this.rule.enabled)return;
    if(this.lastDecision===previousDecision)return;   // base skipped the cadence
    if(this.invalid||this.pending||this.actions.length!==before)return;  // base acted or holds a quote
    if(!this.position||!stats)return;
    if(this.heldToken(m)===null)return;               // in range, already earning
    if(m.at<this.residualCooldownUntil)return;
    const score=this.scoreResidual(m,stats);
    if(!score){this.reject('residual_infeasible');return;}
    this.residualScores.push({at:m.at,width:score.width,benefitQuote:String(score.benefit),
      thresholdQuote:String(score.cost+score.buffer),occupancy:score.occupancy,accepted:score.accepted});
    if(!score.accepted){this.reject('residual_gate');return;}
    this.placeResidual(m,score);
    this.mark(m);
  }
}

const [outPath,...flags]=process.argv.slice(2);
assert(outPath,'usage: adaptive-residual-range-sim.mjs OUT.json [--arms FILE]');
const armsFileIndex=flags.indexOf('--arms');
const config=JSON.parse(readFileSync(process.env.SIM_CONFIG??'/root/conc-liq/config/adaptive-paper-60m.json','utf8'));
const defaultArms=[
  {name:'baseline',rule:{enabled:false}},
  {name:'residual_w10',rule:{enabled:true,widths:[10]}},
  {name:'residual_w20',rule:{enabled:true,widths:[20]}},
  {name:'residual_w40',rule:{enabled:true,widths:[40]}},
  {name:'residual_w80',rule:{enabled:true,widths:[80]}},
  {name:'residual_adaptive',rule:{enabled:true}},
  {name:'residual_adaptive_livecost',rule:{enabled:true,costPpmOfRecenter:789000}},
];
const arms=armsFileIndex>=0?JSON.parse(readFileSync(flags[armsFileIndex+1],'utf8')):defaultArms;
for(const a of arms){a.rule.cooldownMs??=0;}

const WARMUP=75*MIN;
const START=Date.parse(process.env.SIM_START??'2026-09-08T02:00:00Z');
const END=Date.parse(process.env.SIM_END??new Date().toISOString());
const FEE_PPM=Number(process.env.SIM_FEE_PPM??1000000);
const policyFor=(name)=>({name,halfWidthsTicks:config.halfWidthsTicks,adaptive:true,economicGate:true,budget:BigInt(config.budgetQuote),
  decisionMs:config.decisionMs,quoteTtlMs:config.quoteTtlMs,slippageBps:config.slippageBps,costBufferPpm:config.costBufferPpm,feeBufferPpm:config.feeBufferPpm,
  gasMultiplier:1,feePpm:FEE_PPM,failEveryRecenter:0,horizonMs:config.horizonMs});
// A residual action is withdraw + collect + mint, with no swap and no router
// approval. Both legs are already implied by the frozen fork-derived bundle:
//   withdraw = recenter - entry     (entry is swap + mint)
//   mint     = recenter - exit      (exit is withdraw + swap)
// so residual = 2*recenter - entry - exit, entirely inside the config's own
// cost basis. `costPpmOfRecenter` overrides it with the live campaign's
// post-allowance ratio (mint 0.071 + withdraw 0.034 over gas-only recenter
// 0.133 = 78.9%), which is the more expensive reading of the same action.
const residualCost=(costs,rule)=>rule.costPpmOfRecenter!==undefined
  ? costs.recenter*BigInt(rule.costPpmOfRecenter)/1000000n
  : 2n*costs.recenter-costs.entry-costs.exit;

const db=new pg.Client({connectionString:researchDatabaseUrl()});
await db.connect();
const out={generatedAt:new Date().toISOString(),release:R,feePpm:FEE_PPM,horizonMs:config.horizonMs,forecast:config.forecast,
  start:new Date(START).toISOString(),end:new Date(END).toISOString(),arms:arms.map(a=>({name:a.name,rule:a.rule})),assets:{}};
try{
  for(const item of config.assets){try{
    const market=item.market,costs=Object.fromEntries(Object.entries(item.costs).map(([k,v])=>[k,BigInt(v)]));
    const rows=await readSourceRows(db,sourceSql,{streamKey:config.streamKey,rwa:market.rwa.toLowerCase(),
      pool:market.pool.toLowerCase(),since:new Date(START-WARMUP).toISOString(),end:END,fee:market.fee});
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
    // A 3000-tier book cannot be replayed without its own fee and spacing:
    // `reconstructSwap` reproduces a Swap event only with the pool's real
    // parameters, and a seed that omits them defaults to fee 500, spacing 10.
    const seed={price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1,protocol0,protocol1,
      fee:market.fee,spacing:market.tickSpacing,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
    const book=new ExperimentMarket(seed);book.verify({price:cp0.sqrtPriceX96,tick:cp0.tick,liquidity:cp0.liquidity,global0:cp0.feeGrowth0,global1:cp0.feeGrowth1});
    const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
      FROM v3_pool_events WHERE stream_key=$1 AND LOWER(pool_address)=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,
      [config.streamKey,market.pool.toLowerCase(),cp0.block,unique.at(-1).checkpoint.block])).rows;
    // `sourcePolicy` arms drive the ported `residualRange` flag in
    // src/research/adaptive-lp.ts instead of this file's wrapper, so the two
    // can be compared decision for decision. Requires CONC_LIQ_RELEASE to
    // point at a build that has the flag.
    const state=arms.map(a=>{
      const c={...costs,residual:residualCost(costs,a.rule)};
      if(a.rule.sourcePolicy){
        const p={...policyFor(a.name),residualRange:true,
          ...(a.rule.widths?{residualWidthsTicks:a.rule.widths}:{})};
        const model=new AdaptiveLpReplay(market,c,p);
        // The wrapper's extra accounting is absent on this path; the summary
        // fields it does not touch are reported as zero.
        model.rule=a.rule;model.residualScores=[];model.swapShortfall=0n;
        model.strandedMs=0;model.earningMs=0;model.directionalQuote=0n;
        return {arm:a,model};
      }
      return {arm:a,model:new ResidualRangeReplay(market,c,policyFor(a.name),a.rule)};
    });
    const samples=[];let lastSampleAt=-Infinity,growth0=0n,growth1=0n,ei=0;
    const sample=(at)=>{if(at-lastSampleAt<60000)return;samples.push({at,price:book.price,growth0,growth1});lastSampleAt=at;
      while(samples.length>1&&samples[1].at<at-2*3600000)samples.shift();};
    sample(Date.parse(cp0.blockTimestamp));
    let observations=0;
    for(const row of unique.slice(1)){
      const cp=row.checkpoint,at=Date.parse(cp.blockTimestamp);
      while(ei<events.length&&BigInt(events[ei].block)<=BigInt(cp.block))for(const {segment,protocol} of book.apply(events[ei++])){
        const g=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*Q128/segment.liquidity:0n;
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
      const netFees=BigInt(rest.feesQuote)-BigInt(rest.gasPaidQuote);
      out.assets[market.symbol].arms[s.arm.name]={summary:rest,
        residualCostQuote:String(s.model.costs.residual),
        residuals:s.model.residuals,sourcePolicy:!!s.arm.rule.sourcePolicy,
        netFeesQuote:String(netFees),
        netFeesAfterSwapQuote:String(netFees-s.model.swapShortfall),
        swapShortfallQuote:String(s.model.swapShortfall),
        directionalQuote:String(s.model.directionalQuote),
        residualPnlQuote:String(BigInt(rest.markedNavQuote)-BigInt(config.budgetQuote)-s.model.directionalQuote),
        strandedMinutes:Math.round(s.model.strandedMs/MIN),earningMinutes:Math.round(s.model.earningMs/MIN),
        residualAccepted:s.model.residualScores.filter(x=>x.accepted).length,residualScored:s.model.residualScores.length,
        accepted:economicScores.filter(x=>x.accepted).length,scored:economicScores.length,
        widths:actions.filter(a=>a.tickUpper!=null&&a.tickLower!=null).map(a=>(a.tickUpper-a.tickLower)/2),
        actions:actions.map(a=>({at:a.at,kind:a.kind,tickLower:a.tickLower,tickUpper:a.tickUpper,gas:a.gasQuote,token:a.token,width:a.width}))};
      console.error(market.symbol,s.arm.name.padEnd(28),'netfee',(Number(netFees)/1e6).toFixed(2).padStart(8),
        'alpha',(Number(rest.alphaQuote)/1e6).toFixed(2).padStart(8),'recen',String(rest.recenters).padStart(3),
        'resid',String(s.model.residuals).padStart(3),'earnMin',Math.round(s.model.earningMs/MIN));
    }
  }catch(e){console.error(item.market.symbol,'FAILED',e instanceof Error?e.stack:String(e));out.assets[item.market.symbol]={error:e instanceof Error?e.message:String(e)};}}
}finally{await db.end();}
writeFileSync(outPath,JSON.stringify(out,(k,v)=>typeof v==='bigint'?String(v):v));
console.error('wrote',outPath);
