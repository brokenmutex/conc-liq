import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeFunctionData,keccak256} from 'viem';
import {z} from 'zod';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {PAPER_ACCOUNT,paperTokenAbi} from '../paper/execution-abi.js';
import {allocationSchema,contentHash,staticParameters} from './contracts.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import {paperGasModelSchema,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from './paper-cost.js';

const positive=z.string().regex(/^[1-9][0-9]*$/);
const nonnegative=z.string().regex(/^(0|[1-9][0-9]*)$/);
const estimateSchema=z.object({gas:positive,parentGas:nonnegative,baseFeeWei:positive,
 parentBaseFeeWei:nonnegative,totalFeeWei:nonnegative,parentFeeWei:nonnegative,
 executionFeeWei:nonnegative,
 basis:z.literal('node_estimateGas_with_paper_prestate_and_parent_component')}).strict();

/** Checks the self-contained owned-fork report before it can be retained or
 * imported. This proves internal consistency, not independent provider truth. */
export function verifyPaperGasEvidence(raw:unknown){
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'Paper gas report missing');
 const report=raw as Record<string,unknown>,{reportHash,...body}=report;
 assert(typeof reportHash==='string'&&reportHash===contentHash(body),'Paper gas report hash mismatch');
 assert.equal(report.schemaVersion,1);assert.equal(report.pathVersion,PAPER_STATIC_GAS_PATH);
 assert.equal(report.strategyId,'static_manual_v1');
 const profile=marketProfileSchema.parse(report.profile);
 assert.equal(report.profileHash,contentHash(profile));
 assert.equal(String(report.pool).toLowerCase(),profile.pool.pool.toLowerCase());
 const parameters=staticParameters.parse(report.parameters);
 allocationSchema.parse(report.allocation);
 const config={...(report.parameters as Record<string,unknown>),strategyId:report.strategyId,
  strategyVersion:report.strategyVersion,stateSchemaVersion:report.stateSchemaVersion};
 assert.equal(report.configHash,contentHash(config));
 const source=report.source as {block:string;hash:string;timestamp:number};
 assert(source&&/^\d+$/.test(source.block)&&/^0x[0-9a-fA-F]{64}$/.test(source.hash)&&
  Number.isSafeInteger(source.timestamp)&&source.timestamp>0);
 const reference=report.reference as {proofHash:string};
 assert.equal(referenceProofHash(report.referenceProof),reference.proofHash);
 const candidate=report.candidate as {range:{tickLower:number;tickUpper:number};
  deployedValue:string;dilutedSharePpm:string;amount0Desired:string;amount1Desired:string;
  amount0Minted:string;amount1Minted:string};
 assert(candidate&&reference&&candidate.range);
 assert.equal(report.candidateHash,contentHash({campaignId:report.campaignId,revision:report.revision,
  profileHash:report.profileHash,configHash:report.configHash,source:report.source,
  referenceProofHash:reference.proofHash,candidate}));
 const stages=report.stageProfiles;
 assert(Array.isArray(stages)&&stages.length===PAPER_STATIC_GAS_STAGES.length);
 for(let index=0;index<stages.length;index++){
  const item=stages[index] as Record<string,unknown>;
  assert.equal(item.stage,PAPER_STATIC_GAS_STAGES[index]);
  const model=paperGasModelSchema.parse(item.model),evidence=item.evidence as Record<string,unknown>;
  assert.equal(item.sourceHash,contentHash(model.source));
  assert.equal(model.source.block,source.block);
  assert.equal(model.source.hash.toLowerCase(),source.hash.toLowerCase());
  assert.equal(model.source.estimatedAt,report.sampledAt);
  assert.equal(model.tickLower,candidate.range.tickLower);
  assert.equal(model.tickUpper,candidate.range.tickUpper);
  assert.equal(model.sizeMinValue,candidate.deployedValue);
  assert.equal(model.sizeMaxValue,candidate.deployedValue);
  assert.equal(model.shareMinPpm,candidate.dilutedSharePpm);
  assert.equal(model.shareMaxPpm,candidate.dilutedSharePpm);
  assert.equal(model.source.callHash,keccak256(evidence.calldata as `0x${string}`));
  const stage=PAPER_STATIC_GAS_STAGES[index]!,to=String(evidence.to);
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(stage==='approve_token0'||stage==='approve_token1'||stage==='cleanup_token0'||stage==='cleanup_token1'){
   const token=stage.endsWith('token0')?profile.pool.token0:profile.pool.token1;
   assert(same(to,token),'Token stage target changed');
   const call=decodeFunctionData({abi:paperTokenAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(call.functionName,'approve');
   assert(same(call.args[0],profile.pool.positionManager));
   const expected=stage.startsWith('cleanup')?0n:
    BigInt(stage.endsWith('token0')?candidate.amount0Desired:candidate.amount1Desired);
   assert.equal(call.args[1],expected);
  }else if(stage==='mint'){
   assert(same(to,profile.pool.positionManager));
   const call=decodeFunctionData({abi:guardedCanaryPositionManagerAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(call.functionName,'mint');
   const p=call.args[0];
   assert(same(p.token0,profile.pool.token0)&&same(p.token1,profile.pool.token1));
   assert.equal(p.fee,profile.pool.fee);assert.equal(p.tickLower,candidate.range.tickLower);
   assert.equal(p.tickUpper,candidate.range.tickUpper);assert(same(p.recipient,PAPER_ACCOUNT));
  assert.equal(p.amount0Desired,BigInt(candidate.amount0Desired));
  assert.equal(p.amount1Desired,BigInt(candidate.amount1Desired));
   assert(parameters.limits);
   const haircut=10_000n-BigInt(parameters.limits.maxSlippageBps);
   assert.equal(p.amount0Min,BigInt(candidate.amount0Minted)*haircut/10_000n);
   assert.equal(p.amount1Min,BigInt(candidate.amount1Minted)*haircut/10_000n);
   assert(p.deadline>BigInt(source.timestamp)&&p.deadline<=BigInt(source.timestamp+300));
  }else{
   assert(same(to,profile.pool.positionManager));
   const outer=decodeFunctionData({abi:canaryExitAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(outer.functionName,'multicall');assert.equal(outer.args[0].length,2);
   const decrease=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][0]!});
   const collect=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][1]!});
   assert.equal(decrease.functionName,'decreaseLiquidity');assert.equal(collect.functionName,'collect');
   assert.equal(decrease.args[0].tokenId,BigInt(report.tokenId as string));
   assert.equal(decrease.args[0].liquidity,BigInt(report.liquidity as string));
   assert(decrease.args[0].deadline>BigInt(source.timestamp)&&
    decrease.args[0].deadline<=BigInt(source.timestamp+300));
   assert.equal(collect.args[0].tokenId,decrease.args[0].tokenId);
   assert(same(collect.args[0].recipient,PAPER_ACCOUNT));
   assert.equal(collect.args[0].amount0Max,(1n<<128n)-1n);
   assert.equal(collect.args[0].amount1Max,(1n<<128n)-1n);
  }
  assert(BigInt(model.gasUnitsExpected)>0n&&BigInt(model.gasUnitsBound)>=BigInt(model.gasUnitsExpected));
  const estimate=estimateSchema.parse(evidence.estimate);
  assert.equal(model.gasUnitsExpected,estimate.gas);
  assert(BigInt(estimate.parentGas)<=BigInt(estimate.gas));
  assert.equal(BigInt(estimate.totalFeeWei),BigInt(estimate.gas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.parentFeeWei),BigInt(estimate.parentGas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.executionFeeWei),BigInt(estimate.totalFeeWei)-BigInt(estimate.parentFeeWei));
  assert.equal(evidence.stateOverrideHash,createHash('sha256')
   .update(JSON.stringify(evidence.stateOverrides)).digest('hex'));
 }
 return report;
}
