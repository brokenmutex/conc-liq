// Offline only. Staged sensitivities on a hash-verified common historical window.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {SmallBudgetLpReplay} from '../src/research/small-budget-lp.ts';
import {TrailingForecast} from '../src/research/adaptive-forecast.ts';
import {marketTokens,marketValue} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {principalAmounts} from '../src/backtest/principal.ts';
import {replayPaperMint} from '../src/research/management-audit.ts';
import {virtualFeeCredit} from '../src/research/virtual-fees.ts';
const [root,symbol]=process.argv.slice(2);assert(root&&symbol);
const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v);
const plan=read(root+'/plan.json'),prepared=read(root+'/prepared.json');assert.equal(hash(root+'/plan.json'),prepared.planSha256);assert.equal(hash(root+'/sources-v2/'+symbol+'.json'),prepared.sources[symbol]);for(const [p,h] of Object.entries(prepared.code))assert.equal(hash(p),h);
const source=read(root+'/sources-v2/'+symbol+'.json'),book=new ExperimentMarket(source.seed),Q=1n<<128n;
function* events(){for(const p of source.pages){assert.equal(hash(root+'/'+p.file),p.sha256);yield* JSON.parse(gunzipSync(readFileSync(root+'/'+p.file)));}}
const definitions=[...plan.widths.map(w=>({name:'fixed_'+w,widths:[w],adaptive:false,gate:false})),{name:'adaptive_economic',widths:plan.adaptiveWidths,adaptive:true,gate:true}];
const models=plan.budgets.flatMap(budget=>plan.scenarios.flatMap(s=>definitions.map(d=>({budget,scenario:s,model:new SmallBudgetLpReplay(source.market,Object.fromEntries(Object.entries(plan.costs[s.profile][symbol]).map(([k,v])=>[k,BigInt(v)])),{name:d.name,halfWidthsTicks:d.widths,adaptive:d.adaptive,economicGate:d.gate,budget:BigInt(budget.lpQuote),decisionMs:plan.decisionMs,quoteTtlMs:plan.quoteTtlMs,horizonMs:plan.forecast.horizonMs,slippageBps:plan.slippageBps,costBufferPpm:plan.costBufferPpm,feeBufferPpm:plan.feeBufferPpm,gasMultiplier:s.gasMultiplier,feePpm:s.feePpm,failEveryRecenter:0},{gasBudget:budget.gasAllowanceQuote===null?null:BigInt(budget.gasAllowanceQuote),profiles:plan.profiles[s.profile],requireForecastForFixed:true}),hold:null,above10Fees0:0n,above10Fees1:0n}))));
const trailing=new TrailingForecast(plan.forecast.lookbackMs,plan.forecast.minimumSpanMs,plan.forecast.maximumGapMs);
let sample=null,growth0=0n,growth1=0n,last=null,started=null,emptyBlocks=0,count=0,lastLog=Date.now();const start=Date.parse(plan.from),end=Date.parse(plan.to);
async function block(events){
 for(const e of events){for(const {segment,protocol} of book.apply(e)){
  const growth=segment.liquidity?(segment.fee-(protocol?segment.fee/BigInt(protocol):0n))*Q/segment.liquidity:0n;
  if(segment.token===0)growth0+=growth;else growth1+=growth;
  if(started!==null)for(const r of models){const m=r.model,before=segment.token===0?m.fees0:m.fees1,above=!!m.position&&m.position.liquidity*10n>segment.liquidity;m.accrue(segment,protocol);if(above){const delta=(segment.token===0?m.fees0:m.fees1)-before;if(segment.token===0)r.above10Fees0+=delta;else r.above10Fees1+=delta;}}
 }}
 const m={...book.source(),at:events[0].at,block:events[0].block};assert(m.at<end);count++;
 if(m.liquidity>0n&&(sample===null||m.at-sample>=plan.forecast.sampleMs)){trailing.observe({at:m.at,price:m.price,growth0,growth1});sample=m.at;}
 if(m.at>=start){
  if(m.liquidity===0n)emptyBlocks++;
  const stats=trailing.stats(m.at);
  if(started===null&&stats&&m.liquidity>0n){
   const q0=marketTokens(source.market).quoteIsToken0;let holds=[];
   try{holds=models.map(r=>{const budget=BigInt(r.budget.lpQuote),q=historicalSwapQuote(m,budget/2n,q0?0:1,plan.slippageBps);assert(q.fullyFilled&&q.passesSlippage);return {amount0:q0?budget-budget/2n:q.amountOut,amount1:q0?q.amountOut:budget-budget/2n};});}catch{}
   if(holds.length===models.length){started=m.at;models.forEach((r,i)=>r.hold=holds[i]);}
  }
  if(started!==null)for(const r of models)await r.model.step(m,stats);
 }
 last=m;
 if(Date.now()-lastLog>30000){console.log(json({symbol,stage:'replay',at:new Date(m.at).toISOString(),blocks:count}));lastLog=Date.now();}
}
let pending=[];for(const e of events()){if(pending.length&&pending[0].block!==e.block){await block(pending);pending=[];}pending.push(e);}if(pending.length)await block(pending);
book.verify(source.after);assert.equal(book.protocol0,source.after.protocol0);assert.equal(book.protocol1,source.after.protocol1);assert(started!==null&&last);
const rows=models.map(r=>{
 const result=r.model.summary(last,r.hold),reserve=BigInt(r.budget.gasAllowanceQuote??'0');
 if(last.liquidity===0n||end-last.at>90000){result.terminalCashQuote=null;result.alphaQuote=null;result.netPnlQuote=null;result.terminalExecutable=false;}
 assert.equal(r.model.actions.reduce((n,a)=>n+BigInt(a.gasQuote),0n),r.model.gas);
 if(r.budget.gasAllowanceQuote!==null)assert(BigInt(result.totalGasWithExitQuote)<=reserve,'All-in gas allowance exceeded');
 return {symbol,budget:r.budget.name,scenario:r.scenario.name,...result,allInInitialQuote:String(BigInt(r.budget.lpQuote)+reserve),allInTerminalQuote:result.terminalCashQuote===null?null:String(BigInt(result.terminalCashQuote)+reserve),gasBudgetStop:r.model.stopReason,closedAt:r.model.closedAt,unavailableMarks:r.model.unavailableMarks,feesAbove10PercentExistingQuote:String(marketValue(source.market,last.price,r.above10Fees0,r.above10Fees1)),reserveQuote:String(reserve)};
});
// Independent action-driven reconstruction: do not rerun policy decisions or
// staged scheduling. Check every before/after balance, token transfer, mint,
// fee token count, gas and final quote against the canonical event book.
const auditBook=new ExperimentMarket(source.seed);
const auditors=rows.map((r,i)=>({row:r,model:models[i].model,cash0:marketTokens(source.market).quoteIsToken0?BigInt(models[i].budget.lpQuote):0n,cash1:marketTokens(source.market).quoteIsToken0?0n:BigInt(models[i].budget.lpQuote),position:null,index:0,gas:0n,fees0:0n,fees1:0n}));
const balance=(a,m)=>{const p=a.position,x=p?principalAmounts({...p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};return {amount0:a.cash0+x.amount0+(p?p.fee0/Q:0n),amount1:a.cash1+x.amount1+(p?p.fee1/Q:0n)};};
const strings=b=>({amount0:String(b.amount0),amount1:String(b.amount1)});
function auditBlock(events){
 for(const e of events)for(const {segment,protocol} of auditBook.apply(e))for(const a of auditors){
  if(!a.position||a.model.invalidAt!==null&&e.at>a.model.invalidAt)continue;
  const p=a.position,k=segment.token===0?'fee0':'fee1',before=p[k]/Q;p[k]+=virtualFeeCredit(segment,p,p.liquidity,protocol).lower*BigInt(a.model.policy.feePpm)/1000000n;
  if(segment.token===0)a.fees0+=p[k]/Q-before;else a.fees1+=p[k]/Q-before;
 }
 const m={...auditBook.source(),block:events[0].block};
 for(const a of auditors)while(a.index<a.row.actions.length&&a.row.actions[a.index].block===m.block){
  const action=a.row.actions[a.index++],b=balance(a,m);assert.deepEqual(strings(b),action.before,'Action starting inventory differs');a.gas+=BigInt(action.gasQuote);
  if(action.kind==='withdraw'){a.cash0=b.amount0;a.cash1=b.amount1;a.position=null;}
  else if(action.kind==='swap'){
   if(action.token!==null){const q=historicalSwapQuote(m,BigInt(action.amountIn),action.token,plan.slippageBps);assert(q.fullyFilled&&q.passesSlippage);assert.equal(String(q.amountOut),action.amountOut);a.cash0+=action.token===0?-BigInt(action.amountIn):q.amountOut;a.cash1+=action.token===1?-BigInt(action.amountIn):q.amountOut;}
  }else if(action.kind==='mint'){
   const mint=replayPaperMint(m.price,action,a.cash0,a.cash1,0n);assert.equal(String(mint.liquidity),action.liquidity);assert.equal(String(mint.amount0),action.amount0);assert.equal(String(mint.amount1),action.amount1);a.cash0=mint.idle0;a.cash1=mint.idle1;a.position={tickLower:action.tickLower,tickUpper:action.tickUpper,liquidity:mint.liquidity,fee0:0n,fee1:0n};
  }else if(action.kind==='budget_exit'){
   const q0=marketTokens(source.market).quoteIsToken0,risky=q0?b.amount1:b.amount0;assert.equal(String(risky),action.amountIn);const q=risky?historicalSwapQuote(m,risky,q0?1:0,plan.slippageBps):null;assert(!q||(q.fullyFilled&&q.passesSlippage));assert.equal(String(q?.amountOut??0n),action.amountOut);const cash=(q0?b.amount0:b.amount1)+(q?.amountOut??0n);a.cash0=q0?cash:0n;a.cash1=q0?0n:cash;a.position=null;
  }else assert(['swap_aborted','mint_aborted'].includes(action.kind));
  assert.deepEqual(strings(balance(a,m)),action.after,'Action ending inventory differs');
 }
}
pending=[];for(const e of events()){if(pending.length&&pending[0].block!==e.block){auditBlock(pending);pending=[];}pending.push(e);}if(pending.length)auditBlock(pending);auditBook.verify(source.after);
for(const a of auditors){assert.equal(a.index,a.row.actions.length);assert.equal(String(a.gas),a.row.gasPaidQuote);if(!a.row.invalid){assert.equal(String(a.fees0),a.row.fees0);assert.equal(String(a.fees1),a.row.fees1);assert.deepEqual(balance(a,last),a.model.balances(last));assert.equal(String(marketValue(source.market,last.price,...Object.values(balance(a,last)))-a.gas),a.row.markedNavQuote);}}
mkdirSync(root+'/runs',{recursive:true});const output=root+'/runs/'+symbol+'.json';assert(!existsSync(output));writeFileSync(output,json({symbol,fromAt:start,toAt:end,firstAvailableAt:started,lastSourceAt:last.at,emptyLiquidityBlocks:emptyBlocks,rows,verification:{canonicalEnd:true,allActionBalances:true,allStageGas:true,allFeeTokens:true,actionCount:rows.reduce((n,r)=>n+r.actions.length,0)},planSha256:prepared.planSha256,runnerSha256:hash('scripts/lp-small-budget-replay.mjs'),executionEligible:false,promotionEligible:false})+'\n');
console.log(json({symbol,stage:'complete',rows:rows.length,actions:rows.reduce((n,r)=>n+r.actions.length,0),output}));
