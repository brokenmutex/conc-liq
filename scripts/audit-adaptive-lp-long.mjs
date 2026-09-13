// Independent frozen-action reconstruction. Shares canonical swap and exact
// position/fee math, but never calls the policy or forecasting decision engine.
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
const root=process.argv[2]??'data/adaptive-lp-long-study-2026-09-13',read=p=>JSON.parse(readFileSync(p)),hash=x=>createHash('sha256').update(x).digest('hex');
const only=process.argv[3],output=root+'/reconstruction'+(only?'-'+only:'')+'.json';assert(!existsSync(output));
const meta=read(root+'/capture.json'),complete=read(root+'/completed.json'),plan=meta.plan,Q=1n<<128n;
assert.equal(hash(readFileSync(root+'/capture.json')),complete.captureSha256);
assert(only===undefined||plan.symbols.includes(only));const assets=meta.assets.filter(a=>only===undefined||a.symbol===only);
const states=new Map(),books=new Map(assets.map(a=>[a.symbol,new ExperimentMarket(a.seed)]));
for(const asset of assets){const all=[];for(const budget of plan.budgetsQuote){const d=read(root+`/runs/${asset.symbol}-${budget}/results.json`);for(const r of d.results){const b=canonicalBalances(asset.market,BigInt(budget),0n);all.push({r,asset,cash0:b.amount0,cash1:b.amount1,p:null,gas:0n,earned0:0n,earned1:0n,nav:BigInt(budget),active:false,invalid:false,invalidAt:null,applied:0,actions:new Map(r.actions.map(a=>[a.block,a])),hold:null,holdValue:BigInt(budget),weekly:new Map(),regimes:new Map(),lastRegime:null,lastWeek:null,above10:[0n,0n],above100:[0n,0n],lastCapacity:null,inRangeMs:0,above10Ms:0,above100Ms:0});}}states.set(asset.symbol,all);}
const calendar=new Map();
const weekKey=at=>{const date=new Date(at);date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);return date.toISOString().slice(0,10);};
const add=(map,key,nav,hold)=>{const b=map.get(key)??{nav:0n,hold:0n};b.nav+=nav;b.hold+=hold;map.set(key,b);};
let processed=0,lastLog=Date.now();
function applyBlock(events){const symbol=events[0].symbol,book=books.get(symbol),ss=states.get(symbol),at=events[0].at;
 for(const e of events){for(const {segment,protocol} of book.apply(e))for(const s of ss)if(s.active&&s.p&&!s.invalid){const k=segment.token===0?'fee0':'fee1',old=s.p[k]/Q;s.p[k]+=virtualFeeCredit(segment,s.p,s.p.liquidity,protocol).lower*BigInt(plan.scenarios.find(x=>x.name===s.r.scenario).feePpm)/1000000n;const earned=s.p[k]/Q-old;if(segment.token===0)s.earned0+=earned;else s.earned1+=earned;if(s.p.liquidity*10n>segment.liquidity)s.above10[segment.token]+=earned;if(s.p.liquidity>segment.liquidity)s.above100[segment.token]+=earned;}processed++;}
 const m=book.source(),minute=Math.floor(at/60000);if(!calendar.has(minute))calendar.set(minute,{...marketSession(at),week:weekKey(at)});const cal=calendar.get(minute);
 for(const s of ss){if(at<s.r.fromAt)continue;const oldNav=s.nav,oldHold=s.holdValue,value=(a,b)=>marketValue(s.asset.market,m.price,a,b),q0=marketTokens(s.asset.market).quoteIsToken0;
  if(!s.active){assert.equal(at,s.r.fromAt);s.active=true;const budget=BigInt(s.r.budgetQuote),buy=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);assert(buy.fullyFilled&&buy.passesSlippage);s.hold={amount0:q0?budget-budget/2n:buy.amountOut,amount1:q0?buy.amountOut:budget-budget/2n};}
  const principal=()=>s.p?principalAmounts({...s.p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n},balances=()=>{const p=principal();return {amount0:s.cash0+p.amount0+(s.p?s.p.fee0/Q:0n),amount1:s.cash1+p.amount1+(s.p?s.p.fee1/Q:0n)};};
  let b=balances();if(value(b.amount0,b.amount1)-s.gas<=0n){s.invalid=true;s.invalidAt??=at;}
  const a=s.actions.get(events[0].block);
  if(a){assert(!s.invalid);assert.equal(String(b.amount0),a.before.amount0);assert.equal(String(b.amount1),a.before.amount1);s.cash0=BigInt(a.idle.amount0);s.cash1=BigInt(a.idle.amount1);s.p=a.liquidity==='0'?null:{tickLower:a.tickLower,tickUpper:a.tickUpper,liquidity:BigInt(a.liquidity),fee0:0n,fee1:0n};s.gas+=BigInt(a.gasQuote);s.applied++;b=balances();}
  s.nav=value(b.amount0,b.amount1)-s.gas;s.holdValue=value(s.hold.amount0,s.hold.amount1)-BigInt(s.asset.costs.hold)*BigInt(plan.scenarios.find(x=>x.name===s.r.scenario).gasMultiplier);if(s.nav<=0n){s.invalid=true;s.invalidAt??=at;}
  add(s.weekly,cal.week,s.nav-oldNav,s.holdValue-oldHold);add(s.regimes,s.lastRegime===null||s.lastRegime===cal.key?cal.regime:'mixed_boundary',s.nav-oldNav,s.holdValue-oldHold);s.lastRegime=cal.key;s.lastWeek=cal.week;
  if(s.lastCapacity){const dt=at-s.lastCapacity.at;if(s.lastCapacity.inRange){s.inRangeMs+=dt;if(s.lastCapacity.above10)s.above10Ms+=dt;if(s.lastCapacity.above100)s.above100Ms+=dt;}}
  s.lastCapacity={at,inRange:!!s.p&&m.tick>=s.p.tickLower&&m.tick<s.p.tickUpper,above10:!!s.p&&s.p.liquidity*10n>m.liquidity,above100:!!s.p&&s.p.liquidity>m.liquidity};
 }
 if(Date.now()-lastLog>30000){console.log(JSON.stringify({stage:'reconstructing',at:new Date(at).toISOString(),events:processed}));lastLog=Date.now();}
}
const pending=new Map(assets.map(a=>[a.symbol,[]]));
for(const page of complete.pages){const raw=readFileSync(root+'/'+page.file);assert.equal(hash(raw),page.sha256);for(const e of JSON.parse(gunzipSync(raw)).events){if(!pending.has(e.symbol))continue;let batch=pending.get(e.symbol);if(batch.length&&batch[0].block!==e.block){applyBlock(batch);batch=[];pending.set(e.symbol,batch);}batch.push(e);}}
for(const b of pending.values())if(b.length)applyBlock(b);
const rows=[];
for(const asset of assets){const book=books.get(asset.symbol);book.verify(asset.after);for(const s of states.get(asset.symbol)){assert(s.active);assert.equal(String(s.nav),s.r.markedNavQuote);assert.equal(String(s.gas),s.r.gasPaidQuote);assert.equal(String(s.earned0),s.r.fees0);assert.equal(String(s.earned1),s.r.fees1);assert.equal(s.applied,s.r.actions.length);assert.equal(s.invalid,s.r.invalid!==null);if(!s.invalid)assert.equal(s.inRangeMs,s.r.holdingMs-s.r.outsideMs);assert(s.above100Ms<=s.above10Ms&&s.above10Ms<=s.inRangeMs);for(const token of [0,1])assert(s.above100[token]<=s.above10[token]&&s.above10[token]<=(token===0?s.earned0:s.earned1));
 if(s.r.terminalCashQuote!==null&&s.r.holdTerminalCashQuote!==null){const n=BigInt(s.r.terminalCashQuote)-s.nav,h=BigInt(s.r.holdTerminalCashQuote)-s.holdValue;add(s.weekly,s.lastWeek,n,h);add(s.regimes,'terminal_liquidation',n,h);}
 for(const [computed,expected] of [[s.weekly,s.r.weekly],[s.regimes,s.r.regimes]]){for(const b of expected){const actual=computed.get(b.key)??{nav:0n,hold:0n};assert.equal(String(actual.nav),b.navChangeQuote,'Attribution NAV mismatch: '+b.key);assert.equal(String(actual.hold),b.holdChangeQuote,'Attribution passive mismatch: '+b.key);assert.equal(String(actual.nav-actual.hold),b.alphaQuote);computed.delete(b.key);}assert.equal(computed.size,0);}
 rows.push({symbol:asset.symbol,budgetQuote:s.r.budgetQuote,name:s.r.name,scenario:s.r.scenario,actions:s.applied,markedNavVerified:true,feeTokenTotalsVerified:true,gasVerified:true,weeklyAndRegimeNavVerified:true,invalidAt:s.invalidAt,capacityTimeMetricsIncludePostInvalidMarks:s.invalid,inRangeMs:s.inRangeMs,above10PercentExistingMs:s.above10Ms,above100PercentExistingMs:s.above100Ms,feesQuote:s.r.feesQuote,modeledFeesAbove10PercentExistingQuote:String(marketValue(asset.market,book.price,s.above10[0],s.above10[1])),modeledFeesAbove100PercentExistingQuote:String(marketValue(asset.market,book.price,s.above100[0],s.above100[1]))});}}
writeFileSync(output,JSON.stringify({rows,events:processed,captureSha256:complete.captureSha256,auditCodeSha256:hash(readFileSync('scripts/audit-adaptive-lp-long.mjs')),inputHashes:Object.fromEntries(assets.flatMap(a=>plan.budgetsQuote.map(b=>{const p=root+'/runs/'+a.symbol+'-'+b+'/results.json';return [p,hash(readFileSync(p))];}))),scope:'Frozen actions reconstructed against canonical events; no policy decisions rerun. Shared exact position, swap and virtual-fee math.'},null,2)+'\n');console.log(JSON.stringify({completed:true,rows:rows.length,actions:rows.reduce((n,r)=>n+r.actions,0)}));
