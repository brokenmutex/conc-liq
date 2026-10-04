// Chain-side controls for the owned-fork RangeKeeper management qualification. Every mutation here terminates at
// the single branded loopback Anvil created by openPaperFork: wall-clock block pinning, a separately funded swapper
// that moves a pool price, an optional pool reentrancy-lock flip, and token funding of local accounts only.
import assert from 'node:assert/strict';
import {createPublicClient,encodeAbiParameters,encodeFunctionData,http,keccak256,pad,toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {robinhoodChain} from '../../../src/constants.ts';
import {poolAbi} from '../../../src/abi.ts';
import {paperRouterAbi,paperTokenAbi} from '../../../src/paper/execution-abi.ts';
import {nonfungiblePositionManagerReadAbi} from '../../../src/nft/abi.ts';
import {sqrtRatioAtTick} from '../../../src/backtest/principal.ts';

export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hex=n=>`0x${BigInt(n).toString(16)}`;
const MAX_UINT256=(1n<<256n)-1n;

export function createLocalClient(fork){
 return createPublicClient({chain:robinhoodChain,transport:http(fork.localUrl,{retryCount:0,timeout:30_000})});
}

/** Wall-clock block pinning. The product requires every canonical source to be recent (age <= 180 s) and never in
 * the future, so local blocks are stamped with real time; the planner's 300 s persistence, 30 s decision interval
 * and 90 s confirmation window therefore elapse in real time. Mining uses interval 0 so that all confirmation
 * headers share one timestamp (the head-64 confirmed source then carries the pinned time). */
export function createForkClock(fork,local){
 const nowSec=()=>Math.floor(Date.now()/1000);
 const pinNext=async()=>{
  const head=await local.getBlock({blockTag:'latest'});
  const target=Math.max(nowSec(),Number(head.timestamp));
  await fork.rpc('anvil_setNextBlockTimestamp',[target]);
  return target;
 };
 /** Mine a confirmation batch pinned to now. head-64 afterwards is a block stamped with this time. */
 const tick=async(confirmations=65)=>{
  const timestamp=await pinNext();
  await fork.rpc('anvil_mine',[hex(confirmations),'0x0']);
  return {timestamp,head:await local.getBlockNumber({cacheTime:0})};
 };
 return {nowSec,pinNext,tick};
}

const balanceOf=(local,token,owner)=>local.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});

async function sendImpersonated(fork,local,tx,label){
 const hash=await fork.rpc('eth_sendTransaction',[{gas:'0x7a1200',...tx}]);
 assert(/^0x[0-9a-fA-F]{64}$/.test(hash),`${label}: no transaction hash`);
 let receipt=null;const deadline=Date.now()+30_000;
 while(!receipt&&Date.now()<deadline){receipt=await local.getTransactionReceipt({hash}).catch(()=>null);if(!receipt)await sleep(100);}
 assert(receipt,`${label}: transaction was not mined on the owned fork`);
 assert.equal(receipt.status,'success',`${label}: transaction reverted`);
 return receipt;
}

/** Give a LOCAL account an ERC-20 balance on the owned fork. Preferred path: transfer from an impersonated donor that
 * already holds the token. Fallback: overwrite the mapping slot of the proxy, discovered by probing standard layouts
 * (plain mapping at slot 0..12, then the ERC-7201 OpenZeppelin ERC20 namespace) and verified through balanceOf. */
export async function fundErc20(fork,local,{token,to,amount,donor,clock}){
 if(donor){
  const have=await balanceOf(local,token,donor);
  if(have>=amount){
   await fork.rpc('anvil_impersonateAccount',[donor]);
   await fork.rpc('anvil_setBalance',[donor,'0x56bc75e2d63100000']);
   if(clock)await clock.pinNext();
   await sendImpersonated(fork,local,{from:donor,to:token,
    data:encodeFunctionData({abi:paperTokenAbi,functionName:'transfer',args:[to,amount]})},'donor funding');
   const after=await balanceOf(local,token,to);
   assert(after>=amount,'Donor transfer did not fund the local account');
   return {method:'donor_transfer',donorBalanceBefore:String(have)};
  }
 }
 // Plain mapping slots, the OpenZeppelin v4 upgradeable ERC20 `_balances` slot (51) and neighbours, then the ERC-7201 namespace.
 const bases=[...Array.from({length:16},(_,i)=>BigInt(i)),51n,52n,101n,151n,201n,
  BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00')];
 for(const base of bases){
  const key=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[to,base]));
  const original=await fork.rpc('eth_getStorageAt',[token,key,'latest']);
  await fork.rpc('anvil_setStorageAt',[token,key,pad(toHex(amount),{size:32})]);
  if(await balanceOf(local,token,to)===amount)return {method:'storage_slot',slot:String(base)};
  await fork.rpc('anvil_setStorageAt',[token,key,original]);
 }
 throw Error('Could not fund the local account: donor balance too small and no ERC-20 balance slot was found');
}

export async function readSlot0(local,pool){
 const s=await local.readContract({address:pool,abi:poolAbi,functionName:'slot0'});
 return {sqrtPriceX96:s[0],tick:Number(s[1]),unlocked:s[6]};
}
export async function readPoolLiquidity(local,pool){return local.readContract({address:pool,abi:poolAbi,functionName:'liquidity'});}

/** A separately funded fork account that only ever sells token0 (the quote stablecoin) into the pool: that lowers the
 * pool tick. A swap with an exact sqrtPriceLimit stops at the requested tick, so no amount search is needed. */
export async function createPriceMover({fork,local,clock,router}){
 const account=privateKeyToAccount(`0x${'7'.repeat(64)}`),address=account.address;
 await fork.rpc('anvil_setBalance',[address,'0x56bc75e2d63100000']);
 await fork.rpc('anvil_impersonateAccount',[address]);
 const approvals=new Set();
 const ensureApproved=async token=>{
  const key=token.toLowerCase();if(approvals.has(key))return;
  await clock.pinNext();
  await sendImpersonated(fork,local,{from:address,to:token,
   data:encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[router,MAX_UINT256]})},'swapper approve');
  approvals.add(key);
 };
 const fund=async(token,amount,donor)=>({token,...await fundErc20(fork,local,{token,to:address,amount,donor,clock})});
 /** Move one pool's tick DOWN to `targetTick` (token0 in). Returns the observed outcome. */
 const moveTickDownTo=async(pool,targetTick)=>{
  const before=await readSlot0(local,pool.pool);
  assert(targetTick<before.tick,`Pool tick ${before.tick} is already at or below ${targetTick}`);
  const inventory=await balanceOf(local,pool.token0,address);
  assert(inventory>0n,'Price mover holds no token0');
  await ensureApproved(pool.token0);
  const head=await local.getBlock({blockTag:'latest'});
  const inner=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{tokenIn:pool.token0,tokenOut:pool.token1,
   fee:pool.fee,recipient:address,amountIn:inventory,amountOutMinimum:0n,sqrtPriceLimitX96:sqrtRatioAtTick(targetTick)}]});
  const data=encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',args:[head.timestamp+3600n,[inner]]});
  await clock.pinNext();
  const receipt=await sendImpersonated(fork,local,{from:address,to:pool.router,data},'price move swap');
  const after=await readSlot0(local,pool.pool);
  const spent=inventory-await balanceOf(local,pool.token0,address);
  assert(Math.abs(after.tick-targetTick)<=1,
   `Price mover reached tick ${after.tick}, wanted ${targetTick}: it ran out of token0 (spent ${spent} of ${inventory})`);
  return {pool:pool.pool,fromTick:before.tick,toTick:after.tick,targetTick,token0Spent:String(spent),
   transactionHash:receipt.transactionHash,block:String(receipt.blockNumber)};
 };
 return {address,fund,moveTickDownTo,balance:token=>balanceOf(local,token,address)};
}

/** Flip the pool's reentrancy lock (slot0 `unlocked`, bit 240 of storage slot 0 in the Uniswap V3 layout) on the
 * owned fork. A locked pool is a canonical safety condition the planner reads from slot0; the flip is verified by
 * reading slot0() back, and `locked=false` restores it. */
export async function setPoolLocked(fork,local,pool,locked){
 const raw=await fork.rpc('eth_getStorageAt',[pool,'0x0','latest']);
 const bit=1n<<240n,value=BigInt(raw),next=locked?(value&~bit):(value|bit);
 await fork.rpc('anvil_setStorageAt',[pool,'0x0',pad(toHex(next),{size:32})]);
 const slot=await readSlot0(local,pool);
 assert.equal(slot.unlocked,!locked,'Pool slot0 unlocked flag did not change as expected');
 return {before:raw,locked};
}

/** All four token x spender pairs a RangeKeeper wallet can hold an allowance on for one pool profile. */
export async function readAllowancePairs(local,wallet,pool){
 const pairs=[];
 for(const [tokenLabel,token] of [['token0',pool.token0],['token1',pool.token1]])
  for(const [spenderLabel,spender] of [['router',pool.router],['positionManager',pool.positionManager]])
   pairs.push({key:`${tokenLabel}:${spenderLabel}`,token,spender,amount:await local.readContract({address:token,abi:paperTokenAbi,
    functionName:'allowance',args:[wallet,spender]})});
 return pairs;
}

export async function readNft(local,manager,tokenId){
 const id=BigInt(tokenId);
 const [owner,position]=await Promise.all([
  local.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'ownerOf',args:[id]}),
  local.readContract({address:manager,abi:nonfungiblePositionManagerReadAbi,functionName:'positions',args:[id]})]);
 return {tokenId:String(tokenId),owner:owner.toLowerCase(),tickLower:Number(position[5]),tickUpper:Number(position[6]),
  liquidity:position[7],tokensOwed0:position[10],tokensOwed1:position[11],raw:position.map(String)};
}
