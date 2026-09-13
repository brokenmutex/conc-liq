// Reconstruct portfolio marks from frozen actions, without running the decision
// engine again. Separately verifies token continuity and attributes observed NAV
// changes to market sessions; crossings receive an explicit mixed bucket.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {principalAmounts} from '../src/backtest/principal.ts';
import {marketTokens,marketValue,canonicalBalances} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {virtualFeeCredit} from '../src/research/virtual-fees.ts';
import {marketSession} from '../src/paper/session-performance.ts';
const [root]=process.argv.slice(2);assert(root&&!existsSync(root+'/session-attribution.json'));
const read=name=>JSON.parse(readFileSync(root+'/'+name)),manifest=read('manifest.json'),plan=manifest.plan,source=plan.sourceDirectory;
const hash=x=>createHash('sha256').update(x).digest('hex');
const reports=[...read('development-validation.json'),...read('retrospective-test.json')],times=new Map();
const historyRaw=readFileSync(source+'/history-screen.json');assert.equal(hash(historyRaw),manifest.historySha256);
for(const p of JSON.parse(historyRaw).pages){const raw=readFileSync(source+`/history-private/${p.from}-${p.toExclusive}.json.gz`);assert.equal(hash(raw),p.sha256);for(const b of JSON.parse(gunzipSync(raw)).blocks)times.set(Number(b.number),Number(BigInt(b.timestamp))*1000);}
const supplemental=readFileSync(plan.supplementalTimestamps);assert.equal(hash(supplemental),manifest.supplementalTimestampsSha256);
for(const b of JSON.parse(supplemental).blocks)times.set(b.number,Number(BigInt(b.timestamp))*1000);
const output=[],Q=1n<<128n,sessionCache=new Map();
const session=at=>{const key=Math.floor(at/60000);if(!sessionCache.has(key))sessionCache.set(key,marketSession(at));return sessionCache.get(key);};
for(const symbol of plan.symbols){
 const raw=readFileSync(source+`/replay-source-${symbol}.json.gz`);assert.equal(hash(raw),manifest.sources.find(s=>s.symbol===symbol).sha256);
 const d=JSON.parse(gunzipSync(raw)),book=new ExperimentMarket(d.seed),q0=marketTokens(d.market).quoteIsToken0;
 const phases=reports.filter(r=>r.symbol===symbol).flatMap(r=>r.results),budget=BigInt(plan.budgetQuote);
 let phase=null,states=[],hold=null;
 const bucket=(s,key)=>{let b=s.buckets.get(key);if(!b){b={key,navChange:0n,holdChange:0n,feesQuote:0n,gasQuote:0n,entries:0,recenters:0,failures:0,marks:0};s.buckets.set(key,b);}return b;};
 const finish=()=>{
  for(const s of states){
   assert.equal(String(s.nav),s.result.markedNavQuote,'Independent marked NAV mismatch');
   assert.equal(String(s.gas),s.result.gasPaidQuote,'Independent gas mismatch');
   assert.equal(String(s.earned0),s.result.fees0);assert.equal(String(s.earned1),s.result.fees1);
   assert.equal(s.applied,s.result.actions.length);
   if(s.result.terminalCashQuote!==null&&s.result.holdTerminalCashQuote!==null){
    const b=bucket(s,'terminal_liquidation');b.navChange+=BigInt(s.result.terminalCashQuote)-s.nav;b.holdChange+=BigInt(s.result.holdTerminalCashQuote)-s.holdValue;b.gasQuote+=BigInt(s.result.terminalExitCostQuote);
    assert.equal([...s.buckets.values()].reduce((n,b)=>n+b.navChange,0n),BigInt(s.result.netPnlQuote));
    assert.equal([...s.buckets.values()].reduce((n,b)=>n+b.navChange-b.holdChange,0n),BigInt(s.result.alphaQuote));
   }
   output.push({symbol,phase:phase.phase,name:s.result.name,scenario:s.result.scenario,buckets:[...s.buckets.values()].map(b=>({...b,alpha:b.navChange-b.holdChange})),markedNavVerified:true,feeTokenTotalsVerified:true,actionsVerified:s.applied});
  }
  console.log(JSON.stringify({symbol,phase:phase.phase,attributed:states.length}));
  phase=null;states=[];hold=null;
 };
 for(let i=0;i<d.events.length;i++){
  const e=d.events[i],at=times.get(Number(e.block));assert(at!==undefined);
  if(i===0||d.events[i-1].block!==e.block){
   if(phase&&at>phase.sourceTo)finish();
   if(!phase){phase=phases.find(p=>at>=p.sourceFrom&&at<=p.sourceTo)??null;
    if(phase)states=phase.models.map(result=>{
     const b=canonicalBalances(d.market,budget,0n),scenario=plan.scenarios.find(x=>x.name===result.scenario);
     return {result,scenario,cash0:b.amount0,cash1:b.amount1,p:null,gas:0n,nav:budget,holdValue:budget,earned0:0n,earned1:0n,markEarned0:0n,markEarned1:0n,lastKey:null,buckets:new Map(),actions:new Map(result.actions.map(a=>[a.block,a])),applied:0};
    });
   }
  }
  for(const {segment,protocol} of book.apply(e))for(const s of states)if(s.p){
   const k=segment.token===0?'fee0':'fee1',old=s.p[k]/Q;
   s.p[k]+=virtualFeeCredit(segment,s.p,s.p.liquidity,protocol).lower*BigInt(s.scenario.feePpm)/1000000n;
   if(segment.token===0)s.earned0+=s.p[k]/Q-old;else s.earned1+=s.p[k]/Q-old;
  }
  if(d.events[i+1]?.block===e.block||!phase)continue;
  const m=book.source(),value=(a,b)=>marketValue(d.market,m.price,a,b),nowSession=session(at);
  if(!hold){const buy=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);assert(buy.fullyFilled&&buy.passesSlippage);hold={amount0:q0?budget-budget/2n:buy.amountOut,amount1:q0?buy.amountOut:budget-budget/2n};}
  for(const s of states){
   const b=bucket(s,s.lastKey===null||s.lastKey===nowSession.key?nowSession.regime:'mixed_boundary');
   const action=s.actions.get(e.block);let gas=0n;
   if(action){
    const principal=s.p?principalAmounts({...s.p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};
    assert.equal(String(s.cash0+principal.amount0+(s.p?s.p.fee0/Q:0n)),action.before.amount0);
    assert.equal(String(s.cash1+principal.amount1+(s.p?s.p.fee1/Q:0n)),action.before.amount1);
    s.cash0=BigInt(action.idle.amount0);s.cash1=BigInt(action.idle.amount1);
    s.p=action.liquidity==='0'?null:{tickLower:action.tickLower,tickUpper:action.tickUpper,liquidity:BigInt(action.liquidity),fee0:0n,fee1:0n};
    gas=BigInt(action.gasQuote);s.gas+=gas;s.applied++;
    if(action.kind==='entry')b.entries++;else if(action.kind==='recenter')b.recenters++;else b.failures++;
   }
   const principal=s.p?principalAmounts({...s.p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};
   const nav=value(s.cash0+principal.amount0+(s.p?s.p.fee0/Q:0n),s.cash1+principal.amount1+(s.p?s.p.fee1/Q:0n))-s.gas;
   const hv=value(hold.amount0,hold.amount1)-BigInt(phase.costs.hold)*BigInt(s.scenario.gasMultiplier);
   b.navChange+=nav-s.nav;b.holdChange+=hv-s.holdValue;b.gasQuote+=gas;b.marks++;
   b.feesQuote+=value(s.earned0-s.markEarned0,s.earned1-s.markEarned1);
   s.nav=nav;s.holdValue=hv;s.markEarned0=s.earned0;s.markEarned1=s.earned1;s.lastKey=nowSession.key;
  }
 }
 if(phase)finish();book.verify(d.after);
}
writeFileSync(root+'/session-attribution.json',JSON.stringify({scope:'Frozen-action mark reconstruction with shared canonical swap and position math',rows:output,
 limitations:['NAV changes spanning a calendar boundary use mixed_boundary; no price move is prorated.','Terminal liquidation is a separate synthetic bucket.','Regime-level figures are descriptive retrospective attribution, not independently selected strategies.']},(_,v)=>typeof v==='bigint'?String(v):v)+'\n');
