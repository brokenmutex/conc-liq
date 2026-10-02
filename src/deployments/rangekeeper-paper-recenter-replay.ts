import assert from 'node:assert/strict';
import {z} from 'zod';
import type {RobinhoodClient} from '../client.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {contentHash} from './contracts.js';
import {readRangeKeeperPaperConfirmationFrame} from './rangekeeper-paper-confirmation-frame.js';
import {assertRangeKeeperPaperRecenterSimulation,simulateRangeKeeperPaperRecenter}
 from './rangekeeper-paper-recenter-simulation.js';
import {buildRangeKeeperPaperRecenterBooking,parseRangeKeeperPaperCandidate,
 serializeRangeKeeperPaperCandidate,validateRangeKeeperPaperRecenterBooking} from './rangekeeper-paper-persistence.js';
import {buildRangeKeeperPaperRecenterPlan} from './rangekeeper-paper-recenter-model.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {verifyCanonicalPaperAnchors} from './paper-canonical-anchors.js';

export interface RangeKeeperPaperRecenterReplayBinding {
 operationId:string;previewId:string;campaignId:string;revision:number;
 operationSnapshotHash:string;modelHash:string;candidateHash:string;sourceBlock:string;sourceHash:string;
}
export type RangeKeeperPaperRecenterReplayCapability=RangeKeeperPaperRecenterReplayBinding&{
 status:'matched';simulationHash:string;actionAvailable:false;
};
const capabilities=new WeakMap<object,string>();

export function isRangeKeeperPaperRecenterReplayCapability(value:unknown,
 binding:RangeKeeperPaperRecenterReplayBinding):value is RangeKeeperPaperRecenterReplayCapability{
 if(!value||typeof value!=='object')return false;
 const row=value as RangeKeeperPaperRecenterReplayCapability;
 return capabilities.has(row)&&capabilities.get(row)===contentHash(row)&&row.status==='matched'&&
  row.actionAvailable===false&&Object.entries(binding).every(([key,expected])=>
   row[key as keyof RangeKeeperPaperRecenterReplayBinding]===expected);
}
export function assertRangeKeeperPaperRecenterReplayCapability(value:unknown,
 binding:RangeKeeperPaperRecenterReplayBinding):asserts value is RangeKeeperPaperRecenterReplayCapability{
 assert(isRangeKeeperPaperRecenterReplayCapability(value,binding),
  'rangekeeper_paper_recenter_replay_capability_invalid');
}

/** Capability minting is deliberately private. Only the canonical replay
 * runner in this module can brand evidence after it has re-read and simulated
 * the accepted transition on its own current-source paper fork. */
function mintRangeKeeperPaperRecenterReplayCapability(input:RangeKeeperPaperRecenterReplayCapability){
 const capability={...input};capabilities.set(capability,contentHash(capability));return capability;
}

/** Replays a claimed immutable change_range booking on a fresh canonical
 * owned fork. Only the simulation result privately branded by its module can
 * mint the operation-completion capability. */
export async function replayRangeKeeperPaperRecenterOnOwnedFork(input:{snapshot:unknown;
 client:RobinhoodClient;rpcUrl:string;beforeRead?:()=>Promise<void>;
 maxRequests?:number;timeoutMs?:number}):Promise<RangeKeeperPaperRecenterReplayCapability>{
 const raw=input.snapshot as Record<string,unknown>;
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw));
 const {snapshotHash,...snapshotBody}=raw;
 assert.equal(snapshotHash,contentHash(snapshotBody),'rangekeeper_paper_recenter_operation_snapshot_hash_mismatch');
 const snapshot=z.object({campaignId:z.uuid(),revision:z.number().int().positive(),
  runtimeIdentity:z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough(),
  operation:z.object({id:z.uuid(),previewId:z.uuid(),kind:z.literal('change_range'),
   acceptedAt:z.coerce.date(),proposal:z.record(z.string(),z.unknown())}).passthrough(),
  epochSnapshot:z.record(z.string(),z.unknown())}).passthrough().parse(raw);
 const proposal=snapshot.operation.proposal,
  booking=validateRangeKeeperPaperRecenterBooking(proposal.rangekeeperPaperRecenterModel);
 assert.equal(proposal.rangekeeperPaperRecenterModelHash,booking.modelHash);
 assert.equal(booking.modelHash,contentHash((({modelHash:_h,...body})=>body)(booking)));
 assert.equal(booking.campaignId,snapshot.campaignId);assert.equal(booking.revision,snapshot.revision);
 const epoch=snapshot.epochSnapshot as unknown as {draft:RangeKeeperPaperDraft;
  runtimeIdentity:{buildId:string};openMark:{source:PaperOpenFrame['source'];model?:Record<string,unknown>};
  previousMark:Parameters<typeof buildRangeKeeperPaperRecenterBooking>[0]['previousMark'];
  currentEpoch:number;pending:boolean};
 const draft=epoch.draft,openModel=epoch.openMark?.model as Record<string,unknown>|undefined;
 assert(draft&&openModel,'rangekeeper_paper_recenter_open_baseline_unavailable');
 const source=booking.source,reference=booking.reference;
 const saved:PaperOpenFrame={source,tick:booking.poolState.tick,
  sqrtPriceX96:BigInt(booking.poolState.sqrtPriceX96),poolLiquidity:BigInt(booking.poolState.poolLiquidity),
  price0:BigInt(reference.price0),price1:BigInt(reference.price1),nativePrice:BigInt(reference.nativePrice),
  referenceEligible:true,referenceReasons:[],referenceProof:reference.proof,
  referenceProofHash:reference.proofHash};
 const frame=await readRangeKeeperPaperConfirmationFrame({client:input.client,profile:draft.profile,saved});
 const policy=resolveRangeKeeperPaperPolicy(draft,snapshot.runtimeIdentity.buildId);
 assert(policy.policy&&policy.unavailable.length===0,'rangekeeper_paper_recenter_replay_policy_unavailable');
 const candidate=parseRangeKeeperPaperCandidate(booking.candidate),currentGasPrice=await input.client.getGasPrice();
 assert(booking.modeledCosts,'rangekeeper_paper_recenter_cost_model_unavailable');
 const frozenGasPrice=BigInt(booking.modeledCosts.marketGasPriceWei),gasPriceBound=BigInt(booking.modeledCosts.gasPriceBoundWei);
 assert(frozenGasPrice>0n&&gasPriceBound===(frozenGasPrice*5n+3n)/4n&&currentGasPrice<=gasPriceBound,
  'rangekeeper_paper_recenter_current_gas_price_exceeds_accepted_bound');
 const simulation=await simulateRangeKeeperPaperRecenter({snapshot:epoch as never,frame,candidate,
  policyLimits:policy.policy.limits,rpcUrl:input.rpcUrl,marketGasPriceWei:frozenGasPrice,
  beforeRead:input.beforeRead});
 assertRangeKeeperPaperRecenterSimulation(simulation);
 const previous=epoch.previousMark;
 buildRangeKeeperPaperRecenterBooking({draft,previousMark:previous,frame,booking});
 assert.equal(simulation.source.block,booking.source.block);
 assert.equal(simulation.source.hash.toLowerCase(),booking.source.hash.toLowerCase());
 assert.equal(simulation.candidateHash,booking.candidateHash);
 assert.equal(simulation.simulationHash,booking.simulationHash,
  'rangekeeper_paper_recenter_owned_fork_replay_mismatch');
 assert(booking.modeledCosts&&
  BigInt(simulation.modeledCosts.boundWei)<=BigInt(booking.modeledCosts.boundWei)&&
  BigInt(simulation.modeledCosts.boundValue)<=BigInt(booking.modeledCosts.boundValue)&&
  BigInt(simulation.modeledCosts.requiredReserveWei)<=BigInt(booking.modeledCosts.requiredReserveWei),
  'rangekeeper_paper_recenter_replay_cost_exceeds_accepted_bound');
 assert.equal(contentHash(simulation.inventory),contentHash(booking.inventory));
 assert.equal(contentHash(simulation.withdrawal),contentHash(booking.withdrawal));
 assert.equal(contentHash(simulation.collected),contentHash(booking.collected));
 assert.equal(contentHash(simulation.swap),contentHash(booking.swap));
 const acceptedAt=snapshot.operation.acceptedAt.getTime();
 assert(candidate.expiresAt*1000>=acceptedAt,
  'rangekeeper_paper_recenter_candidate_expired_before_acceptance');
 const chain=new RangeKeeperChain(input.client,draft.profile.pool);
 const replayPlan=await buildRangeKeeperPaperRecenterPlan({snapshot:epoch as never,frame,
  buildId:snapshot.runtimeIdentity.buildId,actionCost:BigInt(booking.modeledCosts.boundValue),
  actionGasWei:BigInt(booking.modeledCosts.boundWei),
  requiredExitReserveWei:BigInt(booking.modeledCosts.requiredReserveWei),
  now:acceptedAt,quote:async(token,amount)=>chain.quote({block:BigInt(frame.source.block),
   hash:frame.source.hash as `0x${string}`,timestamp:frame.source.timestamp},token,amount,
   frame.price0!,frame.price1!),simulate:async(planned)=>
    contentHash(serializeRangeKeeperPaperCandidate(planned))===
     contentHash(serializeRangeKeeperPaperCandidate(candidate))});
 assert.equal(replayPlan.decision.action,'execute',
  'rangekeeper_paper_recenter_replay_policy_not_executable');
 assert.equal(replayPlan.decision.reason,'two_confirmations',
  'rangekeeper_paper_recenter_replay_confirmation_missing');
 assert.equal(replayPlan.candidateHash,booking.candidateHash,
  'rangekeeper_paper_recenter_replay_candidate_hash_mismatch');
 assert(replayPlan.candidate&&contentHash(serializeRangeKeeperPaperCandidate(replayPlan.candidate))===
  contentHash(serializeRangeKeeperPaperCandidate(candidate)),
  'rangekeeper_paper_recenter_replay_candidate_mismatch');
 await verifyCanonicalPaperAnchors(input.client,draft.profile.pool.chainId,
  [epoch.openMark.source,previous.source,booking.source]);
 return mintRangeKeeperPaperRecenterReplayCapability({status:'matched',
  operationId:snapshot.operation.id,previewId:snapshot.operation.previewId,campaignId:snapshot.campaignId,
  revision:snapshot.revision,operationSnapshotHash:String(snapshotHash),modelHash:booking.modelHash,
  candidateHash:booking.candidateHash,sourceBlock:booking.source.block,sourceHash:booking.source.hash,
  simulationHash:simulation.simulationHash,actionAvailable:false});
}

export function isRangeKeeperPaperRecenterReplayCapabilityIssued(value:unknown){
 return !!value&&typeof value==='object'&&capabilities.has(value as object)&&
  capabilities.get(value as object)===contentHash(value);
}
