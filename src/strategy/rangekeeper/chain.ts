import assert from 'node:assert/strict';
import {keccak256,parseAbi,type Address,type Hex} from 'viem';
import type {RobinhoodClient} from '../../client.js';
import {factoryAbi,poolAbi} from '../../abi.js';
import {ROBINHOOD_CHAIN_ID,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../../constants.js';
import {PAPER_QUOTER,PAPER_ROUTER,PAPER_ROUTER_CODE_HASH,paperQuoterAbi,paperRouterAbi,paperTokenAbi} from '../../paper/execution-abi.js';
import {guardedCanaryPositionManagerAbi} from '../../canary-plan/abi.js';
import {nonfungiblePositionManagerReadAbi} from '../../nft/abi.js';
import {rawValue,type SwapQuote} from './planner.js';
import type {RangeKeeperPool} from './domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const nftBalanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
export interface RangeKeeperSource {block:bigint;hash:Hex;timestamp:number}

/** Address-based read adapter. It has no signer or broadcast API. */
export class RangeKeeperChain {
 constructor(readonly client:RobinhoodClient,readonly pool:RangeKeeperPool,
  readonly extraAllowancePairs:readonly {token:Address;spender:Address}[]=[]){}
 async verify(source:RangeKeeperSource){
  const {client:c,pool:p}=this,b=source.block;
  assert.equal(p.chainId,ROBINHOOD_CHAIN_ID,'Unsupported chain');
  assert(same(p.factory,UNISWAP_V3_FACTORY)&&same(p.positionManager,NONFUNGIBLE_POSITION_MANAGER)
   &&same(p.router,PAPER_ROUTER)&&same(p.quoter,PAPER_QUOTER),'Contract is not an approved deployment');
  assert.equal(await c.getChainId(),p.chainId);
  const block=await c.getBlock({blockNumber:b});assert(same(block.hash,source.hash)&&Number(block.timestamp)===source.timestamp,'Source changed');
  const [factoryPool,poolCode,routerCode,managerCode,quoterCode,token0Code,token1Code,managerFactory,routerFactory,routerManager,quoterFactory,
   token0,token1,fee,spacing,decimals0,decimals1]=await Promise.all([
   c.readContract({address:p.factory,abi:factoryAbi,functionName:'getPool',args:[p.token0,p.token1,p.fee],blockNumber:b}),
   c.getBytecode({address:p.pool,blockNumber:b}),c.getBytecode({address:p.router,blockNumber:b}),
   c.getBytecode({address:p.positionManager,blockNumber:b}),c.getBytecode({address:p.quoter,blockNumber:b}),
   c.getBytecode({address:p.token0,blockNumber:b}),c.getBytecode({address:p.token1,blockNumber:b}),
   c.readContract({address:p.positionManager,abi:guardedCanaryPositionManagerAbi,functionName:'factory',blockNumber:b}),
   c.readContract({address:p.router,abi:paperRouterAbi,functionName:'factory',blockNumber:b}),
   c.readContract({address:p.router,abi:paperRouterAbi,functionName:'positionManager',blockNumber:b}),
   c.readContract({address:p.quoter,abi:paperQuoterAbi,functionName:'factory',blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'token0',blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'token1',blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'fee',blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'tickSpacing',blockNumber:b}),
   c.readContract({address:p.token0,abi:paperTokenAbi,functionName:'decimals',blockNumber:b}),
   c.readContract({address:p.token1,abi:paperTokenAbi,functionName:'decimals',blockNumber:b}),
  ]);
  assert(same(factoryPool,p.pool)&&same(managerFactory,p.factory)&&same(routerFactory,p.factory)&&same(routerManager,p.positionManager)&&same(quoterFactory,p.factory),'Deployment relation mismatch');
  assert([poolCode,managerCode,quoterCode,token0Code,token1Code].every(code=>code&&code!=='0x'),'Missing contract bytecode');
  assert(routerCode&&keccak256(routerCode)===PAPER_ROUTER_CODE_HASH,'Router code changed');
  assert(same(keccak256(poolCode!),p.poolCodeHash)&&same(keccak256(token0Code!),p.token0CodeHash)
   &&same(keccak256(token1Code!),p.token1CodeHash)&&same(keccak256(managerCode!),p.managerCodeHash)
   &&same(keccak256(quoterCode!),p.quoterCodeHash),'Profile bytecode changed');
  assert(same(token0,p.token0)&&same(token1,p.token1)&&fee===p.fee&&spacing===p.tickSpacing&&decimals0===p.decimals0&&decimals1===p.decimals1,'Pool identity mismatch');
  assert(same((await c.getBlock({blockNumber:b})).hash,source.hash),'Source reorged during verification');
  return {source,poolCodeHash:keccak256(poolCode!),token0CodeHash:keccak256(token0Code!),token1CodeHash:keccak256(token1Code!),
   managerCodeHash:keccak256(managerCode!),quoterCodeHash:keccak256(quoterCode!)};
 }
 async snapshot(source:RangeKeeperSource,operator:Address,tokenId:bigint|null){
  const {client:c,pool:p}=this,b=source.block;
  const [wallet0,wallet1,nativeWei,nonce,nftCount,slot,poolLiquidity,position]=await Promise.all([
   c.readContract({address:p.token0,abi:paperTokenAbi,functionName:'balanceOf',args:[operator],blockNumber:b}),
   c.readContract({address:p.token1,abi:paperTokenAbi,functionName:'balanceOf',args:[operator],blockNumber:b}),
   c.getBalance({address:operator,blockNumber:b}),c.getTransactionCount({address:operator,blockNumber:b}),
   c.readContract({address:p.positionManager,abi:nftBalanceAbi,functionName:'balanceOf',args:[operator],blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'slot0',blockNumber:b}),
   c.readContract({address:p.pool,abi:poolAbi,functionName:'liquidity',blockNumber:b}),
   tokenId===null?null:Promise.all([
    c.readContract({address:p.positionManager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',args:[tokenId],blockNumber:b}),
    c.readContract({address:p.positionManager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[tokenId],blockNumber:b})]),
  ]);
  const pairs=[...([p.token0,p.token1] as const).flatMap(token=>[p.router,p.positionManager].map(spender=>({token,spender}))),
   ...this.extraAllowancePairs];
  const allowances=[];for(const {token,spender} of pairs)
   allowances.push({token,spender,amount:await c.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[operator,spender],blockNumber:b})});
  assert(same((await c.getBlock({blockNumber:b})).hash,source.hash),'Snapshot source changed');
  const pos=position?{tokenId,owner:position[0],token0:position[1][2],token1:position[1][3],fee:position[1][4],
   tickLower:position[1][5],tickUpper:position[1][6],liquidity:position[1][7],tokensOwed0:position[1][10],tokensOwed1:position[1][11]}:null;
  if(pos)assert(same(pos.owner,operator)&&same(pos.token0,p.token0)&&same(pos.token1,p.token1)&&pos.fee===p.fee,'NFT identity mismatch');
  return {source,operator,wallet0,wallet1,nativeWei,nonce,nftCount,tick:slot[1],sqrtPriceX96:slot[0],unlocked:slot[6],poolLiquidity,
   allowances,position:pos};
 }
 async quote(source:RangeKeeperSource,token:0|1,amountIn:bigint,price0:bigint,price1:bigint):Promise<SwapQuote>{
  const p=this.pool;assert(amountIn>0n&&price0>0n&&price1>0n);
  const tokenIn=token===0?p.token0:p.token1,tokenOut=token===0?p.token1:p.token0;
  const q=await this.client.simulateContract({address:p.quoter,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber:source.block,
   args:[{tokenIn,tokenOut,amountIn,fee:p.fee,sqrtPriceLimitX96:0n}]});
  const inputValue=rawValue(amountIn,token===0?price0:price1,token===0?p.decimals0:p.decimals1);
  const outputValue=rawValue(q.result[0],token===0?price1:price0,token===0?p.decimals1:p.decimals0);
  const feeValue=inputValue*BigInt(p.fee)/1_000_000n;
  // Shortfall excludes the explicit pool fee; principal conversion is not a cost.
  const shortfallValue=inputValue>outputValue+feeValue?inputValue-outputValue-feeValue:0n;
  assert(same((await this.client.getBlock({blockNumber:source.block})).hash,source.hash),'Quote source changed');
  return {amountOut:q.result[0],priceAfter:q.result[1],feeValue,shortfallValue,sourceBlock:source.block,sourceHash:source.hash};
 }
}
