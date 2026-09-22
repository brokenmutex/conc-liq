import {createHash} from 'node:crypto';
import {getAddress,isAddress} from 'viem';
import {z} from 'zod';

export const STRATEGY_IDS=['static_manual_v1','rangekeeper_v1'] as const;
export const strategyId=z.enum(STRATEGY_IDS);
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const address=z.string().refine(isAddress).transform(value=>getAddress(value));
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const jsonRecord=z.record(z.string(),z.unknown());

export const draftInput=z.object({
 mode:z.enum(['paper','live']),chainId:z.literal(4663),wallet:address,
 marketProfileId:z.uuid(),strategyId,
 strategyVersion:z.string().min(1).max(64),
 stateSchemaVersion:z.number().int().positive(),
 allocation:z.object({token0Raw:raw,token1Raw:raw,nativeWei:raw}).strict(),
 config:jsonRecord,
}).strict();
export type DraftInput=z.infer<typeof draftInput>;

export const operationKind=z.enum([
 'open','pause','resume','change_range','change_strategy','close_retain','close_convert',
]);
export type OperationKind=z.infer<typeof operationKind>;
export const acceptInput=z.object({
 previewId:z.uuid(),contentDigest:hash,expectedRevision:z.number().int().nonnegative(),
 idempotencyKey:z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
export type AcceptInput=z.infer<typeof acceptInput>;

export const previewInput=z.object({
 campaignId:z.uuid(),expectedRevision:z.number().int().positive(),kind:operationKind,
 request:jsonRecord,proposal:jsonRecord,evidence:jsonRecord,
 expiresAt:z.date(),
}).strict();
export type PreviewInput=z.infer<typeof previewInput>;

// Hash byte-identical semantic JSON even when object insertion order differs.
// The API accepts JSON only; bigint amounts are decimal strings.
export function canonicalJson(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){
  if(!Number.isFinite(value)||!Number.isSafeInteger(value))throw Error('unsafe_json_number');
  return JSON.stringify(value);
 }
 if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
 if(typeof value==='object'){
  const record=value as Record<string,unknown>;
  return `{${Object.keys(record).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
 }
 throw Error('unsupported_json_value');
}
export const contentHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');

export function previewDigest(input:Pick<PreviewInput,'campaignId'|'expectedRevision'|'kind'|'request'|'proposal'|'evidence'|'expiresAt'>){
 return contentHash({campaignId:input.campaignId,expectedRevision:input.expectedRevision,kind:input.kind,
  request:input.request,proposal:input.proposal,evidence:input.evidence,expiresAt:input.expiresAt.toISOString()});
}
