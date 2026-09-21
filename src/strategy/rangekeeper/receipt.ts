import assert from 'node:assert/strict';
import {decodeEventLog,parseAbi,toEventSelector,type Address,type Hex} from 'viem';
import type {RangeKeeperPool} from './domain.js';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const transfer=toEventSelector('Transfer(address,address,uint256)');
const increase=toEventSelector('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const decrease=toEventSelector('DecreaseLiquidity(uint256,uint128,uint256,uint256)');
const collect=toEventSelector('Collect(uint256,address,uint256,uint256)');
const poolCollect=toEventSelector('Collect(address,address,int24,int24,uint128,uint128)');
const tokenAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const nftAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const managerAbi=parseAbi([
 'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
]);
const poolAbi=parseAbi(['event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)']);
export interface RangeKeeperReceipt {
 transactionHash:Hex;blockHash:Hex;blockNumber:bigint;status:'success'|'reverted';gasUsed:bigint;effectiveGasPrice:bigint;
 logs:readonly {address:Address;data:Hex;topics:readonly Hex[]}[];
}

/** Decode only the configured contract addresses. The caller must independently
 * prove the receipt block canonical and reconcile every wallet/NFT delta. */
export function rangeKeeperReceiptFacts(pool:RangeKeeperPool,operator:Address,receipt:RangeKeeperReceipt){
 assert(receipt.gasUsed>0n&&receipt.effectiveGasPrice>=0n);
 assert(receipt.status==='success'||receipt.logs.length===0,'Revert emitted logs');
 const amounts:[bigint,bigint]=[0n,0n];
 const nfts:{from:Address;to:Address;tokenId:bigint}[]=[];
 const managerEvents:{kind:'IncreaseLiquidity'|'DecreaseLiquidity'|'Collect';tokenId:bigint;amount0:bigint;amount1:bigint;liquidity?:bigint;recipient?:Address}[]=[];
 const poolCollections:{owner:Address;recipient:Address;tickLower:number;tickUpper:number;amount0:bigint;amount1:bigint}[]=[];
 for(const log of receipt.logs){
  const a=log.address,topic=log.topics[0];if(!topic)continue;
  const topics=log.topics as [Hex,...Hex[]];
  if(same(a,pool.token0)||same(a,pool.token1)){
   if(!same(topic,transfer))continue;
   const {args}=decodeEventLog({abi:tokenAbi,data:log.data,topics});
   const index=same(a,pool.token0)?0:1;
   if(same(args.from,operator))amounts[index]-=args.value;
   if(same(args.to,operator))amounts[index]+=args.value;
  }else if(same(a,pool.positionManager)){
   if(same(topic,transfer)){
    const {args}=decodeEventLog({abi:nftAbi,data:log.data,topics});
    nfts.push({from:args.from,to:args.to,tokenId:args.tokenId});
   }else if([increase,decrease,collect].some(t=>same(topic,t))){
    const e=decodeEventLog({abi:managerAbi,data:log.data,topics});
    managerEvents.push({kind:e.eventName,tokenId:e.args.tokenId,amount0:e.args.amount0,amount1:e.args.amount1,
     ...('liquidity' in e.args?{liquidity:e.args.liquidity}:{}),...('recipient' in e.args?{recipient:e.args.recipient}:{})});
   }
  }else if(same(a,pool.pool)&&same(topic,poolCollect)){
   const {args}=decodeEventLog({abi:poolAbi,data:log.data,topics});
   poolCollections.push({owner:args.owner,recipient:args.recipient,tickLower:args.tickLower,tickUpper:args.tickUpper,
    amount0:args.amount0,amount1:args.amount1});
  }
 }
 if(receipt.status==='reverted')assert(amounts[0]===0n&&amounts[1]===0n&&nfts.length===0&&managerEvents.length===0&&poolCollections.length===0);
 return {wallet0:amounts[0],wallet1:amounts[1],gasWei:receipt.gasUsed*receipt.effectiveGasPrice,nfts,managerEvents,poolCollections};
}

export function proveRangeKeeperCollection(input:{pool:RangeKeeperPool;operator:Address;tokenId:bigint;
 tickLower:number;tickUpper:number;facts:ReturnType<typeof rangeKeeperReceiptFacts>}){
 const {pool,operator,tokenId,facts}=input;
 assert.equal(facts.poolCollections.length,1,'Expected one core pool Collect');
 const actual=facts.poolCollections[0]!;
 assert(same(actual.owner,pool.positionManager)&&same(actual.recipient,operator),'Core collection custody mismatch');
 assert.equal(actual.tickLower,input.tickLower);assert.equal(actual.tickUpper,input.tickUpper);
 const decreaseEvents=facts.managerEvents.filter(e=>e.kind==='DecreaseLiquidity'&&e.tokenId===tokenId);
 const collectEvents=facts.managerEvents.filter(e=>e.kind==='Collect'&&e.tokenId===tokenId);
 assert.equal(decreaseEvents.length,1);assert.equal(collectEvents.length,1);
 const burned=decreaseEvents[0]!,requested=collectEvents[0]!;
 assert(requested.recipient&&same(requested.recipient,operator));
 assert.equal(facts.wallet0,actual.amount0,'Core token0 collection differs from wallet transfer');
 assert.equal(facts.wallet1,actual.amount1,'Core token1 collection differs from wallet transfer');
 assert(requested.amount0>=actual.amount0&&requested.amount1>=actual.amount1,'Core payment exceeds manager request');
 assert(actual.amount0>=burned.amount0&&actual.amount1>=burned.amount1,'Collected less than principal');
 return {principal0:burned.amount0,principal1:burned.amount1,fee0:actual.amount0-burned.amount0,fee1:actual.amount1-burned.amount1,
  rounding0:requested.amount0-actual.amount0,rounding1:requested.amount1-actual.amount1};
}
