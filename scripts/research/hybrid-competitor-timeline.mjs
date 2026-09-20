// Deterministic compact timeline from the retained bounded AMC capture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';

const [root,output]=process.argv.slice(2);
assert(root&&output&&!existsSync(output),'Usage: node scripts/research/hybrid-competitor-timeline.mjs CAPTURE_ROOT NEW_OUTPUT');
const read=path=>JSON.parse(readFileSync(path,'utf8')),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const analysisPath=root+'/analysis.json',capturePath=root+'/capture.json',analysis=read(analysisPath),capture=read(capturePath);
assert.equal(hash(analysisPath),'5233eadf080f0f7f53591dca08c4c69ad194e6ec940eee2e7874c2092040411f');
assert.equal(hash(capturePath),'5fcb5df0520c1347a5b442b0bb53179adf19d996db467eddc882101002ebc7a3');
assert.equal(analysis.dayAmcSwaps.length,52);
const transactions=new Map(Object.entries(capture.transactions).map(([transactionHash,transaction])=>[transactionHash.toLowerCase(),{transactionHash,...transaction}]));
const actions=capture.positions.flatMap(position=>position.events.map(event=>({...event,tokenId:position.id})))
  .filter(event=>event.kind==='Mint'||event.kind==='Burn').sort((a,b)=>a.at-b.at||a.block-b.block||a.index-b.index);
function neighboring(at){
  let before=null,after=null;for(const action of actions){if(action.at<=at)before=action;else{after=action;break;}}
  const compact=action=>action?{tokenId:action.tokenId,kind:action.kind,hash:action.hash,at:new Date(action.at).toISOString(),liquidity:action.liquidity}:null;
  return {before:compact(before),after:compact(after)};
}
function liveLiquidity(at){
  let total=0n,positions=0;
  for(const position of capture.positions){let liquidity=0n;for(const event of position.events){if(event.at>at)break;
      if(event.kind==='Mint')liquidity+=BigInt(event.liquidity);else if(event.kind==='Burn')liquidity-=BigInt(event.liquidity);}
    assert(liquidity>=0n);if(liquidity>0n){positions++;total+=liquidity;}}
  return {positions,liquidity:String(total)};
}
const timeline=analysis.dayAmcSwaps.map(item=>{
  const tx=transactions.get(item.hash.toLowerCase()),receipt=capture.receipts[item.hash.toLowerCase()]?.raw;
  const events=item.events.filter(event=>event.address.toLowerCase()===capture.anchor.pool.toLowerCase());
  assert(tx&&receipt&&events.length>0);let amount0=0n,amount1=0n;for(const event of events){amount0+=BigInt(event.args.amount0);amount1+=BigInt(event.args.amount1);}
  assert((amount0<0n&&amount1>0n)||(amount0>0n&&amount1<0n));
  return {hash:item.hash,block:Number(BigInt(receipt.blockNumber)),at:item.at,sender:item.from,router:item.to,routeLegs:events.length,
    amount0:String(amount0),amount1:String(amount1),direction:amount0<0n?'buy_amc_with_usdg':'sell_amc_for_usdg',
    liveCohort:liveLiquidity(Date.parse(item.at)),neighboringLpActions:neighboring(Date.parse(item.at)),
    walletBalances:{status:'unavailable',reason:'per_transaction_balance_reconstruction_not_retained_in_compact_analysis'},
    ownFlowFeeAttribution:{status:'unavailable',reason:'complete_crossing_and_competing_liquidity_attribution_not_implemented'}};
});
assert.equal(new Set(timeline.map(item=>item.hash)).size,52);
const result={schemaVersion:1,id:'hybrid-lp-250-competitor-timeline-2026-09-20',source:{analysisSha256:hash(analysisPath),captureSha256:hash(capturePath)},
  counts:{cohortPositions:analysis.cohortPositions,fullySettled:analysis.fullySettledPositions,retainingLiquidity:analysis.positionsRetainingLiquidity,
    senderTransactionsWithAmcSwaps:timeline.length,amcSwapEvents:analysis.dayTransactionSummary.amcPoolSwapEvents},timeline,
  behaviors:[
    {observed:'Range placement and inventory swaps are separate transactions',test:'Compare keep, no-swap redeploy, and bounded-swap redeploy'},
    {observed:'Top-ups and partial removals leave idle and residual inventory',test:'Value every wallet and LP token after each stage'},
    {observed:'Some positions overlap and remain open',test:'Use one managed NFT first; do not infer a 47-position requirement'}
  ],executionEligible:false,promotionEligible:false};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,transactions:timeline.length,swapEvents:result.counts.amcSwapEvents}));
