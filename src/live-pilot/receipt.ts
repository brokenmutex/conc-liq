import assert from 'node:assert/strict';
import {decodeEventLog,parseAbi,toEventSelector,type Address,type Hex} from 'viem';
import {NONFUNGIBLE_POSITION_MANAGER,USDG} from '../constants.js';import {PAPER_NVDA} from '../paper/engine.js';
const events=parseAbi([
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event DecreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
 'event Collect(uint256 indexed tokenId,address recipient,uint256 amount0,uint256 amount1)',
]);
const transferTopic=toEventSelector('Transfer(address,address,uint256)');
const managerTopics=new Set(['IncreaseLiquidity(uint256,uint128,uint256,uint256)','DecreaseLiquidity(uint256,uint128,uint256,uint256)','Collect(uint256,address,uint256,uint256)'].map(toEventSelector));
const nftAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
export interface PilotReceipt {transactionHash:Hex;blockHash:Hex;blockNumber:bigint;status:'success'|'reverted';gasUsed:bigint;effectiveGasPrice:bigint;
 logs:readonly {address:Address;data:Hex;topics:readonly Hex[]}[]}
/** Receipt facts, not a complete balance/NFT reconciliation or an LP fee estimate. */
export function pilotReceiptFacts(receipt:PilotReceipt,operator:Address){
 assert(receipt.gasUsed>0n&&receipt.effectiveGasPrice>=0n);
 assert(receipt.status==='success'||receipt.logs.length===0,'Reverted receipt cannot contain logs');
 const wallet={usdg:0n,nvda:0n},nfts:{from:string;to:string;tokenId:string}[]=[],liquidityEvents:{kind:string;tokenId:string;liquidity?:string;amount0:string;amount1:string}[]=[];
 for(const log of receipt.logs){
  const address=log.address.toLowerCase();if(![USDG.toLowerCase(),PAPER_NVDA,NONFUNGIBLE_POSITION_MANAGER.toLowerCase()].includes(address))continue;
  const manager=address===NONFUNGIBLE_POSITION_MANAGER.toLowerCase(),topic=log.topics[0]?.toLowerCase();
  if(manager&&topic===transferTopic){
   const e=decodeEventLog({abi:nftAbi,data:log.data,topics:log.topics as [Hex,...Hex[]]});
   nfts.push({from:e.args.from,to:e.args.to,tokenId:String(e.args.tokenId)});continue;
  }
  if(!topic||!(manager?managerTopics.has(topic as Hex):topic===transferTopic))continue;
  const e=decodeEventLog({abi:events,data:log.data,topics:log.topics as [Hex,...Hex[]]});
  if(e.eventName==='Transfer'){
   const a=e.args;if(address===NONFUNGIBLE_POSITION_MANAGER.toLowerCase())continue;
   const key=address===USDG.toLowerCase()?'usdg':'nvda';if(a.from.toLowerCase()===operator.toLowerCase())wallet[key]-=a.value;if(a.to.toLowerCase()===operator.toLowerCase())wallet[key]+=a.value;
  }else if(address===NONFUNGIBLE_POSITION_MANAGER.toLowerCase())liquidityEvents.push({kind:e.eventName,tokenId:String(e.args.tokenId),amount0:String(e.args.amount0),amount1:String(e.args.amount1),...('liquidity' in e.args?{liquidity:String(e.args.liquidity)}:{})});
 }
 assert(receipt.status==='success'||(!nfts.length&&!liquidityEvents.length&&wallet.usdg===0n&&wallet.nvda===0n),'Reverted receipt cannot contain accepted transfers');
 return {transactionHash:receipt.transactionHash,block: String(receipt.blockNumber),blockHash:receipt.blockHash,status:receipt.status,
  gasWei:String(receipt.gasUsed*receipt.effectiveGasPrice),walletDeltas:{usdg:String(wallet.usdg),nvda:String(wallet.nvda)},nfts,liquidityEvents,
  reconciled:false as const,lpFeeIncome:null};
}
