import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,parseAbi,toHex,type Address,type Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../constants.js';
import {poolAbi,factoryAbi} from '../abi.js';
import {PAPER_NVDA,PAPER_POOL,paperEntryRange} from '../paper/engine.js';
import {PAPER_ROUTER,PAPER_ROUTER_CODE_HASH,PAPER_QUOTER,paperTokenAbi,paperRouterAbi,paperQuoterAbi} from '../paper/execution-abi.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi,readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {replayPaperMint} from '../research/management-audit.js';
import {solveRecenterSwap,assertRecenterPrice} from '../paper/execution-recenter.js';
import {quoteValue} from '../simulator/math.js';
import {marketSession} from '../paper/session-performance.js';
import type {LivePilotConfig} from './config.js';
import type {PilotPlan,PilotSnapshot,PilotState} from './domain.js';
const NVDA=PAPER_NVDA as Address,POOL=PAPER_POOL as Address;
const nftBalanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export interface PilotSource {block:string;hash:Hex;timestamp:string}

export function encodePilotPlan(plan:PilotPlan,operator:Address) {
 if(plan.kind==='approve')return {to:plan.token,data:encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[plan.spender,BigInt(plan.amount)]})};
 if(plan.kind==='swap') {
  const data=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{tokenIn:plan.token===0?USDG:NVDA,tokenOut:plan.token===0?NVDA:USDG,
   fee:500,recipient:operator,amountIn:BigInt(plan.amountIn),amountOutMinimum:BigInt(plan.minOut),sqrtPriceLimitX96:0n}]});
  return {to:PAPER_ROUTER,data:encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',args:[BigInt(plan.deadline),[data]]})};
 }
 if(plan.kind==='mint')return {to:NONFUNGIBLE_POSITION_MANAGER,data:encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[{
  token0:USDG,token1:NVDA,fee:500,tickLower:plan.tickLower,tickUpper:plan.tickUpper,amount0Desired:BigInt(plan.amount0),amount1Desired:BigInt(plan.amount1),
  amount0Min:BigInt(plan.min0),amount1Min:BigInt(plan.min1),recipient:operator,deadline:BigInt(plan.deadline)}]})};
 const calls=[encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{tokenId:BigInt(plan.tokenId),liquidity:BigInt(plan.liquidity),amount0Min:BigInt(plan.min0),amount1Min:BigInt(plan.min1),deadline:BigInt(plan.deadline)}]}),
  encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId:BigInt(plan.tokenId),recipient:operator,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})];
 return {to:NONFUNGIBLE_POSITION_MANAGER,data:encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',args:[calls]})};
}

/** Independent semantic checks before signing, in addition to exact envelope matching. */
export function authorizePilotPlan(plan:PilotPlan,state:PilotState,s:PilotSnapshot) {
 const free=BigInt(s.usdg)-BigInt(state.reserveUsdg);assert(free>=0n);assert(same(s.operator,state.operator));
 const available=(token:Address)=>same(token,USDG)?free:BigInt(s.nvda);
 if(plan.kind==='approve') {
  assert([USDG,NVDA].some(t=>same(t,plan.token))&&[PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].some(a=>same(a,plan.spender)),'Unapproved token or spender');
  assert(BigInt(plan.amount)>=0n&&BigInt(plan.amount)<=available(plan.token),'Approval exceeds managed inventory');
  return;
 }
 assert(BigInt(plan.deadline)>BigInt(s.timestamp)&&BigInt(plan.deadline)<=BigInt(s.timestamp)+300n,'Invalid transaction deadline');
 if(plan.kind==='swap') {
  assert(plan.token===0||plan.token===1);assert(BigInt(plan.amountIn)>0n&&BigInt(plan.amountIn)<=available(plan.token===0?USDG:NVDA));
  assert(BigInt(plan.minOut)>0n&&BigInt(plan.minOut)>=BigInt(plan.quotedOut)*9950n/10000n,'Swap minimum weakened');
  assert(state.phase==='entry'||state.phase==='recenter'||(state.phase==='exit'&&plan.token===1),'Swap outside management operation');
  assert(!s.position||s.position.liquidity==='0','Swap before withdrawal');
 }else if(plan.kind==='mint') {
  assert(state.phase==='entry'||state.phase==='recenter');assert(!s.position||s.position.liquidity==='0');
  assert.equal(plan.tickUpper-plan.tickLower,40);assert.equal(plan.tickLower%10,0);assert.equal(plan.tickUpper%10,0);
  assert(s.tick>=plan.tickLower&&s.tick<plan.tickUpper,'Mint range already crossed');
  assert(BigInt(plan.amount0)>0n&&BigInt(plan.amount0)<=free);assert(BigInt(plan.amount1)>0n&&BigInt(plan.amount1)<=BigInt(s.nvda));
  const p=replayPaperMint(BigInt(s.sqrtPriceX96),plan,BigInt(plan.amount0),BigInt(plan.amount1),0n);assert(p.liquidity>0n);
  assert(BigInt(plan.min0)>=p.amount0*9950n/10000n&&BigInt(plan.min1)>=p.amount1*9950n/10000n,'Mint minimum weakened');
 }else {
  assert(state.phase==='recenter'||state.phase==='exit');const p=s.position;assert(p&&p.tokenId===state.tokenId&&plan.tokenId===p.tokenId);
  assert(same(p.owner,state.operator)&&same(p.token0,USDG)&&same(p.token1,NVDA)&&p.fee===500);
  assert.equal(plan.liquidity,p.liquidity);assert(BigInt(plan.liquidity)>0n);
  const amounts=principalAmounts({...p,liquidity:BigInt(p.liquidity),sqrtPriceX96:BigInt(s.sqrtPriceX96)});
  assert(BigInt(plan.min0)>=amounts.amount0*9950n/10000n&&BigInt(plan.min1)>=amounts.amount1*9950n/10000n);
 }
}

export class PilotChain {
 constructor(readonly client:RobinhoodClient,readonly config:LivePilotConfig,
  readonly valueGas?:(s:PilotSource,wei:string)=>Promise<{quote:string;proof:unknown}>,
  readonly broadcastClient:RobinhoodClient=client) {assert(config.operator);}
 async broadcast(raw:Hex,source:PilotSource) {
  // The archive endpoint may deliberately reject publication. Independently
  // bind the write endpoint to our chain and canonical source before sending.
  assert.equal(await this.broadcastClient.getChainId(),4663,'Broadcast chain mismatch');
  assert(same((await this.broadcastClient.getBlock({blockNumber:BigInt(source.block)})).hash,source.hash),'Broadcast source mismatch');
  return this.broadcastClient.sendRawTransaction({serializedTransaction:raw});
 }
 async verify(source:PilotSource) {
  const c=this.client,blockNumber=BigInt(source.block);assert.equal(await c.getChainId(),4663);
  assert(same((await c.getBlock({blockNumber})).hash,source.hash));
  const code=await c.getBytecode({address:PAPER_ROUTER,blockNumber});assert(code&&keccak256(code)===PAPER_ROUTER_CODE_HASH);
  const [pool,factory,dec0,dec1,fee,spacing,t0,t1]=await Promise.all([
   c.readContract({address:UNISWAP_V3_FACTORY,abi:factoryAbi,functionName:'getPool',args:[USDG,NVDA,500],blockNumber}),
   c.readContract({address:NONFUNGIBLE_POSITION_MANAGER,abi:guardedCanaryPositionManagerAbi,functionName:'factory',blockNumber}),
   ...[USDG,NVDA].map(address=>c.readContract({address,abi:paperTokenAbi,functionName:'decimals',blockNumber})),
   c.readContract({address:POOL,abi:poolAbi,functionName:'fee',blockNumber}),c.readContract({address:POOL,abi:poolAbi,functionName:'tickSpacing',blockNumber}),
   c.readContract({address:POOL,abi:poolAbi,functionName:'token0',blockNumber}),c.readContract({address:POOL,abi:poolAbi,functionName:'token1',blockNumber})]);
  assert(same(String(pool),POOL)&&same(String(factory),UNISWAP_V3_FACTORY)&&dec0===6&&dec1===18&&fee===500&&spacing===10&&same(String(t0),USDG)&&same(String(t1),NVDA));
  const operatorCode=await c.getBytecode({address:this.config.operator!,blockNumber});assert(!operatorCode||operatorCode==='0x','Pilot requires its dedicated EOA');
 }
 async snapshot(source:PilotSource,tokenId:string|null):Promise<PilotSnapshot> {
  const c=this.client,operator=this.config.operator!,blockNumber=BigInt(source.block);
  const [usdg,nvda,native,nonce,nfts,slot,liquidity,position]=await Promise.all([
   c.readContract({address:USDG,abi:paperTokenAbi,functionName:'balanceOf',args:[operator],blockNumber}),
   c.readContract({address:NVDA,abi:paperTokenAbi,functionName:'balanceOf',args:[operator],blockNumber}),
   c.getBalance({address:operator,blockNumber}),c.getTransactionCount({address:operator,blockNumber}),
   c.readContract({address:NONFUNGIBLE_POSITION_MANAGER,abi:nftBalanceAbi,functionName:'balanceOf',args:[operator],blockNumber}),
   c.readContract({address:POOL,abi:poolAbi,functionName:'slot0',blockNumber}),c.readContract({address:POOL,abi:poolAbi,functionName:'liquidity',blockNumber}),
   tokenId?readCanaryPosition(c,BigInt(tokenId),blockNumber):null]);
  const allowances=[];for(const token of [USDG,NVDA])for(const spender of [PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER])allowances.push({token,spender,amount:String(await c.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[operator,spender],blockNumber}))});
  assert(same((await c.getBlock({blockNumber})).hash,source.hash),'Snapshot source changed');
  return {...source,operator,usdg:String(usdg),nvda:String(nvda),native:String(native),nonce:Number(nonce),nftCount:String(nfts),tick:slot[1],sqrtPriceX96:String(slot[0]),poolLiquidity:String(liquidity),unlocked:slot[6],allowances,
   position:position?{...position,tokenId:tokenId!,liquidity:String(position.liquidity),tokensOwed0:String(position.tokensOwed0),tokensOwed1:String(position.tokensOwed1)}:null};
 }
 async quote(s:PilotSnapshot,amount:bigint,token:0|1){
  const q=await this.client.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber:BigInt(s.block),args:[{
   tokenIn:token===0?USDG:NVDA,tokenOut:token===0?NVDA:USDG,amountIn:amount,fee:500,sqrtPriceLimitX96:0n}]});
  return {amountOut:q.result[0],price:q.result[1]};
 }
 async plan(state:PilotState,s:PilotSnapshot):Promise<PilotPlan|null> {
  const minimum=(n:bigint)=>String(n*9950n/10000n),deadline=String(BigInt(s.timestamp)+300n),p=s.position;
  if(p&&BigInt(p.liquidity)>0n){assert(state.phase==='recenter'||state.phase==='exit');const a=principalAmounts({...p,liquidity:BigInt(p.liquidity),sqrtPriceX96:BigInt(s.sqrtPriceX96)});
   return {kind:'withdraw',tokenId:p.tokenId,liquidity:p.liquidity,min0:minimum(a.amount0),min1:minimum(a.amount1),deadline};}
  const free=BigInt(s.usdg)-BigInt(state.reserveUsdg);assert(free>=0n);const rwa=BigInt(s.nvda);
  const approve=(token:Address,spender:Address,amount:bigint):PilotPlan|null=>{
   const current=s.allowances.find(a=>same(a.token,token)&&same(a.spender,spender));assert(current);
   return BigInt(current.amount)<amount?{kind:'approve',token,spender,amount:String(amount)}:null;
  };
  if(state.phase==='exit'){
   if(rwa>0n){const q=await this.quote(s,rwa,1);return approve(NVDA,PAPER_ROUTER,rwa)??{kind:'swap',token:1,amountIn:String(rwa),minOut:minimum(q.amountOut),quotedOut:String(q.amountOut),deadline};}
   const allowance=s.allowances.find(a=>BigInt(a.amount)>0n);return allowance?{kind:'approve',token:allowance.token,spender:allowance.spender,amount:'0'}:null;
  }
  assert(state.phase==='entry'||state.phase==='recenter');
  if(!state.range||s.tick<state.range.tickLower||s.tick>=state.range.tickUpper){state.range=paperEntryRange(s,this.config.strategy);state.swapDone=false;}
  if(!state.swapDone){
   const trade=await solveRecenterSwap(BigInt(s.sqrtPriceX96),state.range,free,rwa,(amount,token)=>this.quote(s,amount,token));
   if(trade.token!==null&&trade.amount>0n){assertRecenterPrice(trade.price,BigInt(s.sqrtPriceX96),50);
    return approve(trade.token===0?USDG:NVDA,PAPER_ROUTER,trade.amount)??{kind:'swap',token:trade.token,amountIn:String(trade.amount),minOut:minimum(trade.amountOut),quotedOut:String(trade.amountOut),deadline};}
   state.swapDone=true;
  }
  const mint=replayPaperMint(BigInt(s.sqrtPriceX96),state.range,free,rwa,0n);assert(mint.liquidity>0n);
  return approve(USDG,NONFUNGIBLE_POSITION_MANAGER,free)??approve(NVDA,NONFUNGIBLE_POSITION_MANAGER,rwa)??{
   kind:'mint',...state.range,amount0:String(free),amount1:String(rwa),min0:minimum(mint.amount0),min1:minimum(mint.amount1),deadline};
 }
 async envelope(state:PilotState,s:PilotSnapshot,plan:PilotPlan) {
  authorizePilotPlan(plan,state,s);const call=encodePilotPlan(plan,state.operator);
  await this.client.call({account:state.operator,to:call.to,data:call.data,blockNumber:BigInt(s.block)});
  const estimated=await this.client.estimateGas({account:state.operator,to:call.to,data:call.data,blockNumber:BigInt(s.block)});
  const block=await this.client.getBlock({blockNumber:BigInt(s.block)});assert(block.baseFeePerGas&&block.baseFeePerGas>0n);
  const gas=(estimated*130n+99n)/100n,fee=block.baseFeePerGas*2n;
  assert(gas<=8000000n);const exitReserve=state.phase==='exit'?0n:1500000n*fee;
  assert(BigInt(s.native)>=(gas*fee)+exitReserve,'Insufficient ETH for action plus recovery reserve');
  return {...call,gas:String(gas),maxFeePerGas:String(fee),maxPriorityFeePerGas:'0',value:'0' as const};
 }
 async mark(s:PilotSnapshot,state:PilotState){
  const p=s.position;let fee0=0n,fee1=0n,amount0=0n,amount1=0n;
  if(p&&BigInt(p.liquidity)>0n){const a=principalAmounts({...p,liquidity:BigInt(p.liquidity),sqrtPriceX96:BigInt(s.sqrtPriceX96)});amount0=a.amount0;amount1=a.amount1;
   const result=await this.client.simulateContract({account:state.operator,address:NONFUNGIBLE_POSITION_MANAGER,abi:canaryExitAbi,functionName:'collect',blockNumber:BigInt(s.block),args:[{tokenId:BigInt(p.tokenId),recipient:state.operator,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]});[fee0,fee1]=result.result;
  }
  const quote=(a:bigint,b:bigint)=>quoteValue({amount0:a,amount1:b,token0:USDG,token1:NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(s.sqrtPriceX96)});
  const nav=quote(BigInt(s.usdg)-BigInt(state.reserveUsdg)+amount0+fee0,BigInt(s.nvda)+amount1+fee1);
  return {snapshot:s,phase:state.phase,marketSession:marketSession(Number(s.timestamp)*1000),navBeforeNativeGasQuote:String(nav),uncollected0:String(fee0),uncollected1:String(fee1),gasSpentWei:state.gasSpentWei,
   benchmarkQuote:state.benchmark?String(quote(BigInt(state.benchmark.usdg),BigInt(state.benchmark.nvda))):null,
   basis:'actual_wallet_nft_principal_and_collect_quote',gasValuationQuote:state.gasSpentQuote,
   netNavQuote:state.gasSpentQuote===null?null:String(nav-BigInt(state.gasSpentQuote))};
 }
}
