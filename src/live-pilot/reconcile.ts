import assert from 'node:assert/strict';
import {zeroAddress} from 'viem';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../constants.js';
import {PAPER_NVDA} from '../paper/engine.js';
import {pilotReceiptFacts,type PilotReceipt} from './receipt.js';
import type {PilotAction,PilotSnapshot,PilotState} from './domain.js';
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

/** Completion proof: canonicality is checked by the caller at the receipt block.
 * Any unexplained wallet transfer, nonce or NFT change keeps the action unresolved.
 */
export function reconcilePilotAction(state:PilotState,action:PilotAction,receipt:PilotReceipt,after:PilotSnapshot) {
 const before=action.before,plan=action.plan,facts=pilotReceiptFacts(receipt,state.operator);
 assert(action.hash&&same(action.hash,receipt.transactionHash),'Unexpected receipt hash');
 assert(receipt.gasUsed<=BigInt(action.intent.gas)&&receipt.effectiveGasPrice<=BigInt(action.intent.maxFeePerGas),'Receipt exceeds signed gas envelope');
 assert.equal(after.block,String(receipt.blockNumber));assert(same(after.hash,receipt.blockHash));
 assert(same(before.operator,state.operator)&&same(after.operator,state.operator));
 assert.equal(after.nonce,before.nonce+1,'Wallet nonce did not advance exactly once');
 assert.equal(BigInt(after.usdg)-BigInt(before.usdg),BigInt(facts.walletDeltas.usdg),'Unexplained USDG balance change');
 assert.equal(BigInt(after.nvda)-BigInt(before.nvda),BigInt(facts.walletDeltas.nvda),'Unexplained NVDA balance change');
 assert.equal(BigInt(before.native)-BigInt(after.native),BigInt(facts.gasWei),'Native balance does not match receipt gas');
 assert(BigInt(after.usdg)>=BigInt(state.reserveUsdg),'Pilot spent reserved USDG');
 const next: PilotState={...structuredClone(state),last:after,updatedAt:new Date(Number(after.timestamp)*1000).toISOString(),
  gasSpentWei:String(BigInt(state.gasSpentWei)+BigInt(facts.gasWei))};
 if(receipt.status==='reverted') {
  assert.equal(after.usdg,before.usdg);assert.equal(after.nvda,before.nvda);assert.deepEqual(after.position,before.position);
  assert.equal(after.nftCount,before.nftCount);assert.deepEqual(after.allowances,before.allowances);
  next.phase='halted';next.haltReason=`transaction_reverted:${action.id}`;
  return {state:next,facts,status:'reverted' as const};
 }
 const events=facts.liquidityEvents,usdg=BigInt(facts.walletDeltas.usdg),nvda=BigInt(facts.walletDeltas.nvda);
 const unchangedPosition=()=>{assert.deepEqual(after.position,before.position);assert.equal(after.nftCount,before.nftCount);assert.equal(events.length,0);assert.equal(facts.nfts.length,0);};
 const unchangedAllowances=()=>{
  for(const old of before.allowances){const now=after.allowances.find(x=>same(x.token,old.token)&&same(x.spender,old.spender));assert(now);
   if(plan.kind==='approve'&&same(old.token,plan.token)&&same(old.spender,plan.spender))assert.equal(now.amount,plan.amount);
   else {
    const spender=plan.kind==='swap'?action.intent.to:NONFUNGIBLE_POSITION_MANAGER;
    const spend=plan.kind==='swap'&&same(old.token,plan.token===0?USDG:PAPER_NVDA)?BigInt(plan.amountIn):
     plan.kind==='mint'?-(same(old.token,USDG)?usdg:nvda):0n;
    const expected=same(old.spender,spender)?BigInt(old.amount)-spend:BigInt(old.amount);
    assert.equal(BigInt(now.amount),expected,'Unexpected allowance change');
   }
  }
 };
 unchangedAllowances();
 if(plan.kind==='approve') {unchangedPosition();assert.equal(usdg,0n);assert.equal(nvda,0n);}
 else if(plan.kind==='swap') {
  unchangedPosition();const spent=plan.token===0?-usdg:-nvda,received=plan.token===0?nvda:usdg;
  assert.equal(spent,BigInt(plan.amountIn));assert(received>=BigInt(plan.minOut),'Swap minimum not met');
  next.swapDone=true;
  if(!next.benchmark&&state.phase==='entry')next.benchmark={usdg:String(BigInt(after.usdg)-BigInt(state.reserveUsdg)),nvda:after.nvda};
 }else if(plan.kind==='mint') {
  assert.equal(facts.nfts.length,1);const nft=facts.nfts[0]!;
  assert(same(nft.from,zeroAddress)&&same(nft.to,state.operator),'Mint did not create an owned NFT');
  assert.equal(events.length,1);const mint=events[0]!;assert.equal(mint.kind,'IncreaseLiquidity');assert.equal(mint.tokenId,nft.tokenId);
  const p=after.position;assert(p&&p.tokenId===nft.tokenId&&same(p.owner,state.operator));
  assert(same(p.token0,USDG)&&same(p.token1,PAPER_NVDA)&&p.fee===500);
  assert.equal(p.tickLower,plan.tickLower);assert.equal(p.tickUpper,plan.tickUpper);assert(BigInt(p.liquidity)>0n);
  assert.equal(p.liquidity,mint.liquidity);assert.equal(p.tokensOwed0,'0');assert.equal(p.tokensOwed1,'0');
  assert.equal(BigInt(after.nftCount),BigInt(before.nftCount)+1n);
  assert.equal(-usdg,BigInt(mint.amount0));assert.equal(-nvda,BigInt(mint.amount1));
  assert(-usdg>=BigInt(plan.min0)&&-usdg<=BigInt(plan.amount0));assert(-nvda>=BigInt(plan.min1)&&-nvda<=BigInt(plan.amount1));
  next.tokenId=nft.tokenId;next.phase=next.desired==='running'?'holding':'exit';next.range=null;next.swapDone=false;
 }else {
  assert.equal(facts.nfts.length,0);assert.equal(after.nftCount,before.nftCount);assert.equal(events.length,2);
  const decrease=events.find(e=>e.kind==='DecreaseLiquidity'),collect=events.find(e=>e.kind==='Collect');assert(decrease&&collect);
  assert(collect.recipient&&same(collect.recipient,state.operator),'Collection went to another recipient');
  assert.equal(decrease.tokenId,plan.tokenId);assert.equal(collect.tokenId,plan.tokenId);assert.equal(decrease.liquidity,plan.liquidity);
  assert(BigInt(decrease.amount0)>=BigInt(plan.min0)&&BigInt(decrease.amount1)>=BigInt(plan.min1));
  assert.equal(usdg,BigInt(collect.amount0));assert.equal(nvda,BigInt(collect.amount1));
  const fee0=usdg-BigInt(decrease.amount0),fee1=nvda-BigInt(decrease.amount1);assert(fee0>=0n&&fee1>=0n);
  assert(after.position&&same(after.position.owner,state.operator)&&after.position.tokenId===plan.tokenId);
  assert.equal(after.position.liquidity,'0');assert.equal(after.position.tokensOwed0,'0');assert.equal(after.position.tokensOwed1,'0');
  next.collectedFee0=String(BigInt(state.collectedFee0)+fee0);next.collectedFee1=String(BigInt(state.collectedFee1)+fee1);
  next.retiredTokenIds.push(plan.tokenId);next.tokenId=null;next.range=null;next.swapDone=false;
 }
 return {state:next,facts,status:'confirmed' as const};
}
