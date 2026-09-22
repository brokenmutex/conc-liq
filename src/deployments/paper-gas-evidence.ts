import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256} from 'viem';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import {marketProfileSchema} from './market-profile.js';
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
 const config={...(report.parameters as Record<string,unknown>),strategyId:report.strategyId,
  strategyVersion:report.strategyVersion,stateSchemaVersion:report.stateSchemaVersion};
 assert.equal(report.configHash,contentHash(config));
 const source=report.source as {block:string;hash:string;timestamp:number};
 assert(source&&/^\d+$/.test(source.block)&&/^0x[0-9a-fA-F]{64}$/.test(source.hash));
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
  assert.equal(model.source.callHash,keccak256(evidence.calldata as `0x${string}`));
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
