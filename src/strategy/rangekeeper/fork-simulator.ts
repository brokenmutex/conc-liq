import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createPublicClient,http,type Address} from 'viem';
import {robinhoodChain} from '../../constants.js';
import {principalAmounts} from '../../backtest/principal.js';
import {RangeKeeperChain,type RangeKeeperSource} from './chain.js';
import {authorizeRangeKeeperTx,encodeRangeKeeperTx,type RangeKeeperTxPlan} from './calldata.js';
import type {RangeKeeperCandidate,RangeKeeperLimits,RangeKeeperPool} from './domain.js';
import {mintedRangeKeeperTokenId,reconcileRangeKeeperAction} from './live-reconcile.js';
import {nextRangeKeeperStage} from './live-stage.js';
import type {RangeKeeperLiveState} from './live-domain.js';
import type {RangeKeeperConfig} from './config.js';

async function freePort(){
 const server=createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
 const address=server.address();assert(address&&typeof address!=='string');
 await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

/** Ephemeral local fork. This is admission evidence only: transactions are
 * impersonated locally and no mainnet key or publishing client is available. */
export async function simulateRangeKeeperCandidate(input:{rpcUrl:string;anvilBinary:string;source:RangeKeeperSource;
 pool:RangeKeeperPool;limits:RangeKeeperLimits;operator:Address;candidate:RangeKeeperCandidate;
 activeTokenId:bigint|null;prices:{price0:bigint;price1:bigint}}){
 const {source,pool,limits,operator,candidate}=input;
 assert(input.rpcUrl&&input.anvilBinary&&candidate.sourceBlock<=source.block&&source.timestamp<=candidate.expiresAt);
 const port=await freePort(),url=`http://127.0.0.1:${port}`;
 const child=spawn(input.anvilBinary,['--fork-url',input.rpcUrl,'--fork-block-number',String(source.block),
  '--chain-id',String(pool.chainId),'--port',String(port),'--silent'],{stdio:'ignore'});
 try{
  const client=createPublicClient({chain:robinhoodChain,transport:http(url,{retryCount:0,timeout:15_000})});
  let ready=false;for(let i=0;i<80;i++){
   if(child.exitCode!==null)break;
   try{if(await client.getChainId()===pool.chainId){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert(ready,'RangeKeeper fork did not start');
  const first=await client.getBlock();assert(same(first.hash,source.hash),'Fork source differs from canonical observation');
  await client.request({method:'anvil_impersonateAccount' as never,params:[operator] as never});
  await client.request({method:'anvil_setBalance' as never,params:[operator,'0x8ac7230489e80000'] as never});
  const chain=new RangeKeeperChain(client,pool);
  await chain.verify(source);
  let current=await chain.snapshot(source,operator,input.activeTokenId);
  const gasByStage:{kind:string;gasUsed:bigint}[]=[];
  const send=async(plan:RangeKeeperTxPlan,futureApprovalCap=0n)=>{
   authorizeRangeKeeperTx(pool,{operator,wallet0:current.wallet0,wallet1:current.wallet1,tick:current.tick,
    sqrtPriceX96:current.sqrtPriceX96,timestamp:current.source.timestamp,
    position:current.position?{...current.position,tokenId:current.position.tokenId!}:null},plan,
    limits.maxSlippageBps,limits.fullWidthSpacings,futureApprovalCap);
   const call=encodeRangeKeeperTx(pool,operator,plan);
   await client.call({account:operator,to:call.to,data:call.data});
   const estimated=await client.estimateGas({account:operator,to:call.to,data:call.data});
   assert(estimated>0n&&estimated<=8_000_000n,'Fork stage gas estimate unavailable');
   const hash=await client.request({method:'eth_sendTransaction' as never,
    params:[{from:operator,to:call.to,data:call.data,gas:'0x7a1200'}] as never});
   assert(typeof hash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(hash));
   const receipt=await client.waitForTransactionReceipt({hash:hash as `0x${string}`});
   assert(receipt.status==='success',`Fork ${plan.kind} reverted`);
   const block=await client.getBlock({blockNumber:receipt.blockNumber});
   const tokenId=plan.kind==='mint'?mintedRangeKeeperTokenId(pool,operator,receipt):current.position?.tokenId??null;
   const after=await chain.snapshot({block:block.number,hash:block.hash,timestamp:Number(block.timestamp)},operator,tokenId);
   const proof=reconcileRangeKeeperAction(pool,{hash:receipt.transactionHash,plan,before:current,
    intent:{id:randomUUID(),chainId:4663,operator,action:plan.kind,nonce:current.nonce,to:call.to,
     data:call.data,value:'0',gas:'8000000',maxFeePerGas:'100000000000',maxPriorityFeePerGas:'0',
     sourceBlock:String(current.source.block),sourceHash:current.source.hash}},receipt,after);
   assert.equal(proof.status,'success');gasByStage.push({kind:plan.kind,gasUsed:receipt.gasUsed});current=after;
   return proof;
  };
  const grant=async(token:0|1,spender:'router'|'positionManager',amount:bigint,futureApprovalCap=0n)=>{
   const tokenAddress=token===0?pool.token0:pool.token1,spenderAddress=spender==='router'?pool.router:pool.positionManager;
   const allowance=current.allowances.find(a=>same(a.token,tokenAddress)&&same(a.spender,spenderAddress));assert(allowance);
   if(allowance.amount>=amount)return;
   if(allowance.amount>0n)await send({kind:'approve',token,spender,amount:0n});
   await send({kind:'approve',token,spender,amount},futureApprovalCap);
  };
  if(input.activeTokenId!==null){
   const p=current.position;assert(p&&p.tokenId===input.activeTokenId&&p.liquidity>0n);
   const a=principalAmounts({...p,sqrtPriceX96:current.sqrtPriceX96});
   const haircut=10_000n-BigInt(limits.maxSlippageBps);
   await send({kind:'withdraw',tokenId:p.tokenId,liquidity:p.liquidity,
    min0:a.amount0*haircut/10_000n,min1:a.amount1*haircut/10_000n,deadline:BigInt(current.source.timestamp+300)});
  }
  if(candidate.swap){
   const sw=candidate.swap,acquired:0|1=sw.token===0?1:0;
   const inventory=sw.token===0?current.wallet0:current.wallet1;
   const price=acquired===0?input.prices.price0:input.prices.price1;
   const decimals=acquired===0?pool.decimals0:pool.decimals1;
   assert(price>0n);
   const futureCap=limits.maxDeploymentValue*10n**BigInt(decimals)/price;
   await grant(sw.token,'positionManager',inventory);
   await grant(acquired,'positionManager',futureCap,futureCap);
   await grant(sw.token,'router',inventory);
   await send({kind:'swap',token:sw.token,amountIn:sw.amountIn,minOut:sw.minOut,
    deadline:BigInt(current.source.timestamp+300)});
  }
  let mintPlan:RangeKeeperTxPlan;
  if(candidate.swap){
   const state={phase:'entry',candidate,swapDone:true,activeTokenId:null,reserve0:0n,reserve1:0n,
    reserveNativeWei:0n} as RangeKeeperLiveState;
   const plan=await nextRangeKeeperStage(state,current,{pool,limits} as RangeKeeperConfig,chain,input.prices);
   assert(plan?.kind==='mint','Post-swap fork mint is infeasible or missing a preapproval');
   mintPlan=plan;
  }else{
   await grant(0,'positionManager',candidate.amount0Desired);
   await grant(1,'positionManager',candidate.amount1Desired);
   mintPlan={kind:'mint',candidate,deadline:BigInt(current.source.timestamp+300)};
  }
  await send(mintPlan);
  assert(current.position?.liquidity&&current.position.liquidity>=mintPlan.candidate.liquidity);
  return {source,createdTokenId:current.position.tokenId,gasByStage};
 }finally{
  child.kill('SIGTERM');
  await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();
   else{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();}});
 }
}
