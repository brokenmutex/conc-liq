import {createHash} from 'node:crypto';
import {getAddress,isAddress} from 'viem';
import {z} from 'zod';

export const STRATEGY_IDS=['static_manual_v1','rangekeeper_v1'] as const;
export const strategyId=z.enum(STRATEGY_IDS);
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const address=z.string().refine(isAddress).transform(value=>getAddress(value));
const hash=z.string().regex(/^[0-9a-f]{64}$/);
const jsonRecord=z.record(z.string(),z.unknown());
const ppm=z.number().int().min(0).max(1_000_000);
const bps=z.number().int().min(0).max(10_000);
const expiry=z.iso.datetime({offset:true});
const commonLimits=z.object({
 maxDeploymentValue:raw,minDeploymentValue:raw,
 maxExposurePpm:ppm,maxLossValue:raw,maxDrawdownPpm:ppm,
 maxActionCost:raw,maxRollingCost:raw,maxCampaignCost:raw,
 exitReserveWei:raw,expiryAt:expiry.optional(),
}).strict();
const staticParameters=z.object({
 tickLower:z.number().int().min(-887272).max(887272),
 tickUpper:z.number().int().min(-887272).max(887272),
 limits:commonLimits.optional(),
}).strict().refine(value=>value.tickLower<value.tickUpper,{message:'range_order'});
const rangeKeeperParameters=z.object({
 fullWidthSpacings:z.number().int().min(2).max(2000).refine(value=>value%2===0),
 limits:commonLimits.extend({
  minDeploymentPpm:ppm,maxSwapInputValue:raw,maxSwapInputPpm:ppm,
  maxSwapShortfallValue:raw,maxSlippageBps:bps,maxRecenters:z.number().int().nonnegative(),
  maxLiquiditySharePpm:ppm,maxObservationGapSeconds:z.number().int().positive(),
 }).optional(),
}).strict();

export const draftInput=z.object({
 mode:z.enum(['paper','live']),chainId:z.literal(4663),wallet:address,
 marketProfileId:z.uuid(),strategyId,
 strategyVersion:z.literal('1.0.0'),
 stateSchemaVersion:z.literal(1),
 allocation:z.object({token0Raw:raw,token1Raw:raw,nativeWei:raw}).strict(),
 config:z.unknown(),
}).strict().superRefine((value,ctx)=>{
 const result=(value.strategyId==='static_manual_v1'?staticParameters:rangeKeeperParameters).safeParse(value.config);
 if(!result.success)ctx.addIssue({code:'custom',message:'invalid_strategy_parameters',path:['config']});
});
export type DraftInput=z.infer<typeof draftInput>;
export function parseStrategyParameters(id:z.infer<typeof strategyId>,value:unknown):Record<string,unknown>{
 return (id==='static_manual_v1'?staticParameters:rangeKeeperParameters).parse(value);
}

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
