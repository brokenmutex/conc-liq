import assert from 'node:assert/strict';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand,
 type RangeKeeperPaperCandidateScope} from './rangekeeper-paper-cost.js';
import {simulateRangeKeeperPaperConfirmationOnOwnedFork,
 verifyRangeKeeperPaperOwnedForkConfirmationEvidence} from './rangekeeper-paper-confirmation-simulation.js';
import type {RangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-confirmation.js';
import {validateRangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-persistence.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,
  minOut:raw,priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
 deployedValue:raw,sourceBlock:raw,sourceHash:hash,expiresAt:z.number().int().nonnegative()}).strict();

function deserializeCandidate(value:unknown):RangeKeeperCandidate{
 const c=candidateSchema.parse(value);
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),
  quotedOut:BigInt(c.swap.quotedOut),minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),
  feeValue:BigInt(c.swap.feeValue),shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}

export type RangeKeeperPaperConfirmationReplayResult={status:'matched';campaignId:string;revision:number;
 operationId:string;openPreviewId:string;operationSnapshotHash:string;envelopeHash:string;
 candidateHash:string;simulationHash:string;replayHash:string;bookingAvailable:false;actionAvailable:false};
type ReplayRunner=typeof simulateRangeKeeperPaperConfirmationOnOwnedFork;
const replayCapabilities=new WeakMap<object,string>();

export function isRangeKeeperPaperConfirmationReplayCapability(value:unknown,expected:{operationId:string;
 openPreviewId:string;operationSnapshotHash:string;campaignId:string;revision:number;envelopeHash:string;
 candidateHash:string;simulationHash:string}):value is RangeKeeperPaperConfirmationReplayResult{
 if(!value||typeof value!=='object')return false;
 const saved=replayCapabilities.get(value),row=value as RangeKeeperPaperConfirmationReplayResult;
 return saved!==undefined&&saved===contentHash(row)&&row.status==='matched'&&
  row.bookingAvailable===false&&row.actionAvailable===false&&
  row.operationId===expected.operationId&&row.openPreviewId===expected.openPreviewId&&
  row.operationSnapshotHash===expected.operationSnapshotHash&&row.campaignId===expected.campaignId&&
  row.revision===expected.revision&&row.envelopeHash===expected.envelopeHash&&
  row.candidateHash===expected.candidateHash&&row.simulationHash===expected.simulationHash;
}

/** Replays a persisted second-observation confirmation on a fresh owned fork.
 * All candidate and policy inputs are reconstructed from the persisted
 * envelope plus the server-loaded campaign draft. The only mutable dependency
 * is an internal runner seam for unit tests; HTTP callers cannot supply stage
 * evidence. This is a replay verifier only and never books or enables action. */
export async function replayRangeKeeperPaperConfirmationOnOwnedFork(input:{
 draft:RangeKeeperPaperDraft;envelope:RangeKeeperPaperConfirmationEnvelope;frame:PaperOpenFrame;
 operationId:string;openPreviewId:string;operationSnapshotHash:string;
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
},dependencies:{runOwnedFork?:ReplayRunner}={}):Promise<RangeKeeperPaperConfirmationReplayResult>{
 const {draft,frame}=input,
  envelope=validateRangeKeeperPaperConfirmationEnvelope(input.envelope,
   {campaignId:draft.id,revision:draft.revision});
 assert(z.uuid().safeParse(input.operationId).success,'Replay operation ID is invalid');
 assert(z.uuid().safeParse(input.openPreviewId).success,'Replay preview ID is invalid');
 assert(/^[0-9a-f]{64}$/.test(input.operationSnapshotHash),'Replay operation snapshot hash is invalid');
 assert.equal(draft.id,envelope.campaignId,'Replay campaign differs from persisted confirmation');
 assert.equal(draft.revision,envelope.revision,'Replay revision differs from persisted confirmation');
 assert.equal(draft.strategyId,'rangekeeper_v1');
 assert.equal(draft.configHash,envelope.draftConfigHash);
 assert.equal(draft.profileHash,envelope.profileHash);
 assert.equal(contentHash(draft.profile),draft.profileHash);
 assert.equal(contentHash(frame.source),contentHash(envelope.confirmationObservation.source),
  'Replay frame is not the persisted confirmation source');
 assert.equal(frame.referenceEligible,true);
 assert(frame.referenceProof,'Replay frame has no independent reference proof');
 assert.equal(referenceProofHash(frame.referenceProof),frame.referenceProofHash);
 assert.equal(frame.referenceProofHash,envelope.confirmationObservation.reference.proofHash);
 assert.equal(String(frame.tick),String(envelope.confirmationObservation.poolState.tick));
 assert.equal(String(frame.sqrtPriceX96),envelope.confirmationObservation.poolState.sqrtPriceX96);
 assert.equal(String(frame.poolLiquidity),envelope.confirmationObservation.poolState.poolLiquidity);
 assert.equal(String(frame.price0),envelope.confirmationObservation.reference.price0);
 assert.equal(String(frame.price1),envelope.confirmationObservation.reference.price1);
 assert.equal(String(frame.nativePrice),envelope.confirmationObservation.reference.nativePrice);
 assert.equal(contentHash(frame.referenceProof),contentHash(envelope.confirmationObservation.reference.proof));

 const buildId=(envelope.strategyState as {buildId?:unknown})?.buildId;
 assert.equal(typeof buildId,'string','Persisted strategy build identity is missing');
 const policy=resolveRangeKeeperPaperPolicy(draft,buildId as string);
 assert(policy.policy&&policy.unavailable.length===0,'Replay policy is unavailable');
 const candidate=deserializeCandidate(envelope.confirmationObservation.candidate),source=frame.source,
  candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
   profileHash:draft.profileHash,configHash:draft.configHash,source,
   referenceProofHash:frame.referenceProofHash,candidate});
 assert.equal(candidateHash,envelope.confirmationObservation.candidateHash,
  'Persisted candidate does not replay to its source-bound identity');
 const denominator=frame.poolLiquidity+candidate.liquidity;
 assert(denominator>0n,'Replay candidate liquidity share is unavailable');
 const scope:RangeKeeperPaperCandidateScope={poolAddress:draft.profile.pool.pool,
  profileHash:draft.profileHash,candidateHash,deployedValue:candidate.deployedValue,
  sharePpm:candidate.liquidity*1_000_000n/denominator,range:candidate.range,
  swapKind:candidate.swap?'direct_pool_exact_input':'none'};
 const probe={status:'candidate' as const,campaignId:draft.id,revision:draft.revision,
  firstModelHash:envelope.firstObservation.modelHash,firstCandidateHash:envelope.firstObservation.candidateHash,
  source,candidate,candidateHash,scope,pathVersion:rangeKeeperPaperPathVersion(candidate),
  sizeBand:rangeKeeperPaperSizeBand(rangeKeeperPaperPathVersion(candidate),scope),actionAvailable:false as const};
 const replay=await (dependencies.runOwnedFork??simulateRangeKeeperPaperConfirmationOnOwnedFork)({probe,
  profile:draft.profile,frame,configHash:draft.configHash,
  initialBalances:[BigInt(draft.allocation.token0Raw),BigInt(draft.allocation.token1Raw)],
  limits:policy.policy.limits,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests,timeoutMs:input.timeoutMs});
 assert.equal(replay.status,'success');
 assert.equal(replay.sourceBlock,envelope.decision.simulation.sourceBlock);
 assert.equal(replay.sourceHash.toLowerCase(),envelope.decision.simulation.sourceHash.toLowerCase());
 assert.equal(replay.candidateHash,envelope.confirmationObservation.candidateHash);
 assert.equal(replay.simulationHash,envelope.decision.simulation.simulationHash);
 const expected=verifyRangeKeeperPaperOwnedForkConfirmationEvidence(envelope.simulationEvidence,{
  campaignId:draft.id,revision:draft.revision,configHash:draft.configHash,profileHash:draft.profileHash,
  source,candidate,referenceProofHash:frame.referenceProofHash,candidateHash,
  simulationHash:replay.simulationHash});
 assert.equal(contentHash(replay.ownedForkEvidence),contentHash(expected),
  'Owned-fork stage outcomes do not exactly replay the persisted confirmation evidence');
 const body={status:'matched' as const,campaignId:draft.id,revision:draft.revision,
  operationId:input.operationId,openPreviewId:input.openPreviewId,
  operationSnapshotHash:input.operationSnapshotHash,envelopeHash:envelope.envelopeHash,
  candidateHash,simulationHash:replay.simulationHash,replayHash:contentHash(replay.ownedForkEvidence),
  bookingAvailable:false as const,actionAvailable:false as const};
 const result=Object.freeze(body);
 if(!dependencies.runOwnedFork)replayCapabilities.set(result,contentHash(body));
 return result;
}
