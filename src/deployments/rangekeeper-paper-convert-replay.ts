import assert from 'node:assert/strict';
import {z} from 'zod';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import {loadRangeKeeperPaperExitContext} from './rangekeeper-paper-context.js';
import {resolveRangeKeeperPaperPolicy} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperConvertQuoteSchema,terminalQuote,
 type RangeKeeperPaperExitModel} from './rangekeeper-paper-exit-model.js';
import {produceRangeKeeperPaperGasEvidence} from './rangekeeper-paper-gas-evidence.js';
import {sampleRangeKeeperPaperGasStages,terminalInventoryHash} from './rangekeeper-paper-gas-sampler.js';
import {readRangeKeeperPaperConfirmationFrame} from './rangekeeper-paper-confirmation-frame.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperPaperModeledExitCost} from './rangekeeper-paper-cost.js';

export function assertRangeKeeperPaperConvertReplayCost(input:{
 costs:Pick<RangeKeeperPaperModeledExitCost,'boundGasPriceWei'|'boundGasUnits'|'boundWei'|'boundValue'>;
 gasUnits:bigint;marketGasPriceWei:bigint;nativePrice:bigint;swapCost:bigint;nativeWei:bigint}){
 const {costs,gasUnits,marketGasPriceWei,nativePrice,swapCost,nativeWei}=input,
  wei=gasUnits*marketGasPriceWei,value=(wei*nativePrice+10n**18n-1n)/10n**18n+swapCost;
 assert(gasUnits>0n&&marketGasPriceWei>0n&&nativePrice>0n&&swapCost>=0n&&
  marketGasPriceWei<=BigInt(costs.boundGasPriceWei)&&gasUnits<=BigInt(costs.boundGasUnits)&&
  wei<=BigInt(costs.boundWei)&&wei<=nativeWei&&value<=BigInt(costs.boundValue),
  'rangekeeper_paper_convert_replay_cost_exceeds_accepted_bound');
}

export interface RangeKeeperPaperConvertReplayBinding {
 operationId:string;previewId:string;campaignId:string;revision:number;
 operationSnapshotHash:string;modelHash:string;quoteHash:string;sourceBlock:string;sourceHash:string;
}
export type RangeKeeperPaperConvertReplayCapability=RangeKeeperPaperConvertReplayBinding&{
 status:'matched';simulationHash:string;actionAvailable:false;
};
const capabilities=new WeakMap<object,string>();
export function isRangeKeeperPaperConvertReplayCapability(value:unknown,
 binding:RangeKeeperPaperConvertReplayBinding):value is RangeKeeperPaperConvertReplayCapability{
 if(!value||typeof value!=='object')return false;
 const row=value as RangeKeeperPaperConvertReplayCapability;
 return capabilities.has(row)&&capabilities.get(row)===contentHash(row)&&row.status==='matched'&&
  row.actionAvailable===false&&Object.entries(binding).every(([key,expected])=>
   row[key as keyof RangeKeeperPaperConvertReplayBinding]===expected);
}
export function assertRangeKeeperPaperConvertReplayCapability(value:unknown,
 binding:RangeKeeperPaperConvertReplayBinding):asserts value is RangeKeeperPaperConvertReplayCapability{
 assert(isRangeKeeperPaperConvertReplayCapability(value,binding),
  'rangekeeper_paper_convert_replay_capability_invalid');
}

/** The claim-bound snapshot comes only from the store. A fresh owned fork must
 * reproduce the accepted conversion at its exact canonical source before this
 * module issues a process-local completion capability. Serialized evidence is
 * never sufficient to recreate that capability. */
export async function replayRangeKeeperPaperConvertOnOwnedFork(input:{snapshot:unknown;
 client:RobinhoodClient;rpcUrl:string;beforeRead?:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number}):Promise<RangeKeeperPaperConvertReplayCapability>{
 const raw=input.snapshot as Record<string,unknown>;
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw));
 const {snapshotHash,...body}=raw;
 assert.equal(snapshotHash,contentHash(body),'rangekeeper_exit_operation_snapshot_hash_mismatch');
 const snapshot=z.object({campaignId:z.uuid(),revision:z.number().int().positive(),
  runtimeIdentity:z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough(),
  operation:z.object({id:z.uuid(),previewId:z.uuid(),kind:z.literal('close_convert'),
   acceptedAt:z.coerce.date(),proposal:z.record(z.string(),z.unknown())}).passthrough(),
  exitContext:z.unknown()}).passthrough().parse(raw);
 const proposal=snapshot.operation.proposal,model=proposal.rangekeeperPaperExitModel as RangeKeeperPaperExitModel;
 assert(model&&model.exitKind==='convert'&&model.status==='indicative');
 const modelHash=contentHash(model);
 assert.equal(proposal.rangekeeperPaperExitModelHash,modelHash);
 assert.equal(model.campaignId,snapshot.campaignId);assert.equal(model.revision,snapshot.revision);
 const conversion=rangeKeeperPaperConvertQuoteSchema.parse(model.conversion);
 assert.equal(contentHash(proposal.rangekeeperPaperConvertQuote),contentHash(conversion));
 const draft=(snapshot.exitContext as {draft:Parameters<typeof terminalQuote>[0]['draft']}).draft;
 const saved:PaperOpenFrame={source:model.source,tick:model.poolState.tick,
  sqrtPriceX96:BigInt(model.poolState.sqrtPriceX96),poolLiquidity:BigInt(model.poolState.poolLiquidity),
  price0:BigInt(model.reference.price0),price1:BigInt(model.reference.price1),
  nativePrice:BigInt(model.reference.nativePrice),referenceEligible:true,referenceReasons:[],
  referenceProof:model.reference.proof,referenceProofHash:model.reference.proofHash};
 const frame=await readRangeKeeperPaperConfirmationFrame({client:input.client,profile:draft.profile,saved});
 const context=await loadRangeKeeperPaperExitContext({campaignId:snapshot.campaignId,
  buildId:snapshot.runtimeIdentity.buildId,frame,now:snapshot.operation.acceptedAt.getTime(),
  readSnapshot:async()=>snapshot.exitContext,readGasProfiles:async()=>[]});
 assert(context.status==='available','rangekeeper_convert_replay_context_unavailable');
 assert.equal(context.openMarkId,model.openMarkId);
 assert.equal(contentHash(context.openModel),model.openModelHash);
 assert.equal(context.previous.id,model.previousMark.id);
 assert.equal(context.previous.candidateHash,model.candidateHash);
 assert.equal(context.currentEpoch.epoch,model.currentEpoch.epoch);
 assert.equal(context.currentEpoch.markHash,model.currentEpoch.markHash);
 assert.equal(context.currentEpoch.markId,model.currentEpoch.markId);
 assert.equal(context.kernel.inventoryProofHash,model.inventoryProofHash);
 const candidate=context.currentEpoch.candidate,p=draft.profile.pool;
 const policy=resolveRangeKeeperPaperPolicy(context.draft,snapshot.runtimeIdentity.buildId);
 assert(policy.policy&&policy.unavailable.length===0);
 const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
  tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
 assert.equal(String(principal.amount0),model.position.principal0);
 assert.equal(String(principal.amount1),model.position.principal1);
 const quote=await terminalQuote({candidateHash:model.candidateHash,kind:'convert',frame,
  draft:context.draft,amount0:principal.amount0+context.kernel.wallet0,
  amount1:principal.amount1+context.kernel.wallet1,chain:new RangeKeeperChain(input.client,p),
  limits:policy.policy.limits});
 assert.equal(contentHash(quote),contentHash(conversion),'rangekeeper_convert_quote_replay_mismatch');
 const scope={poolAddress:p.pool,profileHash:context.draft.profileHash,candidateHash:model.candidateHash,
  deployedValue:principal.amount0*frame.price0!/10n**BigInt(p.decimals0)+
   principal.amount1*frame.price1!/10n**BigInt(p.decimals1),
  sharePpm:candidate.liquidity*1_000_000n/(frame.poolLiquidity+candidate.liquidity),
  range:candidate.range,swapKind:candidate.swap?'direct_pool_exact_input' as const:'none' as const,
  inventoryHash:terminalInventoryHash(context,candidate,frame)};
 const marketGasPriceWei=await input.client.getGasPrice();
 assert(model.costs,'rangekeeper_paper_convert_cost_model_unavailable');
 const report=await produceRangeKeeperPaperGasEvidence({kind:'convert_exit',campaignId:snapshot.campaignId,
  revision:snapshot.revision,configHash:context.draft.configHash,buildId:snapshot.runtimeIdentity.buildId,
  profile:context.draft.profile,frame,candidateSource:context.currentEpoch.source,
  candidateReferenceProofHash:context.currentEpoch.candidateReferenceProofHash,candidate,
  openMarkId:context.openMarkId,openModelHash:model.openModelHash,scope,
  marketGasPriceWei,sampleOwnedFork:request=>
   sampleRangeKeeperPaperGasStages(request,{rpcUrl:input.rpcUrl,beforeRead:input.beforeRead??(async()=>{}),
    maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??150_000,
    limits:policy.policy!.limits,terminalContext:context,conversionQuote:conversion})});
 assertRangeKeeperPaperConvertReplayCost({costs:model.costs,
  gasUnits:report.stageProfiles.reduce((sum,row)=>sum+BigInt(row.model.gasUnitsExpected),0n),
  marketGasPriceWei,nativePrice:frame.nativePrice!,nativeWei:context.kernel.nativeWei,
  swapCost:BigInt(conversion.feeValue)+BigInt(conversion.shortfallValue)});
 await verifyCanonicalPaperAnchors(input.client,p.chainId,[context.openModel.source,context.currentEpoch.source,
  context.previous.source,model.source]);
 const capability:RangeKeeperPaperConvertReplayCapability={status:'matched',
  operationId:snapshot.operation.id,previewId:snapshot.operation.previewId,campaignId:snapshot.campaignId,
  revision:snapshot.revision,operationSnapshotHash:String(snapshotHash),modelHash,quoteHash:conversion.quoteHash,
  sourceBlock:model.source.block,sourceHash:model.source.hash,simulationHash:report.reportHash,actionAvailable:false};
 capabilities.set(capability,contentHash(capability));return capability;
}
