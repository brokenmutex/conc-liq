import assert from 'node:assert/strict';
import {decodeFunctionResult,encodeFunctionData,toHex,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {createRobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {encodeRangeKeeperTx,type RangeKeeperTxPlan} from '../strategy/rangekeeper/calldata.js';
import {nextRangeKeeperStage} from '../strategy/rangekeeper/live-stage.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import type {RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import type {RangeKeeperLiveState} from '../strategy/rangekeeper/live-domain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import type {RangeKeeperPaperGasProbeRequest,RangeKeeperPaperGasStageSample} from './rangekeeper-paper-gas-evidence.js';
import {openPaperFork} from '../paper/fork.js';
import {localReceipt,prestateOverrides,simulatePaperTransaction,type PaperTransaction} from '../paper/execution-gas.js';
import {PAPER_ACCOUNT,paperTokenAbi} from '../paper/execution-abi.js';
import {referenceProofHash} from './market-profile.js';

const donor='0x00000000000000000000000000000000f17E0001' as Address;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const PPM=10_000n;

/** Replays the frozen swap against trusted draft allocation and proves the
 * candidate mint amounts fit the resulting inventory, including idle tokens. */
export function rangeKeeperPaperCandidateFunding(candidate:RangeKeeperCandidate,
 initial:readonly [bigint,bigint]){
 assert(initial[0]>=0n&&initial[1]>=0n&&(initial[0]>0n||initial[1]>0n),
  'Trusted RangeKeeper draft allocation is empty or invalid');
 const after=[initial[0],initial[1]] as [bigint,bigint];
 if(candidate.swap){
  const input=candidate.swap.token,acquired=(1-input) as 0|1;
  assert(after[input]>=candidate.swap.amountIn,'Trusted draft allocation cannot fund frozen swap input');
  after[input]-=candidate.swap.amountIn;after[acquired]+=candidate.swap.quotedOut;
 }
 assert(candidate.amount0Desired<=after[0]&&candidate.amount1Desired<=after[1],
  'Trusted draft allocation cannot fund frozen mint candidate');
 return [after[0],after[1]] as const;
}

async function fundFixture(fork:Awaited<ReturnType<typeof openPaperFork>>,client:RobinhoodClient,
 token:Address,pool:Address,amount:bigint){
 const balance=(owner:Address)=>client.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});
 assert.equal(await balance(PAPER_ACCOUNT),0n,'Paper fixture account is not empty');
 if(amount===0n)return;
 const trace=async(owner:Address)=>{
  const data=encodeFunctionData({abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});
  const overrides=prestateOverrides(await fork.rpc('debug_traceCall',[
   {to:token,data},'latest',{tracer:'prestateTracer'}]));
  const storage=Object.entries(overrides).find(([address])=>same(address,token))?.[1].stateDiff;
  assert(storage,'Token balance getter storage unavailable');return storage;
 };
 const donorStorage=await trace(donor),poolStorage=await trace(pool);
 const slots=Object.keys(donorStorage).filter(slot=>!(slot in poolStorage));
 assert.equal(slots.length,1,'Token balance slot is ambiguous');
 await fork.rpc('anvil_setStorageAt',[token,slots[0]!,toHex(amount,{size:32})]);
 assert.equal(await balance(donor),amount,'Token fixture getter mismatch');
 await fork.rpc('anvil_impersonateAccount',[donor]);
 await fork.rpc('anvil_setBalance',[donor,toHex(10n**18n)]);
 const data=encodeFunctionData({abi:paperTokenAbi,functionName:'transfer',args:[PAPER_ACCOUNT,amount]});
 const hash=await fork.rpc<Hash>('eth_sendTransaction',[{from:donor,to:token,data,gas:'0x7a1200'}]);
 assert.equal((await localReceipt(fork,hash)).status,'0x1','Fixture transfer reverted');
 assert.equal(await balance(PAPER_ACCOUNT),amount,'Paper fixture funding mismatch');
}

/** Executes the full frozen candidate entry and retain-exit path on a fresh,
 * pinned Anvil fork. It is a probe only: the only send-capable RPC is the
 * owned local Anvil endpoint created by openPaperFork. */
export async function sampleRangeKeeperPaperGasStages(request:RangeKeeperPaperGasProbeRequest,input:{
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
 limits:RangeKeeperLimits;initialBalances:readonly [bigint,bigint];
}):Promise<readonly RangeKeeperPaperGasStageSample[]>{
 assert(request.kind==='open','Terminal RangeKeeper gas probes require trusted persisted inventory context');
 assert(input.rpcUrl.length>0&&Number.isSafeInteger(input.maxRequests??1600)&&
  (input.maxRequests??1600)>0&&(input.maxRequests??1600)<=2000&&
  Number.isSafeInteger(input.timeoutMs??300_000)&&(input.timeoutMs??300_000)>0&&
  (input.timeoutMs??300_000)<=300_000&&input.limits.maxSlippageBps>=1&&
  input.limits.maxSlippageBps<=50,'RangeKeeper owned-fork probe budget or policy invalid');
 const {profile,frame,candidate}=request,p=profile.pool;
 assert.equal(p.chainId,4663,'RangeKeeper paper fork supports only the Robinhood chain');
 assert(frame.referenceEligible&&frame.referenceProof&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash,'RangeKeeper probe reference proof invalid');
 assert.equal(request.candidateSource.block,frame.source.block);
 assert(same(request.candidateSource.hash,frame.source.hash));
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,
  timestamp:BigInt(frame.source.timestamp)};
 const fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000});
 try{
  const local=createRobinhoodClient(fork.localUrl,30_000,{retryCount:0});
  const chain=new RangeKeeperChain(local,p);
  await chain.verify({block:source.number,hash:source.hash,timestamp:frame.source.timestamp});
  const reference=await readRangeKeeperReferences(local,{block:source.number,hash:source.hash,
   timestamp:frame.source.timestamp},profile);
  assert(reference.eligible&&reference.price0!==null&&reference.price1!==null&&reference.nativePrice!==null,
   'RangeKeeper owned-fork independent references unavailable');
  assert.equal(String(reference.price0),String(frame.price0));assert.equal(String(reference.price1),String(frame.price1));
  assert.equal(String(reference.nativePrice),String(frame.nativePrice));
  assert.equal(referenceProofHash(reference.proof),frame.referenceProofHash,
   'RangeKeeper owned-fork reference proof changed');
  const sourceSlot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'});
  const sourceLiquidity=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'});
  assert.equal(sourceSlot[1],frame.tick);assert.equal(String(sourceSlot[0]),String(frame.sqrtPriceX96));
  assert.equal(String(sourceLiquidity),String(frame.poolLiquidity),'RangeKeeper probe pool liquidity changed');
  const fixture=await chain.snapshot({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},PAPER_ACCOUNT,null);
  assert.equal(fixture.wallet0,0n);assert.equal(fixture.wallet1,0n);assert.equal(fixture.nftCount,0n,
   'Paper fixture account contains a canonical NFT');
  assert(fixture.allowances.every(row=>row.amount===0n),'Paper fixture account contains a canonical core allowance');
  await fork.rpc('anvil_setBalance',[PAPER_ACCOUNT,toHex(10n**18n)]);
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  const initial=input.initialBalances,expectedAfterSwap=rangeKeeperPaperCandidateFunding(candidate,initial);
  await fundFixture(fork,local,p.token0 as Address,p.pool as Address,initial[0]);
  await fundFixture(fork,local,p.token1 as Address,p.pool as Address,initial[1]);
  const rows:PaperTransaction[]=[];
  const send=async(action:string,plan:RangeKeeperTxPlan)=>{
   const call=encodeRangeKeeperTx(p,PAPER_ACCOUNT,plan);
   const tx=await simulatePaperTransaction(fork,{action,to:call.to,calldata:call.data},PAPER_ACCOUNT);
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));
   assert(BigInt(tx.estimate.gas)>0n&&BigInt(tx.estimate.parentGas)<=BigInt(tx.estimate.gas));
   rows.push(tx);return tx;
  };
  const amounts=[candidate.amount0Desired,candidate.amount1Desired] as const;
  if(candidate.swap){
   const inputToken=candidate.swap.token,acquired=(1-inputToken) as 0|1;
   const acquiredPrice=acquired===0?frame.price0!:frame.price1!,acquiredDecimals=acquired===0?p.decimals0:p.decimals1;
   const acquiredCap=input.limits.maxDeploymentValue*10n**BigInt(acquiredDecimals)/acquiredPrice;
   const futureCap=initial[acquired]>acquiredCap?initial[acquired]:acquiredCap;
   await send('open_approve_manager_input',{kind:'approve',token:inputToken,spender:'positionManager',amount:initial[inputToken]});
   await send('open_approve_manager_acquired',{kind:'approve',token:acquired,spender:'positionManager',amount:futureCap});
   await send('open_approve_router_input',{kind:'approve',token:inputToken,spender:'router',amount:initial[inputToken]});
   const sourceQuote=await chain.quote({block:source.number,hash:source.hash,timestamp:frame.source.timestamp},
    inputToken,candidate.swap.amountIn,frame.price0!,frame.price1!);
   assert.equal(sourceQuote.amountOut,candidate.swap.quotedOut,'Frozen candidate swap quote differs at its source');
   assert.equal(candidate.swap.minOut,sourceQuote.amountOut*(10_000n-BigInt(input.limits.maxSlippageBps))/10_000n,
    'Frozen candidate swap minimum differs from policy');
   const swapBlock=await fork.rpc<{timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
   await send('open_swap',{kind:'swap',token:inputToken,amountIn:candidate.swap.amountIn,
    minOut:candidate.swap.minOut,deadline:BigInt(swapBlock.timestamp)+300n});
   const post0=await local.readContract({address:p.token0 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]});
   const post1=await local.readContract({address:p.token1 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]});
   assert.equal(post0,expectedAfterSwap[0]);assert.equal(post1,expectedAfterSwap[1],
    'Owned-fork swap inventory differs from trusted allocation replay');
  }else{
   await send('open_approve_manager_token0',{kind:'approve',token:0,spender:'positionManager',amount:initial[0]});
   await send('open_approve_manager_token1',{kind:'approve',token:1,spender:'positionManager',amount:initial[1]});
  }
  assert(amounts[0]<=expectedAfterSwap[0]&&amounts[1]<=expectedAfterSwap[1]);
  const latest=await fork.rpc<{number:`0x${string}`;hash:Hash;timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
  assert(latest.hash,'Owned-fork latest block hash unavailable');
  const snapshot=await chain.snapshot({block:BigInt(latest.number),hash:latest.hash,timestamp:Number(BigInt(latest.timestamp))},
   PAPER_ACCOUNT,null);
  const stageState={phase:'entry',candidate,swapDone:true,activeTokenId:null,reserve0:0n,
   reserve1:0n,reserveNativeWei:0n} as RangeKeeperLiveState;
  const stageConfig={pool:p,limits:input.limits,referencePolicy:profile.referencePolicy} as RangeKeeperConfig;
  const mintPlan=await nextRangeKeeperStage(stageState,snapshot,stageConfig,chain,
   {price0:frame.price0!,price1:frame.price1!});
  assert(mintPlan?.kind==='mint','Owned-fork candidate no longer has a mint stage');
  assert.deepEqual(mintPlan.candidate.range,candidate.range);
  for(const key of ['amount0Desired','amount1Desired','amount0Min','amount1Min','liquidity','deployedValue'] as const)
   assert.equal(mintPlan.candidate[key],candidate[key],`Owned-fork refreshed candidate changed ${key}`);
  const mint=await send('open_mint',mintPlan);
  const [tokenId,liquidity,minted0,minted1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,
   functionName:'mint',data:mint.returnData});
  assert(liquidity>=candidate.liquidity&&minted0<=candidate.amount0Desired&&minted1<=candidate.amount1Desired,
   'Owned-fork mint differs from frozen RangeKeeper candidate');
  let position=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert(same(position.owner,PAPER_ACCOUNT)&&position.liquidity===liquidity&&
   position.tickLower===candidate.range.tickLower&&position.tickUpper===candidate.range.tickUpper);
  const slot=await local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'});
  const principal=principalAmounts({liquidity,tickLower:position.tickLower,tickUpper:position.tickUpper,sqrtPriceX96:slot[0]});
  const haircut=10_000n-BigInt(input.limits.maxSlippageBps);
  const exitBlock=await fork.rpc<{timestamp:`0x${string}`}>('eth_getBlockByNumber',['latest',false]);
  await send('exit_withdraw_collect',{kind:'withdraw',tokenId,liquidity,
   min0:principal.amount0*haircut/PPM,min1:principal.amount1*haircut/PPM,deadline:BigInt(exitBlock.timestamp)+300n});
  for(const [stage,token] of [
   ['exit_cleanup_router_token0',0],['exit_cleanup_router_token1',1],
   ['exit_cleanup_manager_token0',0],['exit_cleanup_manager_token1',1],
  ] as const){
   await send(stage,{kind:'approve',token,spender:stage.includes('router')?'router':'positionManager',amount:0n});
  }
  for(const token of [p.token0,p.token1])for(const spender of [p.router,p.positionManager])
   assert.equal(await local.readContract({address:token as Address,abi:paperTokenAbi,
    functionName:'allowance',args:[PAPER_ACCOUNT,spender as Address]}),0n,
    'Owned-fork retain exit left a core allowance');
  position=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert.equal(position.liquidity,0n);assert.equal(position.tokensOwed0,0n);assert.equal(position.tokensOwed1,0n);
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'RangeKeeper owned-fork source block changed');
  const stageNames=rows.map(row=>row.action);
  assert.deepEqual(stageNames,request.stages);
  return rows.map(row=>({...row,stateOverrides:row.stateOverrides as Record<string,unknown>}));
 }finally{await fork.close();}
}
