import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import type {RangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-confirmation.js';
import {validateRangeKeeperPaperConfirmationEnvelope} from './rangekeeper-paper-persistence.js';

const hash64=z.string().regex(/^[0-9a-f]{64}$/),evmHash=z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 source=z.object({block:z.string().regex(/^(0|[1-9][0-9]*)$/),hash:evmHash,
  timestamp:z.number().int().nonnegative()}).strict();
const bodySchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_server_producer_receipt_v1'),
 campaignId:z.uuid(),revision:z.number().int().positive(),openPreviewId:z.uuid(),
 envelopeHash:hash64,producerRunId:z.uuid(),producerBuildId:hash64,configHash:hash64,
 profileHash:hash64,firstSource:source,confirmationSource:source,candidateHash:hash64,
 simulationHash:evmHash,createdAt:z.string().datetime()}).strict();
export type RangeKeeperPaperConfirmationProducerReceipt=z.infer<typeof bodySchema>&{receiptHash:string};

// Identity is process-local: only the server producer can register the exact
// envelope object returned by the store path it just invoked. It is consumed
// before a durable receipt is inserted; cloned/request-decoded objects fail.
const serverProduced=new WeakSet<object>();
export function markRangeKeeperPaperServerProduced(value:object){serverProduced.add(value);}
export function isRangeKeeperPaperServerProduced(value:unknown):value is RangeKeeperPaperConfirmationEnvelope{
 return typeof value==='object'&&value!==null&&serverProduced.has(value);
}

export function buildRangeKeeperPaperConfirmationProducerReceipt(input:{envelope:unknown;
 openPreviewId:string;producerRunId?:string;createdAt?:Date}):RangeKeeperPaperConfirmationProducerReceipt{
 const envelope=validateRangeKeeperPaperConfirmationEnvelope(input.envelope,
  {campaignId:(input.envelope as {campaignId:string}).campaignId,
   revision:(input.envelope as {revision:number}).revision}),
  strategyState=envelope.strategyState as {buildId?:unknown};
 if(typeof strategyState.buildId!=='string'||!hash64.safeParse(strategyState.buildId).success)
  throw new Error('rangekeeper_paper_producer_build_id_unavailable');
 const body=bodySchema.parse({schemaVersion:1,kind:'rangekeeper_paper_server_producer_receipt_v1',
  campaignId:envelope.campaignId,revision:envelope.revision,openPreviewId:input.openPreviewId,
  envelopeHash:envelope.envelopeHash,producerRunId:input.producerRunId??randomUUID(),
  producerBuildId:strategyState.buildId,configHash:envelope.draftConfigHash,
  profileHash:envelope.profileHash,firstSource:envelope.firstObservation.source,
  confirmationSource:envelope.confirmationObservation.source,
  candidateHash:envelope.confirmationObservation.candidateHash,
  simulationHash:envelope.decision.simulation.simulationHash,
  createdAt:(input.createdAt??new Date()).toISOString()});
 return {...body,receiptHash:contentHash(body)};
}

export function validateRangeKeeperPaperConfirmationProducerReceipt(value:unknown,expected:{
 campaignId:string;revision:number;openPreviewId:string;envelope:RangeKeeperPaperConfirmationEnvelope;
}):RangeKeeperPaperConfirmationProducerReceipt{
 const parsed=z.object({...bodySchema.shape,receiptHash:hash64}).strict().parse(value),
  {receiptHash,...body}=parsed,envelope=expected.envelope;
 if(receiptHash!==contentHash(body)||parsed.campaignId!==expected.campaignId||
  parsed.revision!==expected.revision||parsed.openPreviewId!==expected.openPreviewId||
  parsed.envelopeHash!==envelope.envelopeHash||parsed.configHash!==envelope.draftConfigHash||
  parsed.profileHash!==envelope.profileHash||parsed.candidateHash!==envelope.confirmationObservation.candidateHash||
  parsed.simulationHash!==envelope.decision.simulation.simulationHash||
  contentHash(parsed.firstSource)!==contentHash(envelope.firstObservation.source)||
  contentHash(parsed.confirmationSource)!==contentHash(envelope.confirmationObservation.source))
  throw new Error('rangekeeper_paper_producer_receipt_binding_invalid');
 return parsed as RangeKeeperPaperConfirmationProducerReceipt;
}
