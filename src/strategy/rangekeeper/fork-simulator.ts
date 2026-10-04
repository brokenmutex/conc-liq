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
import {RANGEKEEPER_ALLOWANCE_POLICY,allowanceCeiling,persistentAllowanceGrant,rangeKeeperAllowanceExposure,
 type RangeKeeperAllowancePolicy} from './allowance-policy.js';
import type {RangeKeeperLiveState} from './live-domain.js';
import type {RangeKeeperConfig} from './config.js';
import {openPaperFork} from '../../paper/fork.js';

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
 activeTokenId:bigint|null;prices:{price0:bigint;price1:bigint};
 /** Limit a dashboard review to its campaign's liquid allocation. */
 allocation?:{amount0:bigint;amount1:bigint};
 rehearseExit?:{maxPoolDeviationPpm:number};
 /** Shared-wallet persistent allowances: approvals are planned only where the wallet's canonical allowance falls short,
  * nothing is revoked between entry and exit, and the exit rehearses the final cleanup of every non-zero pair (the
  * conservative last-user case). Absent, the legacy zero-at-rest sequence is simulated. */
 allowancePolicy?:typeof RANGEKEEPER_ALLOWANCE_POLICY}){
 const {source,pool,limits,operator,candidate}=input;
 assert(input.rpcUrl&&input.anvilBinary&&candidate.sourceBlock<=source.block&&source.timestamp<=candidate.expiresAt);
 const port=await freePort(),url=`http://127.0.0.1:${port}`;
 const child=spawn(input.anvilBinary,['--fork-url',input.rpcUrl,'--fork-block-number',String(source.block),
  '--chain-id',String(pool.chainId),'--port',String(port),'--accounts','0',
  '--no-storage-caching','--retries','0','--silent'],
  {stdio:['ignore','ignore','pipe']});
 let startupError='',startupStderr='';
 child.once('error',error=>{startupError=error.message;});
 child.stderr?.on('data',chunk=>{startupStderr=(startupStderr+String(chunk)).slice(-4096);});
 try{
  const client=createPublicClient({chain:robinhoodChain,transport:http(url,{retryCount:0,timeout:15_000})});
  let ready=false;for(let i=0;i<80;i++){
   if(child.exitCode!==null||startupError)break;
   try{if(await client.getChainId()===pool.chainId){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert(ready,`RangeKeeper fork did not start: ${(startupError||startupStderr||'readiness timeout')
   .replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,1000)}`);
  const first=await client.getBlock();assert(same(first.hash,source.hash),'Fork source differs from canonical observation');
  await client.request({method:'anvil_impersonateAccount' as never,params:[operator] as never});
  await client.request({method:'anvil_setBalance' as never,params:[operator,'0x8ac7230489e80000'] as never});
  const chain=new RangeKeeperChain(client,pool);
  await chain.verify(source);
  let current=await chain.snapshot(source,operator,input.activeTokenId);
  const allocation=input.allocation;
  if(allocation){
   assert(allocation.amount0>=0n&&allocation.amount1>=0n&&
    allocation.amount0<=current.wallet0&&allocation.amount1<=current.wallet1,
    'Fork allocation exceeds canonical token inventory');
  }
  const reserve0=allocation?current.wallet0-allocation.amount0:0n,
   reserve1=allocation?current.wallet1-allocation.amount1:0n;
  const policy:RangeKeeperAllowancePolicy|undefined=input.allowancePolicy===RANGEKEEPER_ALLOWANCE_POLICY?{kind:RANGEKEEPER_ALLOWANCE_POLICY,
   exposure:rangeKeeperAllowanceExposure({initial:[allocation?.amount0??current.wallet0,allocation?.amount1??current.wallet1],
    maxDeploymentValue:limits.maxDeploymentValue,decimals:[pool.decimals0,pool.decimals1],prices:[input.prices.price0,input.prices.price1]})}:undefined;
  const ceiling=policy?[allowanceCeiling(policy.exposure[0]),allowanceCeiling(policy.exposure[1])] as const:undefined;
  let phase:'entry'|'exit'='entry';
  const gasByStage:{kind:string;gasUsed:bigint;estimatedGas?:bigint;phase:'entry'|'exit'}[]=[];
  const send=async(plan:RangeKeeperTxPlan,futureApprovalCap=0n)=>{
   authorizeRangeKeeperTx(pool,{operator,wallet0:current.wallet0,wallet1:current.wallet1,tick:current.tick,
    sqrtPriceX96:current.sqrtPriceX96,timestamp:current.source.timestamp,
    position:current.position?{...current.position,tokenId:current.position.tokenId!}:null},plan,
    limits.maxSlippageBps,limits.fullWidthSpacings,futureApprovalCap,ceiling);
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
   assert.equal(proof.status,'success');gasByStage.push({kind:plan.kind,gasUsed:receipt.gasUsed,estimatedGas:estimated,phase});current=after;
   assert(current.wallet0>=reserve0&&current.wallet1>=reserve1,'Fork spent another campaign allocation');
   return proof;
  };
  const grant=async(token:0|1,spender:'router'|'positionManager',amount:bigint,futureApprovalCap=0n)=>{
   const tokenAddress=token===0?pool.token0:pool.token1,spenderAddress=spender==='router'?pool.router:pool.positionManager;
   const allowance=current.allowances.find(a=>same(a.token,tokenAddress)&&same(a.spender,spenderAddress));assert(allowance);
   if(allowance.amount>=amount)return;
   if(policy){
    await send({kind:'approve',token,spender,amount:persistentAllowanceGrant({current:allowance.amount,needed:amount,exposure:policy.exposure[token]})!},futureApprovalCap);
    return;
   }
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
   const inventory=sw.token===0?current.wallet0-reserve0:current.wallet1-reserve1;
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
   const state={phase:'entry',candidate,swapDone:true,activeTokenId:null,reserve0,reserve1,
    reserveNativeWei:0n} as RangeKeeperLiveState;
   const plan=await nextRangeKeeperStage(state,current,{pool,limits} as RangeKeeperConfig,chain,input.prices,policy);
   assert(plan?.kind==='mint','Post-swap fork mint is infeasible or missing a preapproval');
   mintPlan=plan;
  }else{
   await grant(0,'positionManager',candidate.amount0Desired);
   await grant(1,'positionManager',candidate.amount1Desired);
   mintPlan={kind:'mint',candidate,deadline:BigInt(current.source.timestamp+300)};
  }
  await send(mintPlan);
  assert(current.position?.liquidity&&current.position.liquidity>=mintPlan.candidate.liquidity);
  const createdTokenId=current.position.tokenId;
  if(input.rehearseExit){
   assert(allocation,'Full dashboard lifecycle requires an explicit allocation');
   const state={phase:'holding',candidate:null,activeTokenId:createdTokenId,reserve0,reserve1,
    reserveNativeWei:0n} as RangeKeeperLiveState;
   const config={pool,limits,referencePolicy:{maxPoolDeviationPpm:input.rehearseExit.maxPoolDeviationPpm}} as RangeKeeperConfig;
   let cleaned=false;
   for(let i=0;i<8;i++){
    const plan=await nextRangeKeeperStage(state,current,config,chain,input.prices,policy);
    if(!plan){cleaned=true;break;}await send(plan);
   }
   assert(cleaned,'Entry allowance cleanup did not terminate');
   state.phase='exit';phase='exit';
   let exited=false;
   for(let i=0;i<16;i++){
    const plan=await nextRangeKeeperStage(state,current,config,chain,input.prices,policy);
    if(!plan){exited=true;break;}await send(plan);
    if(plan.kind==='withdraw')state.activeTokenId=null;
   }
   assert(exited&&current.position?.liquidity===0n&&
    current.position.tokensOwed0===0n&&current.position.tokensOwed1===0n&&
    current.allowances.every(a=>a.amount===0n),'Fork complete exit custody is unresolved');
   const riskyInventory=pool.quoteToken===0?current.wallet1-reserve1:current.wallet0-reserve0;
   assert.equal(riskyInventory,0n,'Fork exit did not convert the allocated risky inventory');
  }
  return {source,createdTokenId,gasByStage};
 }finally{
  child.kill('SIGTERM');
  await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();
   else{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},3000).unref();}});
 }
}

/** Rehearse a retain-only close using the actual held NFT and only this
 * campaign's liquid allocation. Every mutation is confined to an owned fork;
 * native funding is synthetic and is never evidence of canonical funding. */
export async function simulateRangeKeeperRetain(input:{rpcUrl:string;anvilBinary:string;source:RangeKeeperSource;
 config:RangeKeeperConfig;operator:Address;activeTokenId:bigint;prices:{price0:bigint;price1:bigint};
 allocation:{amount0:bigint;amount1:bigint}}){
 const {source,config,operator}=input;
 const fork=await openPaperFork({source:{number:source.block,hash:source.hash,timestamp:BigInt(source.timestamp)},
  rpcUrl:input.rpcUrl,anvilBinary:input.anvilBinary,beforeRead:async()=>{},timeoutMs:180_000,maxRequests:10_000});
 try{
  const client=createPublicClient({chain:robinhoodChain,transport:http(fork.localUrl,{retryCount:0,timeout:15_000})});
  await fork.rpc('anvil_impersonateAccount',[operator]);
  await fork.rpc('anvil_setBalance',[operator,'0x8ac7230489e80000']);
  const chain=new RangeKeeperChain(client,config.pool);await chain.verify(source);
  let current=await chain.snapshot(source,operator,input.activeTokenId);
  assert(current.position?.tokenId===input.activeTokenId&&current.position.liquidity>0n,
   'Retain rehearsal requires the campaign held NFT');
  assert(input.allocation.amount0>=0n&&input.allocation.amount1>=0n&&
   input.allocation.amount0<=current.wallet0&&input.allocation.amount1<=current.wallet1,
   'Retain rehearsal allocation exceeds canonical inventory');
  const reserve0=current.wallet0-input.allocation.amount0,reserve1=current.wallet1-input.allocation.amount1;
  const state={phase:'exit',exitMode:'retain',activeTokenId:input.activeTokenId,
   reserve0,reserve1,reserveNativeWei:0n} as RangeKeeperLiveState;
  const gasByStage:{kind:string;gasUsed:bigint;estimatedGas:bigint;phase:'exit'}[]=[];
  let complete=false;
  for(let i=0;i<16;i++){
   const plan=await nextRangeKeeperStage(state,current,config,chain,input.prices);
   if(!plan){complete=true;break;}
   assert(plan.kind==='withdraw'||plan.kind==='approve'&&plan.amount===0n,
    'Retain-only rehearsal attempted a conversion or new approval');
   authorizeRangeKeeperTx(config.pool,{operator,wallet0:current.wallet0,wallet1:current.wallet1,
    tick:current.tick,sqrtPriceX96:current.sqrtPriceX96,timestamp:current.source.timestamp,
    position:current.position?{...current.position,tokenId:current.position.tokenId!}:null},plan,
    config.limits.maxSlippageBps,config.limits.fullWidthSpacings);
   const call=encodeRangeKeeperTx(config.pool,operator,plan);
   await client.call({account:operator,to:call.to,data:call.data});
   const gas=await client.estimateGas({account:operator,to:call.to,data:call.data});
   assert(gas>0n&&gas<=8_000_000n,'Retain rehearsal gas estimate unavailable');
   const hash=await fork.rpc('eth_sendTransaction',[{from:operator,to:call.to,data:call.data,gas:'0x7a1200'}]);
   assert(typeof hash==='string'&&/^0x[0-9a-fA-F]{64}$/.test(hash));
   const receipt=await client.waitForTransactionReceipt({hash:hash as `0x${string}`});
   assert(receipt.status==='success','Retain rehearsal reverted');
   const header=await client.getBlock({blockNumber:receipt.blockNumber});
   const after=await chain.snapshot({block:header.number,hash:header.hash,timestamp:Number(header.timestamp)},operator,input.activeTokenId);
   const proof=reconcileRangeKeeperAction(config.pool,{hash:receipt.transactionHash,plan,before:current,
    intent:{id:randomUUID(),chainId:4663,operator,action:plan.kind,nonce:current.nonce,to:call.to,data:call.data,
     value:'0',gas:'8000000',maxFeePerGas:'100000000000',maxPriorityFeePerGas:'0',
     sourceBlock:String(current.source.block),sourceHash:current.source.hash}},receipt,after);
   assert.equal(proof.status,'success');
   gasByStage.push({kind:plan.kind,gasUsed:receipt.gasUsed,estimatedGas:gas,phase:'exit'});current=after;
   assert(current.wallet0>=reserve0&&current.wallet1>=reserve1,'Retain rehearsal spent sibling capital');
   if(plan.kind==='withdraw')state.activeTokenId=null;
  }
  assert(complete&&gasByStage.some(stage=>stage.kind==='withdraw')&&current.position?.liquidity===0n&&
   current.position.tokensOwed0===0n&&current.position.tokensOwed1===0n&&current.allowances.every(a=>a.amount===0n),
   'Retain rehearsal custody or allowance cleanup is incomplete');
  return {source,tokenId:input.activeTokenId,gasByStage,retained0:current.wallet0-reserve0,retained1:current.wallet1-reserve1};
 }finally{await fork.close();}
}
