import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {it} from 'node:test';
import type {Address,Hex} from 'viem';
import type {RobinhoodClient} from '../src/client.js';
import {parseRangeKeeperConfig} from '../src/strategy/rangekeeper/config.js';
import {encodeRangeKeeperTx} from '../src/strategy/rangekeeper/calldata.js';
import type {RangeKeeperSnapshot} from '../src/strategy/rangekeeper/live-domain.js';
import {reconcileRangeKeeperWalletReceipt,type RangeKeeperWholeWalletSnapshot} from '../src/deployments/rangekeeper-live-wallet-reconcile.js';

const config=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8')));
const pool=config.pool,operator=config.operator!,sibling='0x7000000000000000000000000000000000000001' as Address;
const hash=(s:string)=>`0x${s.repeat(64)}` as Hex;
function fixture(reverted=false){
 const plan={kind:'approve' as const,token:0 as const,spender:'positionManager' as const,amount:10n};
 const call=encodeRangeKeeperTx(pool,operator,plan);
 const allowances=[pool.token0,pool.token1].flatMap(token=>[pool.router,pool.positionManager].map(spender=>({token,spender,amount:0n})));
 const afterAllowances=allowances.map(a=>({...a,amount:!reverted&&a.token===pool.token0&&a.spender===pool.positionManager?10n:0n}));
 const start={block:100n,hash:hash('a'),timestamp:1000},end={block:101n,hash:hash('b'),timestamp:1001};
 const beforePool={source:start,operator,wallet0:100n,wallet1:50n,nativeWei:1000n,nonce:4,nftCount:0n,
  tick:0,sqrtPriceX96:1n<<96n,unlocked:true,poolLiquidity:100n,allowances,position:null} satisfies RangeKeeperSnapshot;
 const afterPool={...beforePool,source:end,nativeWei:990n,nonce:5,allowances:afterAllowances};
 const beforeWallet:RangeKeeperWholeWalletSnapshot={operator,source:start,nonce:4,nativeWei:1000n,
  tokens:{[pool.token0.toLowerCase()]:100n,[pool.token1.toLowerCase()]:50n,[sibling]:100n},nftTokenIds:[],allowances};
 const afterWallet={...beforeWallet,tokens:{...beforeWallet.tokens},source:end,nonce:5,nativeWei:990n,allowances:afterAllowances};
 const intent={id:'00000000-0000-4000-8000-000000000001',chainId:4663 as const,operator,action:'approve',nonce:4,
  to:call.to,data:call.data,value:'0' as const,gas:'100',maxFeePerGas:'2',maxPriorityFeePerGas:'0',sourceBlock:'100',sourceHash:start.hash};
 const action={plan,before:beforePool,intent,hash:hash('c')};
 const receipt={transactionHash:action.hash,blockNumber:101n,blockHash:end.hash,from:operator,
  status:reverted?'reverted' as const:'success' as const,gasUsed:10n,effectiveGasPrice:1n,logs:[]};
 const tx={hash:action.hash,from:operator,to:call.to,nonce:4,input:call.data,value:0n,gas:100n,
  maxFeePerGas:2n,maxPriorityFeePerGas:0n,blockNumber:101n,blockHash:end.hash};
 let reorg=false,reads=0;
 const client={getChainId:async()=>4663,getTransactionReceipt:async()=>receipt,getTransaction:async()=>tx,
  getBlock:async(arg?:{blockNumber:bigint})=>{
   if(!arg)return {number:165n};reads++;
   const source=arg.blockNumber===100n?start:end;
   return {number:arg.blockNumber,hash:reorg&&reads>2?hash('d'):source.hash,timestamp:BigInt(source.timestamp)};
  },getBalance:async({blockNumber}:{blockNumber:bigint})=>blockNumber===100n?1000n:990n,
  getTransactionCount:async({blockNumber}:{blockNumber:bigint})=>blockNumber===100n?4:5,
  readContract:async({functionName,address,args,blockNumber}:{functionName:string;address:string;args:string[];blockNumber:bigint})=>{
   const wallet=blockNumber===100n?beforeWallet:afterWallet;
   if(functionName==='balanceOf')return address.toLowerCase()===pool.positionManager.toLowerCase()?0n:wallet.tokens[address.toLowerCase()];
   if(functionName==='allowance')return wallet.allowances.find(a=>a.token.toLowerCase()===address.toLowerCase()&&a.spender.toLowerCase()===args[1]!.toLowerCase())!.amount;
   throw Error('Unexpected contract read');
  }} as unknown as RobinhoodClient;
 const allocation={campaignId:'campaign-a',liquidByTokenAddress:{[pool.token0.toLowerCase()]:20n,[pool.token1.toLowerCase()]:10n},
  nativeSpendWei:50n,exitReserveWei:100n,nftTokenIds:[] as string[]};
 const input={client,pool,action,beforeWallet,afterWallet,afterPool,allocation,exitSpendAllowed:false};
 return {input,tx,receipt,setReorg:()=>{reorg=true;}};
}

it('canonical wallet receipt charges only the initiating campaign and preserves sibling token/native allocations',async()=>{
 const f=fixture(),before=structuredClone(f.input.allocation),result=await reconcileRangeKeeperWalletReceipt(f.input);
 assert.equal(result.status,'success');assert.equal(result.gasWei,10n);assert.equal(result.nextNativeSpendWei,40n);
 assert.equal(result.nextExitReserveWei,100n);assert.deepEqual(result.nextLiquidByTokenAddress,before.liquidByTokenAddress);
 assert.deepEqual(f.input.allocation,before);assert.match(result.proofHash,/^[a-f0-9]{64}$/);
});

it('canonical reverted receipts charge gas once without changing capital or NFT custody',async()=>{
 const f=fixture(true),result=await reconcileRangeKeeperWalletReceipt(f.input);
 assert.equal(result.status,'reverted');assert.equal(result.nextNativeSpendWei,40n);
 assert.deepEqual(result.nextLiquidByTokenAddress,f.input.allocation.liquidByTokenAddress);
 assert.deepEqual(result.nextNftTokenIds,[]);
});

it('another token delta, nonce or mined transaction mismatch cannot be attributed to this campaign',async()=>{
 const token=fixture();token.input.afterWallet.tokens[sibling]=99n;
 await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(token.input),/Another pool token changed/);
 const nonce=fixture();nonce.tx.nonce=5;await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(nonce.input));
 const tx=fixture();tx.tx.input='0x' as Hex;await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(tx.input));
});

it('a prepared position cannot be borrowed from another campaign allocation',async()=>{
 const f=fixture();
 f.input.allocation.nftTokenIds=['7'];
 await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(f.input),/Prepared position differs from campaign custody/);
});

it('a non-exit stage cannot spend exit reserves and even exit cannot invade sibling native funds',async()=>{
 const f=fixture();f.input.allocation.nativeSpendWei=5n;
 await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(f.input),/exit reserve/);
 const exit=await reconcileRangeKeeperWalletReceipt({...f.input,exitSpendAllowed:true});
 assert.equal(exit.nextNativeSpendWei,0n);assert.equal(exit.nextExitReserveWei,95n);
 f.input.allocation.exitReserveWei=4n;
 await assert.rejects(()=>reconcileRangeKeeperWalletReceipt({...f.input,exitSpendAllowed:true}),/sibling native/);
});

it('reorg during canonical accounting reads invalidates all attribution output',async()=>{
 const f=fixture();f.setReorg();await assert.rejects(()=>reconcileRangeKeeperWalletReceipt(f.input),/Canonical source changed/);
});
