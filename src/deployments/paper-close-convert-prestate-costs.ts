import assert from 'node:assert/strict';
import {z} from 'zod';
import {contentHash} from './contracts.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from './paper-close-convert-model.js';
import {PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,
 buildProspectivePaperCloseConvertPrestateGasProfiles} from './paper-close-convert-prestate-gas-profiles.js';
import {verifyPaperCloseConvertPrestateReport,type PaperCloseConvertPrestateReport} from
 './paper-close-convert-prestate-sampler.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^[0-9a-f]{64}$/),
 addressHash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const prospectiveModelSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('paper_close_convert_prestate_gas_stage_v1'),
 stage:z.enum(PAPER_STATIC_CONVERT_GAS_STAGES_V2),source:z.object({block:raw,hash:addressHash,
  estimatedAt:z.iso.datetime({offset:true}),callHash:addressHash,
  method:z.literal('owned_fork_nitro_exact_call_v1')}).strict(),gasUnitsExpected:raw,gasUnitsBound:raw,
 sizeMinValue:raw,sizeMaxValue:raw,shareMinPpm:raw,shareMaxPpm:raw,tickLower:z.number().int(),
 tickUpper:z.number().int(),scopeHash:hash,sequenceHash:hash,stageIndex:z.number().int().nonnegative(),
 stageCount:z.number().int().positive(),feeCarryHash:hash,feeReplayHash:hash,latestMarkId:raw,
 latestMarkSource:z.object({block:raw,hash:addressHash,timestamp:z.number().int().nonnegative()}).strict(),
 routeHash:hash,quoteHash:hash,inventoryHash:hash,allowancesBefore:z.record(z.string(),raw),
 allowancesAfter:z.record(z.string(),raw),balancesBefore:z.record(z.string(),raw),
 balancesAfter:z.record(z.string(),raw)}).strict();
const stageSchema=z.object({stage:z.enum(PAPER_STATIC_CONVERT_GAS_STAGES_V2),profileId:z.uuid(),version:z.number().int().positive(),
 evidenceClass:z.literal('fork_estimated'),allowanceState:z.string().min(1),expectedGasUnits:raw,
 boundGasUnits:raw,sourceHash:hash,scopeHash:hash,sequenceHash:hash,stageIndex:z.number().int(),
 stageCount:z.number().int(),source:prospectiveModelSchema.shape.source}).strict();
export const paperCloseConvertPrestateCostsV1Schema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('paper_close_convert_prestate_costs_v1'),status:z.literal('provisional'),
 scope:z.literal('candidate_prestate_gas_only'),pathVersion:z.literal(PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1),
 reportHash:hash,scopeHash:hash,sequenceHash:hash,sizeBand:z.string().min(1),
 gasPriceWei:raw,boundGasPriceWei:raw,gasPriceObservedAt:z.iso.datetime({offset:true}),
 nativeReferencePrice:raw,stages:z.array(stageSchema).length(PAPER_STATIC_CONVERT_GAS_STAGES_V2.length),
 expectedGasUnits:raw,boundGasUnits:raw,expectedWei:raw,boundWei:raw,expectedValue:raw,boundValue:raw,
 paidGasAvailable:z.literal(false)}).strict().superRefine((value,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(value.stages.some((stage,index)=>stage.stage!==PAPER_STATIC_CONVERT_GAS_STAGES_V2[index]||
  stage.stageIndex!==index||stage.stageCount!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length||
  stage.scopeHash!==value.scopeHash||stage.sequenceHash!==value.sequenceHash||
  stage.evidenceClass!=='fork_estimated'))fail('prestate_cost_stage_binding_invalid');
 if(new Set(value.stages.map(stage=>stage.version)).size!==1)fail('prestate_cost_version_binding_invalid');
 const expected=value.stages.reduce((sum,stage)=>sum+BigInt(stage.expectedGasUnits),0n),
  bound=value.stages.reduce((sum,stage)=>sum+BigInt(stage.boundGasUnits),0n),
  price=BigInt(value.gasPriceWei),boundPrice=(price*5n+3n)/4n,
  expectedWei=expected*price,boundWei=bound*boundPrice,
  expectedValue=(expectedWei*BigInt(value.nativeReferencePrice)+10n**18n-1n)/10n**18n,
  boundValue=(boundWei*BigInt(value.nativeReferencePrice)+10n**18n-1n)/10n**18n;
 if(BigInt(value.boundGasPriceWei)!==boundPrice||BigInt(value.expectedGasUnits)!==expected||
  BigInt(value.boundGasUnits)!==bound||BigInt(value.expectedWei)!==expectedWei||
  BigInt(value.boundWei)!==boundWei||BigInt(value.expectedValue)!==expectedValue||
  BigInt(value.boundValue)!==boundValue)fail('prestate_cost_totals_invalid');
});
export type PaperCloseConvertPrestateCostsV1=z.infer<typeof paperCloseConvertPrestateCostsV1Schema>;
export interface PaperCloseConvertPrestateGasProfileRow {
 id:string;version:number;poolAddress:string;pathVersion:string;stage:string;allowanceState:string;
 sizeBand:string;component:string;status:string;evidenceClass:string;model:unknown;
 validation:Record<string,unknown>;sourceHash:string;observedUntil:Date;
}
function ceil(n:bigint,d:bigint){return (n+d-1n)/d;}

/** Resolves only the seven provisional prospective rows imported for this exact
 * report. It never looks at or relabels terminal V2 calibration profiles. */
export function selectPaperCloseConvertPrestateCostsV1(input:{report:unknown;
 rows:readonly PaperCloseConvertPrestateGasProfileRow[];gasPriceWei:bigint;
 gasPriceObservedAt:string;now?:number}):PaperCloseConvertPrestateCostsV1{
 const report=verifyPaperCloseConvertPrestateReport(input.report),prospective=
  buildProspectivePaperCloseConvertPrestateGasProfiles(report),now=input.now??Date.now(),
  gasPriceObservedAt=z.iso.datetime({offset:true}).parse(input.gasPriceObservedAt);
 if(input.gasPriceWei<=0n||input.gasPriceWei>2n**256n-1n||
  now<Date.parse(gasPriceObservedAt)||now-Date.parse(gasPriceObservedAt)>120_000)
  throw Error('paper_close_convert_prestate_cost_price_unavailable');
 const rows=input.rows.filter(row=>row.pathVersion===PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1&&
  row.validation?.reportHash===report.reportHash),
  ordered=prospective.profiles.map(expected=>{
   const matching=rows.filter(row=>row.stage===expected.stage&&row.allowanceState===expected.allowanceState&&
    row.sizeBand===prospective.sizeBand&&row.status==='provisional'&&
    row.evidenceClass==='fork_estimated'&&row.component==='gas_units'&&
    row.poolAddress.toLowerCase()===report.profile.pool.pool.toLowerCase()&&
    row.sourceHash===expected.sourceHash&&contentHash(row.model)===contentHash(expected.model)&&
    row.validation.scopeHash===report.gasScopeHash&&
    row.validation.sequenceHash===report.gasSequenceHash&&row.validation.actionAvailable===false);
   if(matching.length!==1)throw Error('paper_close_convert_prestate_cost_profiles_unavailable');
   const row=matching[0]!;
   if(!(row.observedUntil instanceof Date)||Math.abs(row.observedUntil.getTime()-
    Date.parse(report.gasStages[0]!.source.estimatedAt))>1000||now<row.observedUntil.getTime()||
    now-row.observedUntil.getTime()>86_400_000)
    throw Error('paper_close_convert_prestate_cost_profile_stale');
   return {row,expected};
  });
 if(rows.length!==PAPER_STATIC_CONVERT_GAS_STAGES_V2.length||
  new Set(ordered.map(item=>item.row.version)).size!==1)
  throw Error('paper_close_convert_prestate_cost_profile_set_invalid');
 const stages=ordered.map(({row,expected},stageIndex)=>{
  const model=prospectiveModelSchema.parse(expected.model);
  assert.equal(row.id.length>0,true);
  return {stage:expected.stage,profileId:z.uuid().parse(row.id),version:row.version,
   evidenceClass:'fork_estimated' as const,allowanceState:expected.allowanceState,
   expectedGasUnits:model.gasUnitsExpected,boundGasUnits:model.gasUnitsBound,
   sourceHash:expected.sourceHash,scopeHash:report.gasScopeHash,
   sequenceHash:report.gasSequenceHash,stageIndex,stageCount:7,source:model.source};
 });
 const expectedGas=stages.reduce((sum,stage)=>sum+BigInt(stage.expectedGasUnits),0n),
  boundGas=stages.reduce((sum,stage)=>sum+BigInt(stage.boundGasUnits),0n),
  boundGasPrice=ceil(input.gasPriceWei*5n,4n),expectedWei=expectedGas*input.gasPriceWei,
  boundWei=boundGas*boundGasPrice,native=BigInt(report.frame.nativePrice),
  expectedValue=ceil(expectedWei*native,10n**18n),boundValue=ceil(boundWei*native,10n**18n);
 return paperCloseConvertPrestateCostsV1Schema.parse({schemaVersion:1,
  kind:'paper_close_convert_prestate_costs_v1',status:'provisional',scope:'candidate_prestate_gas_only',
  pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,reportHash:report.reportHash,
  scopeHash:report.gasScopeHash,sequenceHash:report.gasSequenceHash,sizeBand:prospective.sizeBand,
  gasPriceWei:String(input.gasPriceWei),boundGasPriceWei:String(boundGasPrice),
  gasPriceObservedAt,nativeReferencePrice:String(native),stages,expectedGasUnits:String(expectedGas),
  boundGasUnits:String(boundGas),expectedWei:String(expectedWei),boundWei:String(boundWei),
  expectedValue:String(expectedValue),boundValue:String(boundValue),paidGasAvailable:false});
}
