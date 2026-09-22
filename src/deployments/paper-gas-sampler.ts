import assert from 'node:assert/strict';
import {decodeFunctionResult,encodeFunctionData,keccak256,toHex,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {createRobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {principalAmounts} from '../backtest/principal.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {openPaperFork} from '../paper/fork.js';
import {localReceipt,prestateOverrides,simulatePaperTransaction,type PaperTransaction} from '../paper/execution-gas.js';
import {PAPER_ACCOUNT,paperTokenAbi} from '../paper/execution-abi.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {contentHash,staticParameters} from './contracts.js';
import {PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';
import type {PaperDraft,PaperOpenFrame} from './paper-preview.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';

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
    shareMinPpm:preview.candidate!.dilutedSharePpm,shareMaxPpm:preview.candidate!.dilutedSharePpm},
    evidence:{to:tx.to,calldata:tx.calldata,returnData:tx.returnData,localHash:tx.localHash,
     localGasUsed:tx.localGasUsed,localEffectiveGasPriceWei:tx.localEffectiveGasPriceWei,
     estimate:tx.estimate,stateOverrideHash:tx.stateOverrideHash,stateOverrides:tx.stateOverrides}};
  });
  const report={schemaVersion:1 as const,pathVersion:PAPER_STATIC_GAS_PATH,pool:pool.pool,
   profile:draft.profile,profileHash:draft.profileHash,parameters:draft.parameters,
   strategyId:draft.strategyId,strategyVersion:draft.strategyVersion,
   stateSchemaVersion:draft.stateSchemaVersion,allocation:draft.allocation,
   configHash:draft.configHash,campaignId:draft.id,candidateHash:preview.candidateHash,
   source:frame.source,reference:{price0:String(frame.price0),price1:String(frame.price1),
    nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash},sampledAt,
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
