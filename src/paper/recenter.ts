import assert from 'node:assert/strict';
import { paperTradingWindow } from './trading-hours.js';
import { boundaryInside } from './boundary-fees.js';
import { paperGasQuote } from './transaction-engine.js';
import type { PaperInput, PaperState, TransactionPaperPolicy } from './engine.js';

/** Called after marking old-range fees and deciding mandatory exits. */
export function advanceRecenter(state:PaperState,policy:TransactionPaperPolicy,input:PaperInput) {
  const ledger=state.execution!,p=state.position!,cp=input.checkpoint;
  if(!policy.recenter)return;
  if(state.status!=='open'){ledger.recenterIntent=null;return;}
  const outside=cp.tick<p.tickLower||cp.tick>=p.tickUpper;
  if(!outside){ledger.recenterIntent=null;return;}
  if(!input.chainHealthy||state.reasons.some(r=>r!=='checkpoint_not_latest_risk_snapshot')||!policy.tradingHours||
    !paperTradingWindow(input.now,policy.tradingHours).entryAllowed||!paperTradingWindow(cp.blockTimestamp,policy.tradingHours).entryAllowed){
    ledger.recenterIntent=null;return;
  }
  const execution=input.execution!;
  if(execution.error){ledger.recenterIntent=null;state.reasons=[...state.reasons,'paper_recenter_preflight_failed',execution.error];return;}
  const intent=ledger.recenterIntent;
  if(!intent){
    if(!execution.recenterQuote){state.reasons=[...state.reasons,'paper_recenter_quote_required'];return;}
    const quote=execution.recenterQuote;
    assert.equal(quote.sourceBlock,cp.block);assert.equal(quote.sourceHash.toLowerCase(),cp.hash.toLowerCase());
    assert.deepEqual(quote.oldRange,{tickLower:p.tickLower,tickUpper:p.tickUpper,liquidity:p.liquidity});
    assert.equal(quote.tickUpper-quote.tickLower,policy.halfWidthSpacings*20);
    assert(cp.tick>=quote.tickLower&&cp.tick<quote.tickUpper);
    ledger.recenterIntent=quote;state.action='signal_recenter';return;
  }
  const quoteAge=Date.parse(input.now)-Date.parse(intent.quotedAt);
  if(!Number.isFinite(quoteAge)||quoteAge<0||quoteAge>policy.recenter.maxQuoteAgeSeconds*1000||cp.tick<intent.tickLower||cp.tick>=intent.tickUpper){
    ledger.recenterIntent=null;state.reasons=[...state.reasons,'paper_recenter_intent_expired_or_outside_range'];return;
  }
  if(BigInt(cp.block)<=BigInt(intent.sourceBlock)||Date.parse(cp.blockTimestamp)<=Date.parse(intent.quotedAt))return;
  if(!execution.recenter){state.reasons=[...state.reasons,'paper_recenter_simulation_required'];return;}
  const fill=execution.recenter,r=fill.result;
  assert.equal(r.scope,'paper_inventory_recenter');assert.equal(r.executionEligible,false);
  assert.equal(r.source.block,cp.block);assert.equal(r.source.hash.toLowerCase(),cp.hash.toLowerCase());
  assert.equal(fill.valuation.sourceBlock,cp.block);assert.equal(fill.valuation.sourceHash.toLowerCase(),cp.hash.toLowerCase());
  assert.deepEqual(r.intent,intent);
  for(const key of ['liquidity','tickLower','tickUpper','idle0','idle1','fee0','fee1'] as const)assert.equal(r.inventory[key],p[key]);
  assert.equal(r.inventory.nativeBalanceWei,String(10n**18n-BigInt(ledger.gasSpentWei)));
  assert.deepEqual(r.inventory.allowances,ledger.allowances);
  assert.equal(r.position.tickLower,intent.tickLower);assert.equal(r.position.tickUpper,intent.tickUpper);
  const plan=intent.adaptive?r.executionPlan:intent;
  assert(plan,'Missing adaptive recenter execution plan');
  if(intent.adaptive){
    assert.equal(plan.token,intent.token);assert.equal(plan.tickLower,intent.tickLower);assert.equal(plan.tickUpper,intent.tickUpper);
    assert(BigInt(plan.amountIn)>0n&&BigInt(plan.amountIn)<=BigInt(intent.adaptive.maxAmountIn));
    assert(BigInt(plan.minOut)*BigInt(intent.amountIn)>=BigInt(plan.amountIn)*BigInt(intent.minOut));
  }
  assert(BigInt(r.position.liquidity)>0n&&BigInt(r.position.minted0)>=BigInt(plan.minMint0)&&BigInt(r.position.minted1)>=BigInt(plan.minMint1));
  if(intent.token!==null)assert(r.trade&&r.trade.amountIn===plan.amountIn&&BigInt(r.trade.actualOut)>=BigInt(plan.minOut));
  else assert.equal(r.trade,null);
  assert.equal(r.totalGasWei,String(r.transactions.reduce((n,tx)=>n+BigInt(tx.estimate.totalFeeWei),0n)));
  assert.equal(r.exitGasWei,String(r.exitPreviewTransactions.reduce((n,tx)=>n+BigInt(tx.estimate.totalFeeWei),0n)));
  assert.equal(fill.boundaryFees.tickLower,intent.tickLower);assert.equal(fill.boundaryFees.tickUpper,intent.tickUpper);
  boundaryInside(cp,fill.boundaryFees);
  ledger.gasSpentWei=String(BigInt(ledger.gasSpentWei)+BigInt(r.totalGasWei));
  ledger.exitReserveWei=r.exitGasWei;
  assert(BigInt(ledger.gasSpentWei)+BigInt(ledger.exitReserveWei)<=10n**18n,'Paper native gas fixture budget exhausted');
  ledger.allowances=r.allowances;ledger.lastValuation=fill.valuation;
  (ledger.recenterRunIds??=[]).push(fill.runId);ledger.recenterIntent=null;
  state.costsPaidQuote=String(BigInt(state.costsPaidQuote)+paperGasQuote(r.totalGasWei,fill.valuation));
  state.exitReserveQuote=String(paperGasQuote(r.exitGasWei,fill.valuation));
  state.position={...p,...r.position,idle0:r.balances.after.quote,idle1:r.balances.after.rwa,fee0:'0',fee1:'0',
    feeRemainder0:'0',feeRemainder1:'0',boundaryFees:fill.boundaryFees};
  if(state.feeModel){state.feeModel.remainder0='0';state.feeModel.remainder1='0';}
  state.action='recenter';
}
