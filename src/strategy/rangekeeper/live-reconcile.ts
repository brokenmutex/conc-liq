import assert from 'node:assert/strict';
import {zeroAddress,type Address} from 'viem';
import type {RangeKeeperPool} from './domain.js';
import {rangeKeeperReceiptFacts,proveRangeKeeperCollection,type RangeKeeperReceipt} from './receipt.js';
import type {RangeKeeperLiveAction,RangeKeeperSnapshot} from './live-domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function mintedRangeKeeperTokenId(pool:RangeKeeperPool,operator:Address,receipt:RangeKeeperReceipt){
 const facts=rangeKeeperReceiptFacts(pool,operator,receipt);
 const created=facts.nfts.filter(n=>same(n.from,zeroAddress)&&same(n.to,operator));
 assert.equal(created.length,1,'Mint receipt did not create exactly one owned NFT');
 return created[0]!.tokenId;
}

/** Receipt block/hash canonicality must be proved by the caller before this
 * function. It rejects any unexplained token, native, nonce, NFT, or approval
 * delta. A reverted receipt remains a charged, non-retryable action. */
export function reconcileRangeKeeperAction(pool:RangeKeeperPool,action:Pick<RangeKeeperLiveAction,'hash'|'plan'|'before'|'intent'>,
 receipt:RangeKeeperReceipt,after:RangeKeeperSnapshot){
 const before=action.before,plan=action.plan,operator=before.operator;
 assert(action.hash&&same(action.hash,receipt.transactionHash),'Receipt hash differs from signed intent');
 assert.equal(receipt.blockNumber,after.source.block);assert(same(receipt.blockHash,after.source.hash));
 assert(receipt.gasUsed<=BigInt(action.intent.gas)&&receipt.effectiveGasPrice<=BigInt(action.intent.maxFeePerGas),
  'Receipt exceeds signed gas envelope');
 assert(same(before.operator,after.operator)&&same(operator,action.intent.operator));
 assert.equal(after.nonce,before.nonce+1,'Wallet nonce changed outside the action');
 const facts=rangeKeeperReceiptFacts(pool,operator,receipt);
 assert.equal(after.wallet0-before.wallet0,facts.wallet0,'Unexplained token0 balance change');
 assert.equal(after.wallet1-before.wallet1,facts.wallet1,'Unexplained token1 balance change');
 assert.equal(before.nativeWei-after.nativeWei,facts.gasWei,'Unexplained native balance change');
 const spender=(p:'router'|'positionManager')=>p==='router'?pool.router:pool.positionManager;
 const token=(i:0|1)=>i===0?pool.token0:pool.token1;
 for(const old of before.allowances){
  const next=after.allowances.find(a=>same(a.token,old.token)&&same(a.spender,old.spender));assert(next,'Allowance pair vanished');
  let expected=old.amount;
  if(receipt.status==='success'){
   if(plan.kind==='approve'&&same(old.token,token(plan.token))&&same(old.spender,spender(plan.spender)))expected=plan.amount;
   if(plan.kind==='swap'&&same(old.token,token(plan.token))&&same(old.spender,pool.router))expected-=plan.amountIn;
   if(plan.kind==='mint'&&same(old.spender,pool.positionManager)){
    expected-=same(old.token,pool.token0)?-facts.wallet0:-facts.wallet1;
   }
  }
  assert.equal(next.amount,expected,'Unexplained allowance change');
 }
 if(receipt.status==='reverted'){
  assert.equal(after.nftCount,before.nftCount);assert.deepEqual(after.position,before.position);
  return {facts,createdTokenId:null,collection:null,actualSwapInput:null,actualSwapOutput:null,gasWei:facts.gasWei,status:'reverted' as const};
 }
 if(plan.kind==='approve'){
  assert.equal(facts.wallet0,0n);assert.equal(facts.wallet1,0n);
  assert.equal(after.nftCount,before.nftCount);assert.deepEqual(after.position,before.position);
  assert.equal(facts.nfts.length,0);assert.equal(facts.managerEvents.length,0);assert.equal(facts.poolCollections.length,0);
 }else if(plan.kind==='swap'){
  assert(!before.position||before.position.liquidity===0n,'Swap before withdrawal');
  const spent=plan.token===0?-facts.wallet0:-facts.wallet1;
  const received=plan.token===0?facts.wallet1:facts.wallet0;
  assert.equal(spent,plan.amountIn);assert(received>=plan.minOut,'Swap output below minimum');
  assert.equal(after.nftCount,before.nftCount);assert.deepEqual(after.position,before.position);
  assert.equal(facts.nfts.length,0);assert.equal(facts.managerEvents.length,0);assert.equal(facts.poolCollections.length,0);
 }else if(plan.kind==='mint'){
  const created=mintedRangeKeeperTokenId(pool,operator,receipt);
  assert.equal(after.nftCount,before.nftCount+1n);
  assert.equal(facts.managerEvents.length,1);
  const event=facts.managerEvents[0]!;
  assert.equal(event.kind,'IncreaseLiquidity');assert.equal(event.tokenId,created);
  assert.equal(-facts.wallet0,event.amount0);assert.equal(-facts.wallet1,event.amount1);
  assert(-facts.wallet0>=plan.candidate.amount0Min&&-facts.wallet0<=plan.candidate.amount0Desired);
  assert(-facts.wallet1>=plan.candidate.amount1Min&&-facts.wallet1<=plan.candidate.amount1Desired);
  const pos=after.position;assert(pos&&pos.tokenId===created&&same(pos.owner,operator));
  assert(same(pos.token0,pool.token0)&&same(pos.token1,pool.token1)&&pos.fee===pool.fee);
  assert.equal(pos.tickLower,plan.candidate.range.tickLower);assert.equal(pos.tickUpper,plan.candidate.range.tickUpper);
  assert(pos.liquidity>0n&&pos.liquidity===event.liquidity);
  assert.equal(pos.tokensOwed0,0n);assert.equal(pos.tokensOwed1,0n);
  assert.equal(facts.poolCollections.length,0);
 }else{
  const prior=before.position,post=after.position;
  assert(prior&&post&&prior.tokenId===plan.tokenId&&post.tokenId===plan.tokenId);
  assert.equal(after.nftCount,before.nftCount);assert.equal(facts.nfts.length,0);
  assert.equal(prior.liquidity,plan.liquidity);assert.equal(post.liquidity,0n);
  assert.equal(post.tokensOwed0,0n);assert.equal(post.tokensOwed1,0n);
  assert(same(post.owner,operator)&&same(post.token0,pool.token0)&&same(post.token1,pool.token1));
  assert.equal(post.fee,pool.fee);assert.equal(post.tickLower,prior.tickLower);assert.equal(post.tickUpper,prior.tickUpper);
  const proof=proveRangeKeeperCollection({pool,operator,tokenId:plan.tokenId,
   tickLower:prior.tickLower,tickUpper:prior.tickUpper,facts});
  const burned=facts.managerEvents.find(e=>e.kind==='DecreaseLiquidity');assert(burned);
  assert(burned.amount0>=plan.min0&&burned.amount1>=plan.min1,'Withdrawal principal below minimum');
  return {facts,createdTokenId:null,collection:proof,actualSwapInput:null,actualSwapOutput:null,
   gasWei:facts.gasWei,status:'success' as const};
 }
 return {facts,createdTokenId:plan.kind==='mint'?after.position!.tokenId:null,collection:null,
  actualSwapInput:plan.kind==='swap'?plan.amountIn:null,
  actualSwapOutput:plan.kind==='swap'?(plan.token===0?facts.wallet1:facts.wallet0):null,
  gasWei:facts.gasWei,status:'success' as const};
}
