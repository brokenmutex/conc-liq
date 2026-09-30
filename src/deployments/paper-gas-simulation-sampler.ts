import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeFunctionResult,encodeAbiParameters,encodeFunctionData,keccak256,parseAbiParameters,
 stringToBytes,toHex,type Address} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {PAPER_ACCOUNT,paperTokenAbi} from '../paper/execution-abi.js';
import {contentHash,staticManualParameters} from './contracts.js';
import {paperGasBand,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';
import {buildIndicativePaperOpenPreview,type PaperDraft,type PaperOpenFrame} from './paper-preview.js';

const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const SIMULATION_METHOD='provider_simulate_v1_exact_call_v1' as const;
const SIMULATION_BASIS='provider_eth_simulateV1_sequenced_calls' as const;
/** Bounded scan for an ERC20's balance mapping slot. The owned fork finds this
 * exactly, by differencing `debug_traceCall` prestate traces against its own
 * anvil; that tracer is not available to us on the read provider, so the slot
 * is searched instead and then *proved* by reading the holder's balance back
 * through it. A token whose layout defeats the scan fails closed here, and the
 * caller falls back to the fork rather than guessing. */
const CLASSIC_SLOTS=60,ERC7201_NAMESPACES=['openzeppelin.storage.ERC20',
 'openzeppelin.storage.ERC20Upgradeable'] as const;

type SimulatedCall={status:string;gasUsed:string;returnData:`0x${string}`};
type SimulatedBlock={parentHash:`0x${string}`;calls:SimulatedCall[]};
type Override={balance?:`0x${string}`;stateDiff?:Record<string,`0x${string}`>};

const erc7201Base=(id:string)=>{
 const slot=BigInt(keccak256(toHex(BigInt(keccak256(stringToBytes(id)))-1n,{size:32})));
 return slot & ~0xffn;
};
const mappingKey=(holder:Address,slot:bigint)=>
 keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'),[holder,slot]));

/** A token's storage layout does not change, so a located slot is remembered
 * for the process. It is still proved against a live balance on every use —
 * one read — so an upgraded layout fails closed here rather than silently
 * funding nothing. Without this the scan dominates: sequentially it costs more
 * than the owned fork it replaces. */
const balanceSlots=new Map<string,bigint>();

/** Locates the balances mapping slot of `token` by finding the one that reads
 * back `holder`'s known balance. The slot is a property of the layout, not of
 * the holder, so the caller re-keys it onto the funded account. */
async function findBalanceSlot(client:RobinhoodClient,token:Address,holder:Address,
 blockNumber:bigint){
 const actual=await client.readContract({address:token,abi:paperTokenAbi,
  functionName:'balanceOf',args:[holder],blockNumber}) as bigint;
 assert(actual>0n,'Balance-slot probe holder is empty');
 const blockTag=toHex(blockNumber);
 const read=async(slot:bigint)=>BigInt(await client.request({method:'eth_getStorageAt',
  params:[token,mappingKey(holder,slot),blockTag]} as never) as `0x${string}`);
 const key=token.toLowerCase(),cached=balanceSlots.get(key);
 if(cached!==undefined&&await read(cached)===actual)return cached;
 balanceSlots.delete(key);
 const candidates=[...Array.from({length:CLASSIC_SLOTS},(_,index)=>BigInt(index)),
  ...ERC7201_NAMESPACES.flatMap(namespace=>{
   const base=erc7201Base(namespace);
   return [0,1,2,3].map(offset=>base+BigInt(offset));
  })];
 // Batched rather than one at a time: the whole scan is otherwise slower than
 // the fork, and rather than unbounded concurrency against the provider.
 for(let index=0;index<candidates.length;index+=12){
  const batch=candidates.slice(index,index+12);
  const values=await Promise.all(batch.map(read));
  const hit=values.findIndex(value=>value===actual);
  if(hit>=0){balanceSlots.set(key,batch[hit]!);return batch[hit]!;}
 }
 throw new Error('paper_gas_balance_slot_unavailable');
}

/** Reproduces the six no-swap open stages as `eth_simulateV1` sequences against
 * the read provider, instead of executing them on an owned anvil fork.
 *
 * Gas measured this way is what the calls actually consume, where the fork
 * records the node's `eth_estimateGas` result for the same call; the estimate
 * carries padding of roughly 1% on the approvals to 21% on withdraw_collect,
 * and `parentGas` is zero on this chain so no data component is lost either
 * way. Recording actual consumption is the deliberate choice here, with
 * `gasUnitsBound` continuing to carry the explicit margin.
 *
 * Two round trips are needed rather than one: `withdraw_collect`'s calldata
 * depends on the liquidity the mint returns. Nothing is broadcast and no state
 * is written; a failure raises so the caller can fall back to the fork. */
export async function sampleStaticPaperGasViaSimulation(input:{client:RobinhoodClient;
 draft:PaperDraft;frame:PaperOpenFrame}){
 const {client,draft,frame}=input;
 const preview=buildIndicativePaperOpenPreview(draft,frame);
 assert(preview.status==='indicative'&&preview.candidate,'Static paper candidate unavailable');
 assert(frame.referenceProof,'Paper gas reference proof unavailable');
 assert.equal(draft.strategyId,'static_manual_v1','Only static/manual no-swap calibration is supported');
 const limits=staticManualParameters.parse(draft.parameters).limits;
 assert(limits,'Static/manual limits are required');
 const pool=draft.profile.pool,candidate=preview.candidate;
 const blockNumber=BigInt(frame.source.block),blockTag=toHex(blockNumber);
 const amount0=BigInt(draft.allocation.token0Raw),amount1=BigInt(draft.allocation.token1Raw);
 const deadline=BigInt(frame.source.timestamp)+300n,bps=BigInt(limits.maxSlippageBps);

 // Fund by overriding each token's balance word for the paper account. The
 // pool itself is the probe holder: it necessarily holds both tokens.
 const slots=await Promise.all([findBalanceSlot(client,pool.token0 as Address,pool.pool as Address,blockNumber),
  findBalanceSlot(client,pool.token1 as Address,pool.pool as Address,blockNumber)]);
 const stateOverrides:Record<string,Override>={
  [PAPER_ACCOUNT]:{balance:toHex(10n**18n)},
  [pool.token0]:{stateDiff:{[mappingKey(PAPER_ACCOUNT,slots[0]!)]:toHex(amount0,{size:32})}},
  [pool.token1]:{stateDiff:{[mappingKey(PAPER_ACCOUNT,slots[1]!)]:toHex(amount1,{size:32})}},
 };
 const simulate=async(calls:{to:string;data:`0x${string}`}[])=>{
  const result=await client.request({method:'eth_simulateV1',params:[{
   blockStateCalls:[{stateOverrides,calls:calls.map(call=>({from:PAPER_ACCOUNT,to:call.to,data:call.data}))}],
   validation:false,traceTransfers:false,returnFullTransactionObjects:false},blockTag]} as never) as SimulatedBlock[];
  const block=result[0];
  assert(block&&block.calls.length===calls.length,'Simulated sequence is incomplete');
  assert(same(block.parentHash,frame.source.hash),'Simulation did not build on the pinned canonical source');
  block.calls.forEach((call,index)=>assert.equal(call.status,'0x1',
   `Simulated ${calls[index]!.to} call reverted`));
  return block;
 };

 const approve=(token:string,amount:bigint)=>({to:token,
  data:encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[pool.positionManager,amount]})});
 const mintCall={to:pool.positionManager,data:encodeFunctionData({
  abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[{token0:pool.token0,token1:pool.token1,
   fee:pool.fee,tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper,
   amount0Desired:amount0,amount1Desired:amount1,
   amount0Min:BigInt(candidate.amount0Minted)*(10_000n-bps)/10_000n,
   amount1Min:BigInt(candidate.amount1Minted)*(10_000n-bps)/10_000n,
   recipient:PAPER_ACCOUNT,deadline}]})};
 const opening=[approve(pool.token0,amount0),approve(pool.token1,amount1),mintCall];
 const openBlock=await simulate(opening);
 const [tokenId,liquidity,minted0,minted1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,
  functionName:'mint',data:openBlock.calls[2]!.returnData}) as [bigint,bigint,bigint,bigint];
 assert(liquidity>0n&&liquidity>=BigInt(candidate.liquidity),'Simulated mint differs from candidate');
 assert(minted0<=amount0&&minted1<=amount1,'Simulated mint exceeded fixture inventory');

 // No swap occurs in this sequence, so the pool price is still the frame's and
 // the principal owed back is computable rather than re-read.
 const principal=principalAmounts({liquidity,sqrtPriceX96:frame.sqrtPriceX96,
  tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper});
 const exit={to:pool.positionManager,data:encodeFunctionData({abi:canaryExitAbi,
  functionName:'multicall',args:[[
   encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{tokenId,liquidity,
    amount0Min:principal.amount0*(10_000n-bps)/10_000n,
    amount1Min:principal.amount1*(10_000n-bps)/10_000n,deadline}]}),
   encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId,recipient:PAPER_ACCOUNT,
    amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})]]})};
 const closing=[...opening,exit,approve(pool.token0,0n),approve(pool.token1,0n)];
 // Replayed from the same pinned state, so the exit's gas is measured with the
 // mint's writes already applied, exactly as the fork measures it.
 const closeBlock=await simulate(closing);

 const ordered=[openBlock.calls[0]!,openBlock.calls[1]!,openBlock.calls[2]!,
  closeBlock.calls[3]!,closeBlock.calls[4]!,closeBlock.calls[5]!];
 const targets=[opening[0]!,opening[1]!,opening[2]!,exit,closing[4]!,closing[5]!];
 const sampledAt=new Date().toISOString();
 const stateOverrideHash=createHash('sha256').update(JSON.stringify(stateOverrides)).digest('hex');
 const stageProfiles=PAPER_STATIC_GAS_STAGES.map((stage,index)=>{
  const call=ordered[index]!,target=targets[index]!;
  const stageSource={block:frame.source.block,hash:frame.source.hash,estimatedAt:sampledAt,
   callHash:keccak256(target.data),method:SIMULATION_METHOD};
  const expected=BigInt(call.gasUsed);
  return {stage,sourceHash:contentHash(stageSource),model:{schemaVersion:2 as const,
   source:stageSource,gasUnitsExpected:String(expected),gasUnitsBound:String(ceil(expected*13n,10n)),
   ...paperGasBand(candidate),
   tickLower:candidate.range.tickLower,tickUpper:candidate.range.tickUpper},
   evidence:{to:target.to,calldata:target.data,returnData:call.returnData,
    simulation:{gasUsed:String(expected),status:call.status,
     parentHash:openBlock.parentHash,basis:SIMULATION_BASIS},
    stateOverrideHash,stateOverrides}};
 });
 const report={schemaVersion:1 as const,pathVersion:PAPER_STATIC_GAS_PATH,pool:pool.pool,
  profile:draft.profile,profileHash:draft.profileHash,parameters:draft.parameters,
  strategyId:draft.strategyId,strategyVersion:draft.strategyVersion,
  stateSchemaVersion:draft.stateSchemaVersion,allocation:draft.allocation,
  configHash:draft.configHash,campaignId:draft.id,revision:draft.revision,
  candidateHash:preview.candidateHash,candidate,
  source:frame.source,reference:{price0:String(frame.price0),price1:String(frame.price1),
   nativePrice:String(frame.nativePrice),proofHash:frame.referenceProofHash},
  referenceProof:frame.referenceProof,sampledAt,
  funding:[{token:pool.token0,amount:String(amount0),slot:String(slots[0]),transferHash:null},
   {token:pool.token1,amount:String(amount1),slot:String(slots[1]),transferHash:null}],
  tokenId:String(tokenId),liquidity:String(liquidity),minted0:String(minted0),minted1:String(minted1),
  stageProfiles,readBudget:2,
  limitations:['Provider-simulated calibration probe, not a paper fill or live receipt',
   'Exact candidate range only; six no-swap stages and retain-close only',
   'Gas units are simulated actual consumption, not a node estimate; no fee capture or execution-delay model']};
 const result={...report,reportHash:contentHash(JSON.parse(JSON.stringify(report)))};
 verifyPaperGasEvidence(result);
 return result;
}
