// Independently replay frozen actions, without forecast or decision calls.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ExperimentMarket} from '../src/experiment/market.ts';
import {principalAmounts} from '../src/backtest/principal.ts';
import {marketTokens,marketValue,canonicalBalances} from '../src/paper/market.ts';
import {historicalSwapQuote} from '../src/research/portfolio-math.ts';
import {virtualFeeCredit} from '../src/research/virtual-fees.ts';
import {replayPaperMint} from '../src/research/management-audit.ts';

export async function auditAgileActions(root,source,rows,plan){
  const book=new ExperimentMarket(source.seed),Q=1n<<128n,hash=x=>createHash('sha256').update(x).digest('hex');
  const auditors=rows.map(row=>({...canonicalBalances(source.market,BigInt(plan.budgetQuote),0n),row,p:null,index:0,gas:0n,fees0:0n,fees1:0n,holdingMs:0,outsideMs:0,last:null}));
  const balances=(a,m)=>{const p=a.p,b=p?principalAmounts({...p,sqrtPriceX96:m.price}):{amount0:0n,amount1:0n};return {amount0:a.amount0+b.amount0+(p?p.fee0/Q:0n),amount1:a.amount1+b.amount1+(p?p.fee1/Q:0n)};};
  const strings=b=>({amount0:String(b.amount0),amount1:String(b.amount1)});
  let lastLog=Date.now(),lastSource=null;
  function block(events){
    const at=events[0].at;
    for(const e of events)for(const {segment,protocol} of book.apply(e))for(const a of auditors){
      if(!a.p||a.row.invalidAt!==null&&at>a.row.invalidAt)continue;
      const s=plan.scenarios.find(s=>s.name===a.row.scenario),k=segment.token===0?'fee0':'fee1',before=a.p[k]/Q;
      a.p[k]+=virtualFeeCredit(segment,a.p,a.p.liquidity,protocol).lower*BigInt(s.feePpm)/1000000n;
      if(segment.token===0)a.fees0+=a.p[k]/Q-before;else a.fees1+=a.p[k]/Q-before;
    }
    const m={...book.source(),at,block:events[0].block};lastSource=m;
    for(const a of auditors){
      if(at<source.firstAt)continue;
      if(a.last){const dt=at-a.last.at;if(a.last.holding){a.holdingMs+=dt;if(a.last.outside)a.outsideMs+=dt;}}
      const action=a.row.actions[a.index];
      if(action&&action.block===m.block){
        const before=balances(a,m);assert.deepEqual(strings(before),action.before,'Starting inventory differs');
        assert(BigInt(action.quoteBlock)<BigInt(action.block)&&action.quoteAt<action.at&&action.at-action.quoteAt<=plan.quoteTtlMs);
        let after={...before},price=m.price;
        if(action.token!==null){
          const q=historicalSwapQuote(m,BigInt(action.amountIn),action.token,plan.slippageBps);assert(q.fullyFilled&&q.passesSlippage);assert.equal(String(q.amountOut),action.amountOut);price=q.sqrtPriceAfter;
          after.amount0+=action.token===0?-BigInt(action.amountIn):q.amountOut;after.amount1+=action.token===1?-BigInt(action.amountIn):q.amountOut;
        }
        assert(after.amount0>=0n&&after.amount1>=0n);assert.deepEqual(strings(after),action.afterSwap);
        const scenario=plan.scenarios.find(s=>s.name===a.row.scenario),kind=action.kind==='entry'?'entry':'recenter';
        assert.equal(action.gasQuote,String(BigInt(source.costs[kind])*BigInt(scenario.gasMultiplier)));
        if(action.kind==='partial_mint_failure'){assert.equal(action.liquidity,'0');assert.deepEqual(strings(after),action.idle);a.p=null;}
        else{
          const mint=replayPaperMint(price,action,after.amount0,after.amount1,0n);
          assert.equal(String(mint.liquidity),action.liquidity);assert.equal(String(mint.amount0),action.minted0);assert.equal(String(mint.amount1),action.minted1);
          assert.deepEqual(strings({amount0:mint.idle0,amount1:mint.idle1}),action.idle);
          a.p={tickLower:action.tickLower,tickUpper:action.tickUpper,liquidity:mint.liquidity,fee0:0n,fee1:0n};
        }
        a.amount0=BigInt(action.idle.amount0);a.amount1=BigInt(action.idle.amount1);a.gas+=BigInt(action.gasQuote);a.index++;
      }
      a.last={at,holding:!!a.p,outside:!!a.p&&(m.tick<a.p.tickLower||m.tick>=a.p.tickUpper)};
    }
    if(Date.now()-lastLog>30000){console.log(JSON.stringify({stage:'audit',at:new Date(at).toISOString()}));lastLog=Date.now();}
  }
  let pending=[];
  for(const p of source.pages){const raw=readFileSync(root+'/'+p.file);assert.equal(hash(raw),p.sha256);for(const e of JSON.parse(gunzipSync(raw))){if(pending.length&&pending[0].block!==e.block){block(pending);pending=[];}pending.push(e);}}
  if(pending.length)block(pending);book.verify(source.after);assert(lastSource);
  for(const a of auditors){
    assert.equal(a.index,a.row.actions.length);assert.equal(String(a.gas),a.row.gasPaidQuote);assert.equal(String(a.fees0),a.row.fees0);assert.equal(String(a.fees1),a.row.fees1);
    const b=balances(a,lastSource);assert.equal(String(marketValue(source.market,lastSource.price,b.amount0,b.amount1)-a.gas),a.row.markedNavQuote);
    if(!a.row.invalid){assert.equal(a.holdingMs,a.row.holdingMs);assert.equal(a.outsideMs,a.row.outsideMs);}
    const q0=marketTokens(source.market).quoteIsToken0,multiplier=BigInt(plan.scenarios.find(s=>s.name===a.row.scenario).gasMultiplier);
    const close=(b,gas,exit)=>{try{const risky=q0?b.amount1:b.amount0,cash=q0?b.amount0:b.amount1,q=risky?historicalSwapQuote(lastSource,risky,q0?1:0,plan.slippageBps):null;if(q&&(!q.fullyFilled||!q.passesSlippage))return null;return String(cash+(q?.amountOut??0n)-gas-exit);}catch{return null;}};
    const exit=(a.p||(q0?b.amount1:b.amount0)>0n)?BigInt(source.costs.exit)*multiplier:0n;
    assert.equal(String(exit),a.row.terminalExitCostQuote);
    if(Date.parse(plan.to)-lastSource.at<=90000&&lastSource.liquidity>0n){
      assert.equal(close(b,a.gas,exit),a.row.terminalCashQuote);
      assert.equal(close(source.hold,BigInt(source.costs.hold)*multiplier,BigInt(source.costs.holdExit)*multiplier),a.row.holdTerminalCashQuote);
    }else assert.equal(a.row.alphaQuote,null);
  }
  return {canonicalEnd:true,actionBalances:true,swapOutputs:true,mintAmounts:true,feeTokens:true,gas:true,occupancy:true,terminalQuotes:true,rows:rows.length,actions:auditors.reduce((n,a)=>n+a.index,0)};
}
