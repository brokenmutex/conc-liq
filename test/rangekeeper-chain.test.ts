import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeAbiParameters,encodeEventTopics,parseAbi,type Address,type Hex} from 'viem';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {encodeRangeKeeperTx,authorizeRangeKeeperTx} from '../src/strategy/rangekeeper/calldata.js';
import {rangeKeeperReceiptFacts} from '../src/strategy/rangekeeper/receipt.js';
import {paperRouterAbi} from '../src/paper/execution-abi.js';
import type {RangeKeeperPool} from '../src/strategy/rangekeeper/domain.js';

const addr=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const hash=`0x${'ab'.repeat(32)}` as const;
const pool:RangeKeeperPool={chainId:4663,factory:addr(1),pool:addr(2),token0:addr(3),token1:addr(4),quoteToken:1,
 decimals0:18,decimals1:6,fee:3000,tickSpacing:60,positionManager:addr(5),router:addr(6),quoter:addr(7),
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:'base/USD',reference1:'quote/USD',nativeReference:'ETH/USD',numeraire:'USD'};

test('generic swap calldata uses address order and configured tier regardless of quote side',()=>{
 const operator=addr(10),p={kind:'swap' as const,token:1 as const,amountIn:1_000_000n,minOut:123n,deadline:1200n};
 authorizeRangeKeeperTx(pool,{operator,wallet0:0n,wallet1:2_000_000n,tick:0,sqrtPriceX96:sqrtRatioAtTick(0),timestamp:1000,position:null},p,50,20);
 const outer=encodeRangeKeeperTx(pool,operator,p);
 assert.equal(outer.to,pool.router);
 const decoded=decodeFunctionData({abi:paperRouterAbi,data:outer.data});assert.equal(decoded.functionName,'multicall');
 if(decoded.functionName!=='multicall')throw Error('wrong call');
 const nested=decodeFunctionData({abi:paperRouterAbi,data:decoded.args[1][0]!});assert.equal(nested.functionName,'exactInputSingle');
 if(nested.functionName!=='exactInputSingle')throw Error('wrong nested call');
 assert.equal(nested.args[0].tokenIn,pool.token1);assert.equal(nested.args[0].tokenOut,pool.token0);
 assert.equal(nested.args[0].fee,3000);
});

test('future acquired-token approval is finite and restricted to the position manager',()=>{
 const wallet={operator:addr(10),wallet0:0n,wallet1:0n,tick:0,
  sqrtPriceX96:sqrtRatioAtTick(0),timestamp:1000,position:null};
 const grant={kind:'approve' as const,token:0 as const,spender:'positionManager' as const,amount:500n};
 assert.throws(()=>authorizeRangeKeeperTx(pool,wallet,grant,50,20),/bounded future strategy token/);
 assert.doesNotThrow(()=>authorizeRangeKeeperTx(pool,wallet,grant,50,20,500n));
 assert.throws(()=>authorizeRangeKeeperTx(pool,wallet,grant,50,20,499n),/bounded future strategy token/);
 assert.throws(()=>authorizeRangeKeeperTx(pool,wallet,{...grant,spender:'router'},50,20,500n),
  /Only position-manager approval/);
});

test('generic receipt recognizes raw token deltas by address with reversed quote order',()=>{
 const abi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
 const operator=addr(10),router=pool.router;
 const log=(token:Address,from:Address,to:Address,value:bigint)=>({address:token,
  topics:encodeEventTopics({abi,eventName:'Transfer',args:{from,to}}).filter((t):t is Hex=>typeof t==='string'),
  data:encodeAbiParameters([{type:'uint256'}],[value])});
 const facts=rangeKeeperReceiptFacts(pool,operator,{transactionHash:hash,blockHash:hash,blockNumber:1n,status:'success',gasUsed:100n,effectiveGasPrice:2n,
  logs:[log(pool.token1,operator,router,1_000_000n),log(pool.token0,router,operator,123n)]});
 assert.equal(facts.wallet0,123n);assert.equal(facts.wallet1,-1_000_000n);assert.equal(facts.gasWei,200n);
});
