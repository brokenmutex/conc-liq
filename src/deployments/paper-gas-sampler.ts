import assert from 'node:assert/strict';
import {decodeFunctionResult,encodeFunctionData,keccak256,toHex,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {createRobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {principalAmounts} from '../backtest/principal.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {restorePaperPosition,type PaperExitInventory} from '../paper/execution-exit.js';
import {openPaperFork} from '../paper/fork.js';
import {localReceipt,prestateOverrides,simulatePaperTransaction,type PaperTransaction} from '../paper/execution-gas.js';
import {PAPER_ACCOUNT,PAPER_ROUTER,paperQuoterAbi,paperRouterAbi,paperTokenAbi} from '../paper/execution-abi.js';
import {paperCloseConvertGasAllowanceStateV2,verifyPaperCloseConvertGasEvidence} from './paper-gas-evidence.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import {paperCloseConvertRouteSchema,type PaperCloseConvertRoute,
 PAPER_STATIC_CONVERT_GAS_PATH_V2,PAPER_STATIC_CONVERT_GAS_STAGES_V2} from './paper-close-convert-model.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {USDG} from '../constants.js';
import {contentHash,staticParameters} from './contracts.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';
import type {PaperDraft,PaperOpenFrame} from './paper-preview.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {loadRuntimeIdentity} from '../runtime/identity.js';

const donor='0x00000000000000000000000000000000f17E0001' as Address;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;

/** Getter-derived balance fixture. The storage change and transfer happen
 * only on an owned local fork; no upstream write or signer is available. */
async function fundFixture(fork:Awaited<ReturnType<typeof openPaperFork>>,client:RobinhoodClient,
 token:Address,pool:Address,amount:bigint){
 const balance=(owner:Address)=>client.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[owner]});
 assert.equal(await balance(PAPER_ACCOUNT),0n,'Paper fixture account is not empty');
 if(amount===0n)return {token,amount:'0',slot:null,transferHash:null};
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
 const slot=slots[0]!;
 await fork.rpc('anvil_setStorageAt',[token,slot,toHex(amount,{size:32})]);
 assert.equal(await balance(donor),amount,'Token fixture getter mismatch');
 await fork.rpc('anvil_impersonateAccount',[donor]);
 await fork.rpc('anvil_setBalance',[donor,toHex(10n**18n)]);
 const data=encodeFunctionData({abi:paperTokenAbi,functionName:'transfer',args:[PAPER_ACCOUNT,amount]});
 const hash=await fork.rpc<Hash>('eth_sendTransaction',[{from:donor,to:token,data,gas:'0x7a1200'}]);
 assert.equal((await localReceipt(fork,hash)).status,'0x1','Fixture transfer reverted');
 assert.equal(await balance(PAPER_ACCOUNT),amount,'Fixture account balance mismatch');
 return {token,amount:String(amount),slot,transferHash:hash,
  donorStorageHash:contentHash(donorStorage),poolStorageHash:contentHash(poolStorage)};
}

/** Probes the exact static/no-swap stage calldata on a pinned owned fork.
 * The returned report is calibration evidence, never a paper fill. */
export async function sampleStaticPaperGas(input:{rpcUrl:string;draft:PaperDraft;frame:PaperOpenFrame;
 beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number}){
 const {draft,frame}=input,preview=buildIndicativePaperOpenPreview(draft,frame);
 assert(preview.status==='indicative'&&preview.candidate,'Static paper candidate unavailable');
 assert(frame.referenceProof,'Paper gas reference proof unavailable');
 assert(draft.strategyId==='static_manual_v1','Only static/manual no-swap calibration is supported');
 const limits=staticParameters.parse(draft.parameters).limits;
 assert(limits,'Static/manual limits are required');
 const pool=draft.profile.pool,source={number:BigInt(frame.source.block),
  hash:frame.source.hash as Hash,timestamp:BigInt(frame.source.timestamp)};
 const fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1200,timeoutMs:input.timeoutMs??300_000});
 try{
  const local=createRobinhoodClient(fork.localUrl,15_000,{retryCount:0});
  await new RangeKeeperChain(local,pool).verify({block:source.number,hash:source.hash,timestamp:Number(source.timestamp)});
  await fork.rpc('anvil_setBalance',[PAPER_ACCOUNT,toHex(10n**18n)]);
  await fork.rpc('anvil_impersonateAccount',[PAPER_ACCOUNT]);
  const amount0=BigInt(preview.candidate.amount0Desired),amount1=BigInt(preview.candidate.amount1Desired);
  const funding=[];
  funding.push(await fundFixture(fork,local,pool.token0,pool.pool,amount0));
  funding.push(await fundFixture(fork,local,pool.token1,pool.pool,amount1));
  const transactions:PaperTransaction[]=[];
  const send=async(stage:typeof PAPER_STATIC_GAS_STAGES[number],to:Address,data:`0x${string}`)=>{
   const tx=await simulatePaperTransaction(fork,{action:stage,to,calldata:data},PAPER_ACCOUNT);
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));
   assert(BigInt(tx.estimate.gas)>0n&&BigInt(tx.estimate.parentGas)<=BigInt(tx.estimate.gas));
   transactions.push(tx);return tx;
  };
  for(const [index,amount] of [[0,amount0],[1,amount1]] as const){
   await send(index===0?'approve_token0':'approve_token1',index===0?pool.token0:pool.token1,
    encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[pool.positionManager,amount]}));
  }
  const range=preview.candidate.range,deadline=source.timestamp+300n,bps=BigInt(limits.maxSlippageBps);
  const min0=BigInt(preview.candidate.amount0Minted)*(10_000n-bps)/10_000n;
  const min1=BigInt(preview.candidate.amount1Minted)*(10_000n-bps)/10_000n;
  const mint=await send('mint',pool.positionManager,encodeFunctionData({abi:guardedCanaryPositionManagerAbi,
   functionName:'mint',args:[{token0:pool.token0,token1:pool.token1,fee:pool.fee,
    tickLower:range.tickLower,tickUpper:range.tickUpper,amount0Desired:amount0,amount1Desired:amount1,
    amount0Min:min0,amount1Min:min1,recipient:PAPER_ACCOUNT,deadline}]}));
  const [tokenId,liquidity,minted0,minted1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,
   functionName:'mint',data:mint.returnData});
  assert(liquidity>0n&&liquidity>=BigInt(preview.candidate.liquidity),'Fork mint differs from candidate');
  assert(minted0<=amount0&&minted1<=amount1,'Fork mint exceeded fixture inventory');
  const position=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert.equal(position.liquidity,liquidity);assert(same(position.owner,PAPER_ACCOUNT));
  const slot=await local.readContract({address:pool.pool,abi:poolAbi,functionName:'slot0'});
  const principal=principalAmounts({...position,sqrtPriceX96:slot[0]});
  const calls=[encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{
   tokenId,liquidity,amount0Min:principal.amount0*(10_000n-bps)/10_000n,
   amount1Min:principal.amount1*(10_000n-bps)/10_000n,deadline}]}),
   encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId,
    recipient:PAPER_ACCOUNT,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})];
  await send('withdraw_collect',pool.positionManager,encodeFunctionData({abi:canaryExitAbi,
   functionName:'multicall',args:[calls]}));
  const finalPosition=await readCanaryPosition(local,tokenId,await local.getBlockNumber({cacheTime:0}));
  assert.equal(finalPosition.liquidity,0n);assert.equal(finalPosition.tokensOwed0,0n);
  assert.equal(finalPosition.tokensOwed1,0n);
  for(const index of [0,1] as const){
   await send(index===0?'cleanup_token0':'cleanup_token1',index===0?pool.token0:pool.token1,
    encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[pool.positionManager,0n]}));
  }
  assert.deepEqual(transactions.map(tx=>tx.action),[...PAPER_STATIC_GAS_STAGES]);
  const pinned=await fork.read('eth_getBlockByNumber',[fork.blockTag,false]) as {hash:string};
  assert(same(pinned.hash,source.hash),'Canonical calibration source changed');
  const sampledAt=new Date().toISOString();
  const stageProfiles=transactions.map(tx=>{
   const stageSource={block:tx.sourceBlock,hash:tx.sourceHash,estimatedAt:sampledAt,
    callHash:keccak256(tx.calldata),method:'owned_fork_nitro_exact_call_v1' as const};
   const expected=BigInt(tx.estimate.gas);
   return {stage:tx.action,sourceHash:contentHash(stageSource),model:{schemaVersion:1 as const,
    source:stageSource,gasUnitsExpected:String(expected),gasUnitsBound:String(ceil(expected*13n,10n)),
    sizeMinValue:preview.candidate!.deployedValue,sizeMaxValue:preview.candidate!.deployedValue,
    shareMinPpm:preview.candidate!.dilutedSharePpm,shareMaxPpm:preview.candidate!.dilutedSharePpm,
    tickLower:preview.candidate!.range.tickLower,tickUpper:preview.candidate!.range.tickUpper},
    evidence:{to:tx.to,calldata:tx.calldata,returnData:tx.returnData,localHash:tx.localHash,
     localGasUsed:tx.localGasUsed,localEffectiveGasPriceWei:tx.localEffectiveGasPriceWei,
     estimate:tx.estimate,stateOverrideHash:tx.stateOverrideHash,stateOverrides:tx.stateOverrides}};
  });
  const report={schemaVersion:1 as const,pathVersion:PAPER_STATIC_GAS_PATH,pool:pool.pool,
   profile:draft.profile,profileHash:draft.profileHash,parameters:draft.parameters,
   strategyId:draft.strategyId,strategyVersion:draft.strategyVersion,
   stateSchemaVersion:draft.stateSchemaVersion,allocation:draft.allocation,
   configHash:draft.configHash,campaignId:draft.id,revision:draft.revision,
   candidateHash:preview.candidateHash,
   candidate:preview.candidate,
   source:frame.source,reference:{price0:String(frame.price0),price1:String(frame.price1),
    nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash},
   referenceProof:frame.referenceProof,sampledAt,
   funding,tokenId:String(tokenId),liquidity:String(liquidity),minted0:String(minted0),minted1:String(minted1),
   stageProfiles,readBudget:fork.budget,
   limitations:['Owned-fork calibration probe, not a paper fill or live receipt',
    'Exact candidate size/share only; six no-swap stages and retain-close only',
    'Gas units are Nitro estimates with traced prestate; no fee capture or execution-delay model']};
  const result={...report,reportHash:contentHash(JSON.parse(JSON.stringify(report)))};
  verifyPaperGasEvidence(result);
  return result;
 }finally{await fork.close();}
}

/** Samples the terminal close-convert sequence on an owned fork. The saved
 * lower fee carry is restored into a local NFT fixture, the whole non-quote
 * inventory is quoted/sold, and both manager/router allowance pairs are
 * explicitly reset. This emits provisional fork evidence only. */
export async function sampleStaticPaperCloseConvertGas(input:{rpcUrl:string;
 openModel:PaperOpenModel;profile:MarketProfile;frame:PaperOpenFrame;
 route:PaperCloseConvertRoute;feeCarry:PaperFeeCarry;
 feeEvidence:{id:string;proofHash:string;carryHash:string};terminalMarkId:string;previousMarkId:string;
 beforeRead:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number}){
 const runtimeIdentity=loadRuntimeIdentity();
 assert(runtimeIdentity,'Close-convert gas sampling requires a sealed runtime identity');
 const open=input.openModel,profile=marketProfileSchema.parse(input.profile),p=profile.pool,
  route=paperCloseConvertRouteSchema.parse(input.route),frame=input.frame,carry=input.feeCarry;
 assert.equal(contentHash(profile),open.profileHash,'Close gas market profile changed');
 assert.equal(open.campaignId,input.openModel.campaignId);
 assert.equal(frame.source.block===carry.through.block,true,'Terminal fee carry is not through the close source');
 assert(same(frame.source.hash,carry.through.hash),'Terminal fee carry hash differs from close source');
 assert.equal(carry.from.block,open.source.block);assert(same(carry.from.hash,open.source.hash));
 assert.equal(contentHash(carry),input.feeEvidence.carryHash,'Terminal carry hash is not canonical');
 assert(/^[1-9][0-9]*$/.test(input.feeEvidence.id)&&/^[0-9a-f]{64}$/.test(input.feeEvidence.proofHash),
  'Terminal fee evidence identity is invalid');
 assert(/^[1-9][0-9]*$/.test(input.terminalMarkId)&&/^[1-9][0-9]*$/.test(input.previousMarkId),
  'Close-convert terminal mark identity is invalid');
 assert.equal(referenceProofHash(frame.referenceProof),frame.referenceProofHash);
 assert(frame.referenceEligible&&frame.referenceProof&&frame.price0&&frame.price1&&frame.nativePrice&&
  frame.sqrtPriceX96>0n&&frame.poolLiquidity>0n,'Close gas source or reference is unavailable');
 const {routeHash,...routeContent}=route;
 assert.equal(routeHash,contentHash(routeContent),'Close gas route self-hash mismatch');
 const quoteTokenIndex=p.quoteToken,riskTokenIndex=(1-p.quoteToken) as 0|1,
  quoteToken=quoteTokenIndex===0?p.token0:p.token1,
  riskToken=riskTokenIndex===0?p.token0:p.token1,
  expectedPath=route.inputAsset==='token0'?[p.token0,p.token1]:[p.token1,p.token0];
 assert(same(quoteToken,USDG),'Static/manual close gas sampler only supports the configured USDG quote asset');
 assert(same(route.router,p.router)&&same(route.quoter,p.quoter)&&route.fee===p.fee&&
  route.path.every((address,index)=>same(address,expectedPath[index]!))&&
  route.inputAsset===`token${riskTokenIndex}`&&same(route.path[1]!,quoteToken),
  'Close gas route is not the configured non-quote-to-quote path');
 assert(same(p.router,PAPER_ROUTER),'Close gas router is not the approved router');
 const lower=(token:PaperFeeCarry['token0'])=>{
  const raw=BigInt(token.lowerRawQ128);
  assert(raw>=0n&&BigInt(token.upperRawQ128)>=raw&&token.lowerAmountRaw===String(raw/(1n<<128n))&&
   token.upperAmountRaw===String(BigInt(token.upperRawQ128)/(1n<<128n)),
   'Close gas lower fee carry is malformed');return BigInt(token.lowerAmountRaw);
 },fee0=lower(carry.token0),fee1=lower(carry.token1),
  principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   sqrtPriceX96:frame.sqrtPriceX96}),idle0=BigInt(open.candidate.idle0),
  idle1=BigInt(open.candidate.idle1),pre0=principal.amount0+idle0+fee0,
  pre1=principal.amount1+idle1+fee1,inputAmount=route.inputAsset==='token0'?pre0:pre1;
 assert.equal(BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted),idle0,
  'Open token0 approval remainder differs from idle inventory');
 assert.equal(BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted),idle1,
  'Open token1 approval remainder differs from idle inventory');
 assert(BigInt(open.candidate.dilutedSharePpm)<=10_000n,
  'Close gas restoration exceeds the guarded paper fixture share limit');
 assert(inputAmount>0n,'Close gas conversion input is zero');
 const source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,
  timestamp:BigInt(frame.source.timestamp)};
 const fork=await openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000});
 try{
  const local=createRobinhoodClient(fork.localUrl,60_000,{retryCount:0});
  await new RangeKeeperChain(local,p).verify({block:source.number,hash:source.hash,
   timestamp:frame.source.timestamp});
  const market={symbol:'STATIC',rwa:riskToken as Address,pool:p.pool as Address,
   fee:p.fee,tickSpacing:p.tickSpacing,
   rwaDecimals:riskTokenIndex===0?p.decimals0:p.decimals1};
  const policy={market,budgetQuote:'10000000000',halfWidthSpacings:1,
   maxLiquiditySharePpm:10_000,maxSlippageBps:route.slippageBps,transactionTtlSeconds:300} as const;
  const inventory:PaperExitInventory={liquidity:open.candidate.liquidity,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   idle0:String(idle0),idle1:String(idle1),fee0:String(fee0),fee1:String(fee1),
   nativeBalanceWei:'1000000000000000000',allowances:[
    {token:p.token0 as Address,spender:p.positionManager as Address,amount:String(idle0)},
    {token:p.token1 as Address,spender:p.positionManager as Address,amount:String(idle1)},
    {token:p.token0 as Address,spender:p.router as Address,amount:'0'},
    {token:p.token1 as Address,spender:p.router as Address,amount:'0'}]};
  const restored=await restorePaperPosition(fork,policy,inventory),{context,tokenId,position}=restored;
  assert.equal(position.liquidity,BigInt(open.candidate.liquidity));
  assert.equal(position.tickLower,open.candidate.range.tickLower);
  assert.equal(position.tickUpper,open.candidate.range.tickUpper);
  const balances=async()=>({token0:String(await context.local.readContract({address:p.token0 as Address,
    abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]})),
   token1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]}))});
  const allowances=async()=>({manager0:String(await context.local.readContract({address:p.token0 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.positionManager as Address]})),
   manager1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.positionManager as Address]})),
   router0:String(await context.local.readContract({address:p.token0 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.router as Address]})),
   router1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.router as Address]}))});
  const stageRows:{stage:typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number];tx:PaperTransaction;
   allowancesBefore:Awaited<ReturnType<typeof allowances>>;allowancesAfter:Awaited<ReturnType<typeof allowances>>;
   balancesBefore:Awaited<ReturnType<typeof balances>>;balancesAfter:Awaited<ReturnType<typeof balances>>}[]=[];
  const send=async(stage:typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number],to:Address,
   calldata:`0x${string}`)=>{
   const allowancesBefore=await allowances(),balancesBefore=await balances(),
    tx=await simulatePaperTransaction(fork,{action:stage,to,calldata},PAPER_ACCOUNT),
    allowancesAfter=await allowances(),balancesAfter=await balances();
   assert.equal(tx.sourceBlock,frame.source.block);assert(same(tx.sourceHash,frame.source.hash));
   assert(BigInt(tx.estimate.gas)>0n&&BigInt(tx.estimate.parentGas)<=BigInt(tx.estimate.gas));
   stageRows.push({stage,tx,allowancesBefore,allowancesAfter,balancesBefore,balancesAfter});
   return tx;
  };
  const deadline=source.timestamp+300n,bps=BigInt(route.slippageBps),
   min0=principal.amount0*(10_000n-bps)/10_000n,
   min1=principal.amount1*(10_000n-bps)/10_000n,
   calls=[encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{
    tokenId,liquidity:position.liquidity,amount0Min:min0,amount1Min:min1,deadline}]}),
    encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId,
     recipient:PAPER_ACCOUNT,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})];
  await send('withdraw_collect',p.positionManager as Address,
   encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',args:[calls]}));
  const afterCollect=await balances();
  assert.equal(afterCollect.token0,String(pre0));assert.equal(afterCollect.token1,String(pre1));
  const quoteResult=await context.local.simulateContract({address:route.quoter as Address,
   abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:route.path[0] as Address,
    tokenOut:route.path[1] as Address,amountIn:inputAmount,fee:route.fee,sqrtPriceLimitX96:0n}]});
  const expectedOutput=quoteResult.result[0],minimumOutput=expectedOutput*BigInt(10_000-route.slippageBps)/10_000n;
  assert(expectedOutput>0n&&minimumOutput>0n,'Close gas canonical quote has no output');
  const [postWithdrawSlot,postWithdrawLiquidity]=await Promise.all([
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'}),
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'})]);
  const quoteCalldata=encodeFunctionData({abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{
   tokenIn:route.path[0] as Address,tokenOut:route.path[1] as Address,amountIn:inputAmount,
   fee:route.fee,sqrtPriceLimitX96:0n}]});
  const quoteContent={schemaVersion:1 as const,kind:'paper_exact_input_quote_v1' as const,
   source:frame.source,router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
   inputAsset:route.inputAsset,inputAmountRaw:String(inputAmount),expectedOutputRaw:String(expectedOutput),
   minimumOutputRaw:String(minimumOutput),slippageBps:route.slippageBps,pathVersion:route.pathVersion};
  const quote={...quoteContent,quoteHash:contentHash(quoteContent)};
  const inputToken=route.path[0] as Address,outputToken=route.path[1] as Address;
  await send('approve_swap_input',inputToken,encodeFunctionData({abi:paperTokenAbi,
   functionName:'approve',args:[route.router as Address,inputAmount]}));
  const swapCalldata=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{
   tokenIn:inputToken,tokenOut:outputToken,fee:route.fee,recipient:PAPER_ACCOUNT,
   amountIn:inputAmount,amountOutMinimum:minimumOutput,sqrtPriceLimitX96:0n}]}),
   swapTx=await send('swap',route.router as Address,encodeFunctionData({abi:paperRouterAbi,
    functionName:'multicall',args:[deadline,[swapCalldata]]}));
  const swapReturns=decodeFunctionResult({abi:paperRouterAbi,functionName:'multicall',data:swapTx.returnData});
  assert.equal(swapReturns.length,1);
  assert.equal(decodeFunctionResult({abi:paperRouterAbi,functionName:'exactInputSingle',
   data:swapReturns[0]!}),expectedOutput,'Fork router output differs from exact source quote');
  for(const index of [0,1] as const){
   await send(index===0?'cleanup_manager_token0':'cleanup_manager_token1',
    index===0?p.token0 as Address:p.token1 as Address,
    encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[p.positionManager as Address,0n]}));
  }
  for(const index of [0,1] as const){
   await send(index===0?'cleanup_router_token0':'cleanup_router_token1',
    index===0?p.token0 as Address:p.token1 as Address,
    encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[p.router as Address,0n]}));
  }
  const finalBalances=await balances(),finalAllowances=await allowances(),
   finalPosition=await readCanaryPosition(context.local,tokenId,
    await context.local.getBlockNumber({cacheTime:0}));
  assert.equal(finalBalances[route.inputAsset], '0');
  const allowanceKeys=['manager0','manager1','router0','router1'] as const;
  assert(allowanceKeys.every(key=>finalAllowances[key]==='0'));
  assert.equal(finalPosition.liquidity,0n);assert.equal(finalPosition.tokensOwed0,0n);
  assert.equal(finalPosition.tokensOwed1,0n);
  assert.deepEqual(stageRows.map(row=>row.stage),[...PAPER_STATIC_CONVERT_GAS_STAGES_V2]);
  const scope={poolAddress:p.pool.toLowerCase(),profileHash:open.profileHash,
   openModelHash:contentHash(open),candidate:{deployedValue:open.candidate.deployedValue,
    sharePpm:open.candidate.dilutedSharePpm,tickLower:open.candidate.range.tickLower,
    tickUpper:open.candidate.range.tickUpper,liquidity:open.candidate.liquidity},
   routeHash:route.routeHash,inputAsset:route.inputAsset,inputAmountRaw:String(inputAmount),
   inventory:{token0Raw:String(pre0),token1Raw:String(pre1)},initialAllowances:stageRows[0]!.allowancesBefore};
  const scopeHash=contentHash(scope),sizeBand=`exact_${scopeHash.slice(0,32)}`,
   sampledAt=new Date().toISOString(),stageProfiles=stageRows.map((row,index)=>{
    const callHash=keccak256(row.tx.calldata),allowanceState=paperCloseConvertGasAllowanceStateV2(
     row.stage,row.allowancesBefore);
    const stageSource={block:row.tx.sourceBlock,hash:row.tx.sourceHash,estimatedAt:sampledAt,
     callHash,method:'owned_fork_nitro_exact_call_v1' as const},
     expected=BigInt(row.tx.estimate.gas);
    return {stage:row.stage,allowanceState,sourceHash:contentHash(stageSource),
     model:{schemaVersion:1 as const,source:stageSource,gasUnitsExpected:String(expected),
      gasUnitsBound:String(ceil(expected*13n,10n)),sizeMinValue:open.candidate.deployedValue,
      sizeMaxValue:open.candidate.deployedValue,shareMinPpm:open.candidate.dilutedSharePpm,
      shareMaxPpm:open.candidate.dilutedSharePpm,tickLower:open.candidate.range.tickLower,
      tickUpper:open.candidate.range.tickUpper,scopeHash,sequenceHash:'pending',
      stageIndex:index,stageCount:stageRows.length},evidence:{to:row.tx.to,calldata:row.tx.calldata,
      returnData:row.tx.returnData,localHash:row.tx.localHash,localGasUsed:row.tx.localGasUsed,
      localEffectiveGasPriceWei:row.tx.localEffectiveGasPriceWei,estimate:row.tx.estimate,
      stateOverrideHash:row.tx.stateOverrideHash,stateOverrides:row.tx.stateOverrides,
      balancesBefore:row.balancesBefore,balancesAfter:row.balancesAfter,
      allowancesBefore:row.allowancesBefore,allowancesAfter:row.allowancesAfter}};
   });
  const sequenceHash=contentHash(stageProfiles.map(stage=>({stage:stage.stage,
   allowanceState:stage.allowanceState,callHash:stage.model.source.callHash})));
  for(const stage of stageProfiles)stage.model.sequenceHash=sequenceHash;
  const postWithdrawReplayContent={poolState:{tick:postWithdrawSlot[1],
   sqrtPriceX96:String(postWithdrawSlot[0]),liquidity:String(postWithdrawLiquidity)},
   balances:afterCollect,withdrawCallHash:stageProfiles[0]!.model.source.callHash,
   quoterCallHash:keccak256(quoteCalldata),quotedOutputRaw:String(expectedOutput)};
  const postWithdrawReplay={...postWithdrawReplayContent,replayHash:contentHash(postWithdrawReplayContent)};
  const report={schemaVersion:2 as const,kind:'paper_close_convert_gas_report_v2' as const,
   pathVersion:PAPER_STATIC_CONVERT_GAS_PATH_V2,classification:'fork_estimated' as const,
   campaignId:open.campaignId,revision:open.revision,profile,profileHash:open.profileHash,
   runtimeIdentity,
   terminalMarkId:input.terminalMarkId,previousMarkId:input.previousMarkId,
   openModel:open,openModelHash:contentHash(open),source:frame.source,
   frame:{tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity),
    referenceProof:frame.referenceProof!,referenceProofHash:frame.referenceProofHash,
    price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice)},
   route,feeEvidence:input.feeEvidence,feeCarry:carry,
   inventory:{principal0Raw:String(principal.amount0),principal1Raw:String(principal.amount1),
    idle0Raw:String(idle0),idle1Raw:String(idle1),fee0Raw:String(fee0),fee1Raw:String(fee1),
    preSwap0Raw:String(pre0),preSwap1Raw:String(pre1),inputAsset:route.inputAsset,
    inputAmountRaw:String(inputAmount)},quote,scope,scopeHash,sequenceHash,sizeBand,sampledAt,
   postWithdrawReplay,
   restoredPosition:{tokenId:String(tokenId),liquidity:open.candidate.liquidity},
   initialAllowances:stageRows[0]!.allowancesBefore,finalBalances,finalAllowances,stageProfiles,
   readBudget:fork.budget,limitations:['owned_fork_restore_is_not_a_paper_fill',
    'gas_is_fork_estimated_not_paid','fee_carry_requires_registered_replay',
    'execution_delay_and_failure_unmodeled','source_verifier_must_replay_post_withdraw_quote']};
  const result={...report,reportHash:contentHash(report)};
  verifyPaperCloseConvertGasEvidence(result);
  return result;
 }finally{await fork.close();}
}
