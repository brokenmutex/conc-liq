import {z} from 'zod';
import {contentHash} from './contracts.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const PAPER_STATIC_GAS_PATH='paper_static_manual_no_swap_v1';
export const PAPER_STATIC_GAS_STAGES=[
 'approve_token0','approve_token1','mint','withdraw_collect','cleanup_token0','cleanup_token1',
] as const;
const sourceSchema=z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),
 callHash:hash,method:z.literal('owned_fork_nitro_exact_call_v1')}).strict();
export const paperGasModelSchema=z.object({schemaVersion:z.literal(1),source:sourceSchema,
 gasUnitsExpected:raw,gasUnitsBound:raw,sizeMinValue:raw,sizeMaxValue:raw,
 shareMinPpm:raw,shareMaxPpm:raw,
 tickLower:z.number().int().min(-887272).max(887272),
 tickUpper:z.number().int().min(-887272).max(887272)}).strict();
export interface PaperGasProfileRow {
 id:string;version:number;poolAddress:string;pathVersion:string;stage:string;
 allowanceState:string;sizeBand:string;component:string;status:string;evidenceClass:string;
 model:unknown;sourceHash:string;observedUntil:Date|null;
}
type CostCandidate={range:{tickLower:number;tickUpper:number};deployedValue:string;dilutedSharePpm:string};
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;

/** Resolves complete, fresh exact-call stage evidence. No AAPL fork safety
 * allowance can be reclassified as modeled paid gas for another pool. */
export function costIndicativePaperOpenPreview<T extends {status:string;candidate:CostCandidate|null}>(preview:T,rows:readonly PaperGasProfileRow[],
 poolAddress:string,nativePrice:bigint,gasPriceWei:bigint,now=Date.now()){
 const missing=(reason:string)=>({...preview,costs:{status:'unavailable' as const,reason}});
 if(preview.status!=='indicative'||!preview.candidate)return missing('candidate_unavailable');
 if(rows.length>200)return missing('calibration_query_bound');
 const size=BigInt(preview.candidate.deployedValue),share=BigInt(preview.candidate.dilutedSharePpm);
 const groups=new Map<string,Map<string,PaperGasProfileRow>>();
 for(const row of rows){
  if(row.poolAddress.toLowerCase()!==poolAddress.toLowerCase()||row.pathVersion!==PAPER_STATIC_GAS_PATH||
   row.allowanceState!=='zero'||row.component!=='gas_units'||
   !PAPER_STATIC_GAS_STAGES.some(stage=>stage===row.stage))continue;
  const group=groups.get(row.sizeBand)??new Map<string,PaperGasProfileRow>();
  const prior=group.get(row.stage);
  if(!prior||row.version>prior.version)group.set(row.stage,row);
  groups.set(row.sizeBand,group);
 }
 const valid=(row:PaperGasProfileRow)=>{
  if(!['provisional','validated'].includes(row.status)||row.evidenceClass!=='fork_estimated'||
   !row.observedUntil)return false;
  const parsed=paperGasModelSchema.safeParse(row.model);
  if(!parsed.success||row.sourceHash!==contentHash(parsed.data.source))return false;
  const m=parsed.data,min=BigInt(m.sizeMinValue),max=BigInt(m.sizeMaxValue),
   shareMin=BigInt(m.shareMinPpm),shareMax=BigInt(m.shareMaxPpm);
  if(min>size||size>max||min>max||shareMin>share||share>shareMax||shareMin>shareMax||
   shareMax>1_000_000n||m.tickLower!==preview.candidate!.range.tickLower||
   m.tickUpper!==preview.candidate!.range.tickUpper||BigInt(m.gasUnitsExpected)<=0n||
   BigInt(m.gasUnitsBound)<BigInt(m.gasUnitsExpected))return false;
  const measured=Date.parse(m.source.estimatedAt),observed=row.observedUntil.getTime();
  return Math.abs(observed-measured)<=1000&&now-measured>=0&&now-measured<=86_400_000&&
   now-observed>=0&&now-observed<=86_400_000;
 };
 const complete=[...groups.entries()].filter(([,group])=>
  PAPER_STATIC_GAS_STAGES.every(stage=>{
   const row=group.get(stage);return row!==undefined&&valid(row);
  }));
 if(complete.length!==1)return missing(complete.length?'ambiguous_calibration_size_band':'complete_fresh_stage_costs_unavailable');
 if(nativePrice<=0n||gasPriceWei<=0n)return missing('gas_price_or_native_reference_unavailable');
 const [sizeBand,group]=complete[0]!;
 const stages=PAPER_STATIC_GAS_STAGES.map(stage=>{
  const row=group.get(stage)!,model=paperGasModelSchema.parse(row.model);
  return {stage,profileId:row.id,version:row.version,evidenceClass:row.evidenceClass,
   expectedGasUnits:model.gasUnitsExpected,boundGasUnits:model.gasUnitsBound,
   source:model.source};
 });
 const total=(indices:readonly number[],field:'expectedGasUnits'|'boundGasUnits')=>
  indices.reduce((sum,index)=>sum+BigInt(stages[index]![field]),0n);
 const boundGasPriceWei=ceil(gasPriceWei*5n,4n);
 const value=(units:bigint,price:bigint)=>ceil(units*price*nativePrice,10n**18n);
 const open=[0,1,2],retainClose=[3,4,5];
 const openExpected=total(open,'expectedGasUnits'),openBound=total(open,'boundGasUnits');
 const closeExpected=total(retainClose,'expectedGasUnits'),closeBound=total(retainClose,'boundGasUnits');
 return {...preview,costs:{status:'provisional' as const,scope:'open_and_close_retain_gas_only' as const,
  sizeBand,pathVersion:PAPER_STATIC_GAS_PATH,gasPriceWei:String(gasPriceWei),
  boundGasPriceWei:String(boundGasPriceWei),
  gasPriceObservedAt:new Date(now).toISOString(),nativeReferencePrice:String(nativePrice),stages,
  open:{expectedGasUnits:String(openExpected),boundGasUnits:String(openBound),
   expectedWei:String(openExpected*gasPriceWei),boundWei:String(openBound*boundGasPriceWei),
   expectedValue:String(value(openExpected,gasPriceWei)),boundValue:String(value(openBound,boundGasPriceWei))},
  closeRetain:{expectedGasUnits:String(closeExpected),boundGasUnits:String(closeBound),
   expectedWei:String(closeExpected*gasPriceWei),boundWei:String(closeBound*boundGasPriceWei),
   expectedValue:String(value(closeExpected,gasPriceWei)),boundValue:String(value(closeBound,boundGasPriceWei))},
  missing:['fee_capture','execution_delay','failure_expense','close_convert_swap']}};
}
