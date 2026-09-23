import {z} from 'zod';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import {contentHash} from './contracts.js';
import type {PaperGasProfileRow} from './paper-cost.js';

const WAD=10n**18n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address=z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const RANGEKEEPER_PAPER_NO_SWAP_PATH='paper_rangekeeper_v1_no_swap_v1';
export const RANGEKEEPER_PAPER_DIRECT_SWAP_PATH='paper_rangekeeper_v1_direct_swap_v1';
export const RANGEKEEPER_PAPER_ZERO_ALLOWANCES='zero_core_allowances_v1';
export const RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES='candidate_post_entry_v1';

export const RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP=[
 'open_approve_manager_token0','open_approve_manager_token1','open_mint',
] as const;
export const RANGEKEEPER_PAPER_OPEN_STAGES_SWAP=[
 'open_approve_manager_input','open_approve_manager_acquired','open_approve_router_input',
 'open_swap','open_mint',
] as const;
export const RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES=[
 'exit_withdraw_collect','exit_cleanup_router_token0','exit_cleanup_router_token1',
 'exit_cleanup_manager_token0','exit_cleanup_manager_token1',
] as const;

const gasSource=z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),
 callHash:hash,method:z.literal('owned_fork_nitro_exact_call_v1')}).strict();
const range=z.object({tickLower:z.number().int().min(-887272).max(887272),
 tickUpper:z.number().int().min(-887272).max(887272)}).strict();
const candidateSimulation=z.object({kind:z.literal('owned_fork_full_candidate_v1'),
 status:z.literal('success'),sourceBlock:raw,sourceHash:hash,
 candidateHash:z.string().regex(/^[0-9a-f]{64}$/),sequenceHash:hash}).strict();
const gasProfileModel=z.object({schemaVersion:z.literal(1),source:gasSource,
 gasUnitsExpected:raw,gasUnitsBound:raw,poolAddress:address,
 pathVersion:z.enum([RANGEKEEPER_PAPER_NO_SWAP_PATH,RANGEKEEPER_PAPER_DIRECT_SWAP_PATH]),
 stage:z.string().min(1),allowanceState:z.enum([RANGEKEEPER_PAPER_ZERO_ALLOWANCES,
  RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES]),profileHash:z.string().regex(/^[0-9a-f]{64}$/),
 candidateHash:z.string().regex(/^[0-9a-f]{64}$/),deployedValue:raw,sharePpm:raw,
 range,swapKind:z.enum(['none','direct_pool_exact_input']),simulation:candidateSimulation}).strict();

export interface RangeKeeperPaperCandidateScope {
 poolAddress:string;profileHash:string;candidateHash:string;deployedValue:bigint;sharePpm:bigint;
 range:{tickLower:number;tickUpper:number};swapKind:'none'|'direct_pool_exact_input';
}
export interface RangeKeeperPaperSelectedStage {
 stage:string;profileId:string;version:number;evidenceClass:'fork_estimated';
 expectedGasUnits:string;boundGasUnits:string;source:z.infer<typeof gasSource>;
}
export interface RangeKeeperPaperGasProfileQuery {
 poolAddress:string;pathVersion:string;sizeBand:string;
}
export type RangeKeeperPaperGasProfileReader=
 (query:RangeKeeperPaperGasProfileQuery)=>Promise<readonly PaperGasProfileRow[]>;
export interface RangeKeeperPaperCostProfiles {
 status:'available';evidenceClass:'fork_estimated';profileStatus:'provisional';
 pathVersion:string;sizeBand:string;scope:RangeKeeperPaperCandidateScope;
 source:{block:string;hash:string;timestamp:number};simulationHash:string;
 openStages:RangeKeeperPaperSelectedStage[];
 retainExitStages:RangeKeeperPaperSelectedStage[];
}
export type RangeKeeperPaperCostSelection=
 |RangeKeeperPaperCostProfiles
 |{status:'unavailable';reason:string;missingStages:string[]};

const expectedStages=(candidate:RangeKeeperCandidate)=>candidate.swap?
 [...RANGEKEEPER_PAPER_OPEN_STAGES_SWAP,...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES]:
 [...RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
export const rangeKeeperPaperPathVersion=(candidate:RangeKeeperCandidate)=>candidate.swap?
 RANGEKEEPER_PAPER_DIRECT_SWAP_PATH:RANGEKEEPER_PAPER_NO_SWAP_PATH;
const allowanceState=(stage:string)=>stage.startsWith('open_')?
 RANGEKEEPER_PAPER_ZERO_ALLOWANCES:RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES;

export function rangeKeeperPaperSizeBand(path:string,scope:RangeKeeperPaperCandidateScope){
 return `rk_${contentHash({path,poolAddress:scope.poolAddress.toLowerCase(),profileHash:scope.profileHash,
  candidateHash:scope.candidateHash,deployedValue:String(scope.deployedValue),sharePpm:String(scope.sharePpm),
  range:scope.range,swapKind:scope.swapKind}).slice(0,32)}`;
}

/** Exact candidate identity used by gas collection and by the preview gate. */
export function rangeKeeperPaperCandidateHash(input:{campaignId:string;revision:number;profileHash:string;
 configHash:string;source:{block:string;hash:string;timestamp:number};referenceProofHash:string;
 candidate:RangeKeeperCandidate}){
 const c=input.candidate;
 const serialized={kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),
  quotedOut:String(c.swap.quotedOut),minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),
  feeValue:String(c.swap.feeValue),shortfallValue:String(c.swap.shortfallValue)}:null,
  amount0Desired:String(c.amount0Desired),amount1Desired:String(c.amount1Desired),
  amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),liquidity:String(c.liquidity),
  deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),sourceHash:c.sourceHash,
  expiresAt:c.expiresAt};
 return contentHash({campaignId:input.campaignId,revision:input.revision,profileHash:input.profileHash,
  configHash:input.configHash,source:input.source,referenceProofHash:input.referenceProofHash,
  candidate:serialized});
}

/** Select one complete, fresh, exact pool/path/size/range/candidate profile set.
 * The caller must obtain `rows` from a trusted read-only store query; request
 * JSON must never be allowed to supply these attestations. */
export function selectRangeKeeperPaperCostProfiles(input:{candidate:RangeKeeperCandidate;
 scope:RangeKeeperPaperCandidateScope;source:{block:string;hash:string;timestamp:number};
 rows:readonly PaperGasProfileRow[];now?:number}):RangeKeeperPaperCostSelection{
 const {candidate,scope,source}=input,now=input.now??Date.now(),path=rangeKeeperPaperPathVersion(candidate),
  stages=expectedStages(candidate),sizeBand=rangeKeeperPaperSizeBand(path,scope);
 if(input.rows.length>200)return {status:'unavailable',reason:'rangekeeper_calibration_query_bound',missingStages:[...stages]};
 const grouped=new Map<string,Map<string,PaperGasProfileRow>>();
 for(const row of input.rows){
  if(row.poolAddress.toLowerCase()!==scope.poolAddress.toLowerCase()||row.pathVersion!==path||
   row.sizeBand!==sizeBand||row.component!=='gas_units'||row.evidenceClass!=='fork_estimated'||
   row.status!=='provisional')continue;
  const group=grouped.get(row.sizeBand)??new Map<string,PaperGasProfileRow>();
  const prior=group.get(row.stage);
  if(!prior||row.version>prior.version)group.set(row.stage,row);
  grouped.set(row.sizeBand,group);
 }
 const valid=(row:PaperGasProfileRow,stage:string)=>{
  const parsed=gasProfileModel.safeParse(row.model);
  if(!parsed.success||row.sourceHash!==contentHash(parsed.data.source)||
   !row.observedUntil||parsed.data.stage!==stage||parsed.data.pathVersion!==path||
   parsed.data.allowanceState!==allowanceState(stage)||
   parsed.data.poolAddress.toLowerCase()!==scope.poolAddress.toLowerCase()||
   parsed.data.profileHash!==scope.profileHash||parsed.data.candidateHash!==scope.candidateHash||
   parsed.data.deployedValue!==String(scope.deployedValue)||parsed.data.sharePpm!==String(scope.sharePpm)||
   parsed.data.range.tickLower!==scope.range.tickLower||parsed.data.range.tickUpper!==scope.range.tickUpper||
   parsed.data.swapKind!==scope.swapKind||parsed.data.source.block!==source.block||
   parsed.data.source.hash.toLowerCase()!==source.hash.toLowerCase()||
   parsed.data.simulation.sourceBlock!==source.block||
   parsed.data.simulation.sourceHash.toLowerCase()!==source.hash.toLowerCase()||
   parsed.data.simulation.candidateHash!==scope.candidateHash||
   BigInt(parsed.data.gasUnitsExpected)<=0n||BigInt(parsed.data.gasUnitsBound)<BigInt(parsed.data.gasUnitsExpected))
   return false;
  const sampled=Date.parse(parsed.data.source.estimatedAt),observed=row.observedUntil.getTime();
  return Number.isFinite(sampled)&&Math.abs(observed-sampled)<=1000&&now>=sampled&&
   now-sampled<=86_400_000&&now>=observed&&now-observed<=86_400_000&&
   sampled>=source.timestamp*1000&&sampled-source.timestamp*1000<=180_000;
 };
 const matches=[...grouped.entries()].filter(([,group])=>stages.every(stage=>{
  const row=group.get(stage);return !!row&&valid(row,stage);
 })&&new Set(stages.map(stage=>group.get(stage)?.version??-1)).size===1&&
 new Set(stages.map(stage=>{
  const row=group.get(stage);return row?gasProfileModel.parse(row.model).simulation.sequenceHash:'';
 })).size===1);
 if(matches.length!==1){
  const existing=matches.length?[]:stages.filter(stage=>{
   const row=grouped.get(sizeBand)?.get(stage);return !row||!valid(row,stage);
  });
  return {status:'unavailable',reason:matches.length?'rangekeeper_calibration_scope_ambiguous':
   'rangekeeper_open_and_retain_exit_profiles_incomplete',missingStages:existing.length?existing:[...stages]};
 }
 const [band,group]=matches[0]!;
 const simulationHash=gasProfileModel.parse(group.get(stages[0]!)!.model).simulation.sequenceHash;
 const toSelected=(stage:string):RangeKeeperPaperSelectedStage=>{
  const row=group.get(stage)!,model=gasProfileModel.parse(row.model);
  return {stage,profileId:row.id,version:row.version,evidenceClass:'fork_estimated',
   expectedGasUnits:model.gasUnitsExpected,boundGasUnits:model.gasUnitsBound,source:model.source};
 };
 const openStages=stages.filter(stage=>stage.startsWith('open_')).map(toSelected);
 const retainExitStages=stages.filter(stage=>stage.startsWith('exit_')).map(toSelected);
 return {status:'available',evidenceClass:'fork_estimated',profileStatus:'provisional',
  pathVersion:path,sizeBand:band,scope,source,simulationHash,openStages,retainExitStages};
}

const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
const max=(a:bigint,b:bigint)=>a>b?a:b;
export interface RangeKeeperPaperModeledCosts {
 status:'provisional';scope:'range_keeper_open_and_retain_exit_gas_only';
 evidenceClass:'fork_estimated';pathVersion:string;sizeBand:string;
 profileIds:Array<{stage:string;id:string;version:number}>;
 marketGasPriceWei:string;boundGasPriceWei:string;gasPriceObservedAt:string;
 nativeReferencePrice:string;swapFeeAndShortfallValue:string;
 open:{expectedGasUnits:string;boundGasUnits:string;expectedWei:string;boundWei:string;
  expectedValue:string;boundValue:string};
 retainExit:{expectedGasUnits:string;boundGasUnits:string;expectedWei:string;boundWei:string;
  expectedValue:string;boundValue:string;requiredReserveWei:string};
 unavailable:string[];
}

/** Prices only the exact matched profile set. Safety reserves and bounds are
 * kept separate from provisional expected cost and from paid expense. */
export function modelRangeKeeperPaperCosts(input:{profiles:RangeKeeperPaperCostProfiles;
 limits:RangeKeeperLimits;nativePrice:bigint;marketGasPriceWei:bigint;
 swapFeeAndShortfallValue:bigint;now?:number}):RangeKeeperPaperModeledCosts{
 const {profiles,limits,nativePrice,marketGasPriceWei,swapFeeAndShortfallValue}=input,now=input.now??Date.now();
 if(nativePrice<=0n||marketGasPriceWei<=0n)throw Error('rangekeeper_paper_gas_market_unavailable');
 const gasPriceAt=new Date(now).toISOString();
 const boundGasPriceWei=ceil(marketGasPriceWei*5n,4n);
 const total=(rows:readonly RangeKeeperPaperSelectedStage[],field:'expectedGasUnits'|'boundGasUnits')=>
  rows.reduce((sum,row)=>sum+BigInt(row[field]),0n);
 const nativeCost=(units:bigint,price:bigint)=>units*price;
 const value=(wei:bigint)=>ceil(wei*nativePrice,WAD);
 const openExpected=total(profiles.openStages,'expectedGasUnits');
 const openBound=total(profiles.openStages,'boundGasUnits');
 const exitExpected=total(profiles.retainExitStages,'expectedGasUnits');
 const exitBound=total(profiles.retainExitStages,'boundGasUnits');
 const openExpectedWei=nativeCost(openExpected,marketGasPriceWei),openBoundWei=nativeCost(openBound,boundGasPriceWei);
 const exitExpectedWei=nativeCost(exitExpected,marketGasPriceWei),exitBoundWei=nativeCost(exitBound,boundGasPriceWei);
 return {status:'provisional',scope:'range_keeper_open_and_retain_exit_gas_only',
  evidenceClass:'fork_estimated',pathVersion:profiles.pathVersion,sizeBand:profiles.sizeBand,
  profileIds:[...profiles.openStages,...profiles.retainExitStages].map(row=>
   ({stage:row.stage,id:row.profileId,version:row.version})),
  marketGasPriceWei:String(marketGasPriceWei),boundGasPriceWei:String(boundGasPriceWei),
  gasPriceObservedAt:gasPriceAt,nativeReferencePrice:String(nativePrice),
  swapFeeAndShortfallValue:String(swapFeeAndShortfallValue),
  open:{expectedGasUnits:String(openExpected),boundGasUnits:String(openBound),
   expectedWei:String(openExpectedWei),boundWei:String(openBoundWei),
   expectedValue:String(value(openExpectedWei)+swapFeeAndShortfallValue),
   boundValue:String(value(openBoundWei)+swapFeeAndShortfallValue)},
  retainExit:{expectedGasUnits:String(exitExpected),boundGasUnits:String(exitBound),
   expectedWei:String(exitExpectedWei),boundWei:String(exitBoundWei),
   expectedValue:String(value(exitExpectedWei)),boundValue:String(value(exitBoundWei)),
   requiredReserveWei:String(max(limits.exitReserveWei,exitBoundWei))},
  unavailable:['fee_capture','paid_gas','native_balance','net_nav','alpha',
   'execution_delay','failure_expense','close_convert_swap']};
}
