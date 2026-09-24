import {z} from 'zod';

const sourceSchema=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),
 hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict();
const inputSchema=z.object({sampleSource:sourceSchema,feeCarryThrough:sourceSchema,
 feeCarryMode:z.enum(['persisted_exact','ephemeral_interval','stale_prior']),
 feeIntervalComplete:z.boolean(),feeAnchorsRechecked:z.boolean(),
 sevenStageReplayVerified:z.boolean(),prospectiveProfilesRegistered:z.boolean(),
 terminalEnvelopeWorkerReplayVerified:z.boolean()}).strict();

export type PaperCloseConvertPrestateGasGateInput=z.input<typeof inputSchema>;
export type PaperCloseConvertPrestateGasGate=z.infer<typeof outputSchema>;

const outputSchema=z.object({status:z.enum(['unavailable','fork_estimated']),
 evidenceAvailable:z.boolean(),actionAvailable:z.literal(false),
 feeCarryMatchesSampleSource:z.boolean(),ephemeralFeeIntervalVerified:z.boolean(),blockers:z.array(z.enum([
  'fee_carry_not_replayed_through_sample_source',
  'ephemeral_fee_interval_incomplete_or_unanchored',
  'seven_stage_owned_fork_replay_unavailable',
  'prospective_prestate_profiles_not_registered',
  'terminal_envelope_worker_replay_unavailable']))}).strict();

/**
 * Reports whether close-convert fork gas evidence is source-complete enough
 * to expose as a prospective profile set. A connected worker or a terminal
 * gas report cannot satisfy this gate: prestate evidence is a different scope
 * and remains `fork_estimated`, never a validated or paid gas claim.
 */
export function assessPaperCloseConvertPrestateGasGate(raw:PaperCloseConvertPrestateGasGateInput):
 PaperCloseConvertPrestateGasGate{
 const input=inputSchema.parse(raw),sameSource=input.sampleSource.block===input.feeCarryThrough.block&&
  input.sampleSource.hash.toLowerCase()===input.feeCarryThrough.hash.toLowerCase(),
  ephemeralFeeIntervalVerified=input.feeCarryMode==='ephemeral_interval'&&
   input.feeIntervalComplete&&input.feeAnchorsRechecked&&sameSource,
  blockers:PaperCloseConvertPrestateGasGate['blockers']=[];
 if(input.feeCarryMode==='stale_prior'||!sameSource)
  blockers.push('fee_carry_not_replayed_through_sample_source');
 if(input.feeCarryMode==='ephemeral_interval'&&!ephemeralFeeIntervalVerified)
  blockers.push('ephemeral_fee_interval_incomplete_or_unanchored');
 if(!input.sevenStageReplayVerified)blockers.push('seven_stage_owned_fork_replay_unavailable');
 if(!input.prospectiveProfilesRegistered)blockers.push('prospective_prestate_profiles_not_registered');
 if(!input.terminalEnvelopeWorkerReplayVerified)blockers.push('terminal_envelope_worker_replay_unavailable');
 const evidenceAvailable=blockers.length===0;
 return outputSchema.parse({status:evidenceAvailable?'fork_estimated':'unavailable',
  evidenceAvailable,actionAvailable:false,feeCarryMatchesSampleSource:sameSource,
  ephemeralFeeIntervalVerified,blockers});
}
