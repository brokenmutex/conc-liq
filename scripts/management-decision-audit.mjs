import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {ExperimentPortfolio} from '../src/experiment/portfolio.ts';
import {historicalSwapQuote,modeledFeeGrowth,positionAmounts} from '../src/research/portfolio-math.ts';
import {replayPaperMint,paperSegmentCredit,referenceExposure} from '../src/research/management-audit.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
import {quoteValue} from '../src/simulator/math.ts';
import {USDG} from '../src/constants.ts';
import {PAPER_NVDA} from '../src/paper/engine.ts';

const [paperPath,marketPath,output]=process.argv.slice(2);
assert(paperPath&&marketPath&&output,'Usage: node --import tsx scripts/management-decision-audit.mjs PAPER_SOURCE MARKET_SOURCE OUTPUT');
const hash=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
function read(path){const raw=fs.readFileSync(path,'utf8');assert.equal(hash(raw),fs.readFileSync(path+'.sha256','utf8').trim());return JSON.parse(raw);}
const paper=read(paperPath),data=read(marketPath),Q128=1n<<128n;
assert.equal(data.manifest.paperSha256,fs.readFileSync(paperPath+'.sha256','utf8').trim());
const value=(a0,a1,price)=>quoteValue({amount0:BigInt(a0),amount1:BigInt(a1),sqrtPriceX96:BigInt(price),token0:USDG,token1:PAPER_NVDA,quoteToken:USDG});
const sessions=paper.sessions.filter(s=>paper.selectedIds.includes(s.id));
const observations=new Map(sessions.map(s=>[s.id,paper.observations.filter(o=>o.session_id===s.id)]));
const byCp=new Map();for(const o of paper.observations){const a=byCp.get(o.checkpoint_id)??[];a.push(o);byCp.set(o.checkpoint_id,a);}
const run=(s,action)=>paper.executions.find(x=>x.session_id===s.id&&x.action===action&&x.status==='succeeded');
const active=new Map(),results=new Map(),seeds=new Map(),market=new ExperimentMarket(data.seed);
let verifiedCheckpoints=0;
for(const f of data.frames){
 for(const e of f.events)for(const {segment,protocol} of market.apply(e))for(const a of active.values()){
  const credit=paperSegmentCredit(segment,a.range,a.liquidity,protocol);
  a.fee[segment.token]+=credit;
  a.diluted[segment.token]+=modeledFeeGrowth(segment,a.range,a.liquidity,protocol)*a.liquidity;
 }
 market.verify(f);verifiedCheckpoints++;seeds.set(f.id,market.seed());
 for(const o of byCp.get(f.id)??[]){
  const s=sessions.find(s=>s.id===o.session_id),st=o.state;
  if(o.action==='enter'){
   const r=run(s,'entry').snapshot.result,p=st.position;
   const q=historicalSwapQuote(market.source(),BigInt(r.entrySwap.amountIn),0);
   assert(q.fullyFilled&&q.passesSlippage);
   assert.equal(String(q.amountOut),r.entrySwap.actualOut,`entry swap ${s.id}`);
   assert.equal(String(q.sqrtPriceAfter),r.entrySwap.sqrtPriceAfter,`entry price ${s.id}`);
   const cash=BigInt(s.policy.budgetQuote)-q.amountIn,reserve=BigInt(s.policy.budgetQuote)-BigInt(s.policy.budgetQuote)*BigInt(s.policy.lpAllocationPpm)/1000000n;
   const mint=replayPaperMint(q.sqrtPriceAfter,r.range,cash,q.amountOut,reserve);
   for(const [field,paperField] of [['liquidity','liquidity'],['amount0','minted0'],['amount1','minted1']])assert.equal(String(mint[field]),r[paperField],`${s.id} ${field}`);
   assert.equal(String(mint.idle0),p.idle0);assert.equal(String(mint.idle1),p.idle1);
   const er=run(s,'entry'),gas=paperGasQuote(r.entryGasWei,er.snapshot.valuation);
   const entryWei=r.transactions.filter(t=>['approve_entry_swap','buy_nvda','approve_mint_usdg','approve_mint_nvda','mint'].includes(t.action)).reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n);
   assert.equal(String(entryWei),r.entryGasWei);assert.equal(String(gas),st.costsPaidQuote);
   active.set(s.id,{range:r.range,liquidity:mint.liquidity,idle0:mint.idle0,idle1:mint.idle1,fee:[0n,0n],diluted:[0n,0n],gas});
   results.set(s.id,{id:s.id,status:s.status,budget:s.policy.budgetQuote,entryCheckpoint:f.id,entrySwapOut:String(q.amountOut),liquidity:String(mint.liquidity),entryGas:String(gas),marks:[],entryFillExact:true});
  }
  const a=active.get(s.id);if(!a)continue;
  const fees=a.fee.map(x=>x/Q128),diluted=a.diluted.map(x=>x/Q128),p=positionAmounts(market.price,a.range,a.liquidity,false),r=results.get(s.id);
  assert.equal(String(fees[0]),st.execution.earnedFee0,`fee0 ${s.id}/${o.id}`);
  assert.equal(String(fees[1]),st.execution.earnedFee1,`fee1 ${s.id}/${o.id}`);
  let nav=value(p.amount0+a.idle0+fees[0],p.amount1+a.idle1+fees[1],market.price)-a.gas-BigInt(st.exitReserveQuote);
  if(o.action==='exit'){
   const xr=run(s,'exit'),x=xr.snapshot.result;
   const q=historicalSwapQuote(market.source(),p.amount1+a.idle1+fees[1],1);
   assert(q.fullyFilled&&q.passesSlippage);
   assert.equal(String(q.amountOut),x.exitSwap?.actualOut??'0',`exit swap ${s.id}`);
   const proceeds=p.amount0+a.idle0+fees[0]+q.amountOut;
   assert.equal(String(proceeds),x.balances.afterExit.quote,`exit cash ${s.id}`);
   const wei=x.transactions.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei),0n);assert.equal(String(wei),x.totalGasWei);
   const gas=paperGasQuote(String(wei),xr.snapshot.valuation);nav=proceeds-a.gas-gas;
   assert.equal(String(a.gas+gas),st.costsPaidQuote);
   const dq=historicalSwapQuote(market.source(),p.amount1+a.idle1+diluted[1],1);
   assert(dq.fullyFilled&&dq.passesSlippage);
   r.dilutedExitProceeds=p.amount0+a.idle0+diluted[0]+dq.amountOut;
   r.exitProceeds=proceeds;r.dilutionCashEffect=r.dilutedExitProceeds-proceeds;
   r.exitCheckpoint=f.id;r.exitGas=String(gas);r.exitSwapOut=String(q.amountOut);r.exitCash=String(nav);r.exitFillExact=true;
   active.delete(s.id);
  }
  assert.equal(String(nav),st.navQuote,`NAV ${s.id}/${o.id}`);
  const hold=value(st.position.hold0,st.position.hold1,market.price)-BigInt(st.execution.holdGasQuote);
  assert.equal(String(hold),st.holdQuote);assert.equal(String(nav-hold),st.alphaQuote);
  r.marks.push({observation:o.id,checkpoint:f.id,action:o.action,nav:String(nav),difference:'0'});
  r.undilutedFees=value(fees[0],fees[1],market.price);
  r.dilutedFees=value(diluted[0],diluted[1],market.price);
  r.feeDilutionDifference=r.dilutedFees-r.undilutedFees;
 }
}
for(const s of sessions){if(s.policy.reentry?.previousSessionId){const parent=results.get(s.policy.reentry.previousSessionId);if(parent?.exitCash)assert.equal(s.policy.budgetQuote,parent.exitCash);}}

// All data-derived costs below remain source-block fork estimates. Future
// counterfactual operation costs use one frozen scenario, never claimed measured.
const currentBuild=sessions.at(-1).runtime_identity.buildId;
const first=sessions.find(s=>s.status==='closed'&&s.runtime_identity.buildId===currentBuild);
const child=sessions.find(s=>s.policy.reentry?.previousSessionId===first.id);
assert(first&&child&&results.has(child.id));
const cycleIds=[first.id,child.id],native=[];
function recordedFrame(f,o){
 const reasons=o.entry_reasons;
 return {...f,observedAt:new Date(o.observed_at).toISOString(),referencePrice:o.state.reference?.referencePriceX18??f.referencePrice,
  referenceEligible:o.state.reference?.eligible===true&&!reasons.some(r=>!r.startsWith('chain_')&&r!=='source_ahead_of_confirmed_quorum'),
  chainHealthy:!reasons.some(r=>r.startsWith('chain_')),reasons};
}
for(const id of cycleIds){
 const s=sessions.find(s=>s.id===id),obs=observations.get(id),byId=new Map(obs.map(o=>[o.checkpoint_id,o]));
 const p=new ExperimentPortfolio({id:'native-'+id,budget:s.policy.budgetQuote,halfWidthTicks:20,management:'exit_reentry',costMultiplier:1,feeIncomePpm:1000000},data.costEvidence.costs),m=new ExperimentMarket(data.seed),marks=[];
 for(const f of data.frames){
  for(const e of f.events)for(const {segment,protocol} of m.apply(e))p.accrue(segment,protocol);
  const o=byId.get(f.id);if(!o)continue;
  const frame=recordedFrame(f,o);p.decision(frame,m.source());
  const summary=p.summary(frame,m.source());marks.push({checkpoint:f.id,paperAction:o.action,modelNav:summary.nav,paperNav:o.state.navQuote,delta:summary.nav===null||o.state.navQuote===null?null:String(BigInt(summary.nav)-BigInt(o.state.navQuote))});
  if(o.action==='exit')break;
 }
 const rr=results.get(id),delta=BigInt(marks.at(-1).delta),costEffect=BigInt(s.state.costsPaidQuote)-p.s.costs;
 const bridge={costEffect,dilutionCashEffect:rr.dilutionCashEffect,fundingAndFillResidual:delta-costEffect-rr.dilutionCashEffect,total:delta};
 assert.equal(bridge.costEffect+bridge.dilutionCashEffect+bridge.fundingAndFillResidual,bridge.total);
 native.push({session:id,marks,actions:p.actions,finalState:p.s,bridge});
}

const outputData={asOf:paper.asOf,source:{paperPath,paperSha256:data.manifest.paperSha256,marketPath,marketSha256:fs.readFileSync(marketPath+'.sha256','utf8').trim()},
 verifiedCheckpoints,sessions:[...results.values()],cycle:{selection:'First completed session under the latest captured runtime, followed by its actual cash-funded child',ids:cycleIds},native,
 scope:'Exact recorded-action arithmetic reconciliation; canonical swaps and mint rounding independently replayed, gas uses the saved fork estimates. No funded execution or return reproduction on a new fork.',
 limitations:['Exact agreement with paper does not establish real-world fee or execution accuracy','Undiluted paper fee growth and added-liquidity experiment fee sharing are different conventions','Original model also changes funding, reserve and acquisition amounts; native delta is not solely fee dilution or strategy alpha']};
fs.writeFileSync(output,json(outputData),{flag:'wx'});
console.log(json({verifiedCheckpoints,sessions:results.size,marks:[...results.values()].reduce((n,r)=>n+r.marks.length,0),cycle:outputData.cycle,
 cycleResults:cycleIds.map(id=>{const {marks,...r}=results.get(id);return {...r,marks:marks.length};}),native:native.map(r=>({id:r.session,last:r.marks.at(-1),actions:r.actions.map(a=>a.action)}))}));
