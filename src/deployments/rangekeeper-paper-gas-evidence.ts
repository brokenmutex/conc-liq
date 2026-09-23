import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256,type Address} from 'viem';
import {z} from 'zod';
import {poolAbi} from '../abi.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import type {RobinhoodClient} from '../client.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import type {RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import {contentHash} from './contracts.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,
 rangeKeeperPaperSizeBand,RANGEKEEPER_PAPER_CONVERT_EXIT_STAGES,
 RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH,RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,
 RANGEKEEPER_PAPER_OPEN_STAGES_SWAP,RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES,
 RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES,RANGEKEEPER_PAPER_ZERO_ALLOWANCES,
 type RangeKeeperPaperCandidateScope} from './rangekeeper-paper-cost.js';
import type {PaperGasProfileRow} from './paper-cost.js';

const PPM=1_000_000n;
const WAD=10n**18n;
const raw=/^(0|[1-9][0-9]*)$/;
const hash64=/^[0-9a-f]{64}$/;
const evmHash=/^0x[0-9a-fA-F]{64}$/;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

type GasReportKind='open'|'retain_exit'|'convert_exit';
export interface RangeKeeperPaperGasStageSample {
 action:string;to:string;calldata:string;returnData:string;localHash:string;
 localGasUsed:string;localEffectiveGasPriceWei:string;sourceBlock:string;sourceHash:string;
 estimate:{gas:string;parentGas:string;baseFeeWei:string;parentBaseFeeWei:string;
  totalFeeWei:string;parentFeeWei:string;executionFeeWei:string;
  basis:'node_estimateGas_with_paper_prestate_and_parent_component'};
 stateOverrideHash:string;stateOverrides:Record<string,unknown>;
}
export interface RangeKeeperPaperGasProbeRequest {
 kind:GasReportKind;profile:MarketProfile;frame:PaperOpenFrame;candidate:RangeKeeperCandidate;
 candidateSource:PaperOpenFrame['source'];candidateReferenceProofHash:string;
 candidateHash:string;scope:RangeKeeperPaperCandidateScope;pathVersion:string;
 stages:readonly string[];openMarkId:string|null;openModelHash:string|null;
}
export type RangeKeeperPaperOwnedForkStageProbe=
 (request:RangeKeeperPaperGasProbeRequest)=>Promise<readonly RangeKeeperPaperGasStageSample[]>;

const sourceSchema=z.object({block:z.string().regex(raw),hash:z.string().regex(evmHash),
 timestamp:z.number().int().nonnegative()}).strict();
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:z.string().regex(raw),
  quotedOut:z.string().regex(raw),minOut:z.string().regex(raw),priceAfter:z.string().regex(raw),
  feeValue:z.string().regex(raw),shortfallValue:z.string().regex(raw)}).strict().nullable(),
 amount0Desired:z.string().regex(raw),amount1Desired:z.string().regex(raw),
 amount0Min:z.string().regex(raw),amount1Min:z.string().regex(raw),liquidity:z.string().regex(raw),
 deployedValue:z.string().regex(raw),sourceBlock:z.string().regex(raw),sourceHash:z.string().regex(evmHash),
 expiresAt:z.number().int().nonnegative()}).strict();
const scopeSchema=z.object({poolAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),profileHash:z.string().regex(hash64),
 candidateHash:z.string().regex(hash64),deployedValue:z.string().regex(raw),sharePpm:z.string().regex(raw),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swapKind:z.enum(['none','direct_pool_exact_input']),inventoryHash:z.string().regex(hash64).optional()}).strict();
const estimateSchema=z.object({gas:z.string().regex(/^[1-9][0-9]*$/),parentGas:z.string().regex(raw),
 baseFeeWei:z.string().regex(/^[1-9][0-9]*$/),parentBaseFeeWei:z.string().regex(raw),
 totalFeeWei:z.string().regex(/^[1-9][0-9]*$/),parentFeeWei:z.string().regex(raw),
 executionFeeWei:z.string().regex(raw),
 basis:z.literal('node_estimateGas_with_paper_prestate_and_parent_component')}).strict();
const gasProfileModelSchema=z.object({schemaVersion:z.literal(1),source:z.object({block:z.string().regex(raw),
 hash:z.string().regex(evmHash),estimatedAt:z.iso.datetime({offset:true}),callHash:z.string().regex(evmHash),
 method:z.literal('owned_fork_nitro_exact_call_v1')}).strict(),
 gasUnitsExpected:z.string().regex(raw),gasUnitsBound:z.string().regex(raw),
 poolAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),pathVersion:z.string().min(1),stage:z.string().min(1),
 allowanceState:z.enum([RANGEKEEPER_PAPER_ZERO_ALLOWANCES,RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES]),
 profileHash:z.string().regex(hash64),candidateHash:z.string().regex(hash64),inventoryHash:z.string().regex(hash64).optional(),
 deployedValue:z.string().regex(raw),sharePpm:z.string().regex(raw),
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swapKind:z.enum(['none','direct_pool_exact_input']),
 simulation:z.object({kind:z.literal('owned_fork_full_candidate_v1'),status:z.literal('success'),
  sourceBlock:z.string().regex(raw),sourceHash:z.string().regex(evmHash),candidateHash:z.string().regex(hash64),
  sequenceHash:z.string().regex(evmHash)}).strict()}).strict();
const stageEvidenceSchema=z.object({stage:z.string().min(1),allowanceState:z.string().min(1),
 sourceHash:z.string().regex(hash64),model:gasProfileModelSchema,
 evidence:z.object({to:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  calldata:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),returnData:z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  localHash:z.string().regex(evmHash),localGasUsed:z.string().regex(/^[1-9][0-9]*$/),
  localEffectiveGasPriceWei:z.string().regex(/^[1-9][0-9]*$/),estimate:estimateSchema,
  stateOverrideHash:z.string().regex(hash64),stateOverrides:z.record(z.string(),z.unknown())}).strict()}).strict();
const frameSchema=z.object({source:sourceSchema,tick:z.number().int(),sqrtPriceX96:z.string().regex(/^[1-9][0-9]*$/),
 poolLiquidity:z.string().regex(raw),price0:z.string().regex(/^[1-9][0-9]*$/),
 price1:z.string().regex(/^[1-9][0-9]*$/),nativePrice:z.string().regex(/^[1-9][0-9]*$/),
 referenceProofHash:z.string().regex(hash64),referenceProof:z.record(z.string(),z.unknown())}).strict();
const gasReportSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('rangekeeper_paper_gas_report_v1'),
 reportKind:z.enum(['open','retain_exit','convert_exit']),campaignId:z.uuid(),revision:z.number().int().positive(),
 configHash:z.string().regex(hash64),buildId:z.string().regex(hash64),profile:z.record(z.string(),z.unknown()),
 profileHash:z.string().regex(hash64),frame:frameSchema,candidateSource:sourceSchema,
 candidateReferenceProofHash:z.string().regex(hash64),candidate:candidateSchema,candidateHash:z.string().regex(hash64),
 openMarkId:z.string().regex(raw).nullable(),openModelHash:z.string().regex(hash64).nullable(),
 pathVersion:z.string().min(1),sizeBand:z.string().regex(/^rk_[0-9a-f]{32}$/),scope:scopeSchema,
 sequenceHash:z.string().regex(evmHash),marketGasPriceWei:z.string().regex(/^[1-9][0-9]*$/),
 sampledAt:z.iso.datetime({offset:true}),stageProfiles:z.array(stageEvidenceSchema).min(3).max(12),
 reportHash:z.string().regex(hash64)}).strict();

const serializeCandidate=(c:RangeKeeperCandidate)=>({kind:c.kind,range:c.range,
 swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),quotedOut:String(c.swap.quotedOut),
  minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),feeValue:String(c.swap.feeValue),
  shortfallValue:String(c.swap.shortfallValue)}:null,amount0Desired:String(c.amount0Desired),
 amount1Desired:String(c.amount1Desired),amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),
 liquidity:String(c.liquidity),deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),
 sourceHash:c.sourceHash,expiresAt:c.expiresAt});
function deserializeCandidate(c:z.infer<typeof candidateSchema>):RangeKeeperCandidate{
 return {kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),
  quotedOut:BigInt(c.swap.quotedOut),minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),
  feeValue:BigInt(c.swap.feeValue),shortfallValue:BigInt(c.swap.shortfallValue)}:null,
  amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
  amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
  deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt};
}
const expectedStages=(kind:GasReportKind,candidate:RangeKeeperCandidate):string[]=>kind==='open'?
 [...(candidate.swap?RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),
  ...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES]:kind==='retain_exit'?
 [...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES]:[...RANGEKEEPER_PAPER_CONVERT_EXIT_STAGES];
const expectedPath=(kind:GasReportKind,candidate:RangeKeeperCandidate)=>kind==='convert_exit'?
 RANGEKEEPER_PAPER_DIRECT_CONVERT_EXIT_PATH:rangeKeeperPaperPathVersion(candidate);
const allowance=(stage:string)=>stage.startsWith('open_')?
 RANGEKEEPER_PAPER_ZERO_ALLOWANCES:RANGEKEEPER_PAPER_POST_ENTRY_ALLOWANCES;
const rawValue=(amount:bigint,price:bigint,decimals:number)=>amount*price/10n**BigInt(decimals);

function serializedFrame(frame:PaperOpenFrame){
 assert(frame.referenceProof,'RangeKeeper paper gas frame has no reference proof');
 return {source:frame.source,tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
  poolLiquidity:String(frame.poolLiquidity),price0:String(frame.price0),price1:String(frame.price1),
  nativePrice:String(frame.nativePrice),referenceProofHash:frame.referenceProofHash,
  referenceProof:frame.referenceProof};
}

/** Runs a trusted owned-fork stage probe and builds source, path, candidate,
 * inventory and sequence-bound provisional calibration evidence. The probe
 * is an internal fork runner; request JSON must never supply its stage rows. */
export async function produceRangeKeeperPaperGasEvidence(input:{kind:GasReportKind;
 campaignId:string;revision:number;configHash:string;buildId:string;profile:MarketProfile;
 frame:PaperOpenFrame;candidateSource:PaperOpenFrame['source'];candidateReferenceProofHash:string;
 candidate:RangeKeeperCandidate;openMarkId:string|null;openModelHash:string|null;
 marketGasPriceWei:bigint;scope:RangeKeeperPaperCandidateScope;
 sampleOwnedFork:RangeKeeperPaperOwnedForkStageProbe;now?:number}){
 const profile=marketProfileSchema.parse(input.profile),frame=input.frame,p=profile.pool,
  now=input.now??Date.now(),path=expectedPath(input.kind,input.candidate),stages=expectedStages(input.kind,input.candidate);
 assert(input.marketGasPriceWei>0n&&/^[a-f0-9]{64}$/.test(input.configHash)&&
  /^[a-f0-9]{64}$/.test(input.buildId),'RangeKeeper paper gas policy or gas price unavailable');
 assert.equal(input.candidateReferenceProofHash.length,64);
 assert.equal(input.scope.poolAddress.toLowerCase(),p.pool.toLowerCase());
 assert.equal(input.scope.profileHash,contentHash(profile));
 assert(/^0x[0-9a-fA-F]{64}$/.test(frame.source.hash)&&/^(0|[1-9][0-9]*)$/.test(frame.source.block)&&
  Number.isSafeInteger(frame.source.timestamp)&&frame.source.timestamp>=0&&
  frame.referenceEligible&&frame.referenceProof&&referenceProofHash(frame.referenceProof)===frame.referenceProofHash&&
  frame.price0!==null&&frame.price0>0n&&frame.price1!==null&&frame.price1>0n&&
  frame.nativePrice!==null&&frame.nativePrice>0n&&frame.sqrtPriceX96>0n&&frame.poolLiquidity>=0n,
  'RangeKeeper gas source frame is unavailable');
 assert(/^[a-f0-9]{64}$/.test(input.candidateReferenceProofHash));
 assert.equal(input.scope.range.tickLower,input.candidate.range.tickLower);
 assert.equal(input.scope.range.tickUpper,input.candidate.range.tickUpper);
 assert.equal(input.scope.swapKind,input.candidate.swap?'direct_pool_exact_input':'none');
 assert.equal(input.scope.candidateHash,rangeKeeperPaperCandidateHash({campaignId:input.campaignId,
  revision:input.revision,profileHash:input.scope.profileHash,configHash:input.configHash,
  source:input.candidateSource,referenceProofHash:input.candidateReferenceProofHash,
  candidate:input.candidate}));
 if(input.kind==='open'){
  assert.equal(input.scope.inventoryHash,undefined,'Open profiles cannot carry later inventory identity');
  assert.equal(input.candidateSource.block,frame.source.block);
  assert(same(input.candidateSource.hash,frame.source.hash));
  assert.equal(input.scope.deployedValue,input.candidate.deployedValue);
  const denominator=frame.poolLiquidity+input.candidate.liquidity;
  assert(denominator>0n&&input.scope.sharePpm===input.candidate.liquidity*PPM/denominator,
   'Open gas scope diluted share differs from the canonical source');
 }else{
  assert(input.scope.inventoryHash&&hash64.test(input.scope.inventoryHash),
   'Terminal profiles require current inventory identity');
  assert(input.openMarkId&&raw.test(input.openMarkId)&&BigInt(input.openMarkId)>0n&&
   input.openModelHash&&hash64.test(input.openModelHash),'Terminal mark/open model identity unavailable');
  assert(BigInt(frame.source.block)>BigInt(input.candidateSource.block),
   'Terminal gas profile source must follow the open candidate source');
  const principal=principalAmounts({liquidity:input.candidate.liquidity,
   tickLower:input.candidate.range.tickLower,tickUpper:input.candidate.range.tickUpper,
   sqrtPriceX96:frame.sqrtPriceX96});
  const deployed=rawValue(principal.amount0,frame.price0!,p.decimals0)+
   rawValue(principal.amount1,frame.price1!,p.decimals1),denominator=frame.poolLiquidity+input.candidate.liquidity;
  assert(denominator>0n&&input.scope.deployedValue===deployed&&
   input.scope.sharePpm===input.candidate.liquidity*PPM/denominator,
   'Terminal gas scope differs from current canonical principal and share');
 }
 const sizeBand=rangeKeeperPaperSizeBand(path,input.scope),probeRequest:RangeKeeperPaperGasProbeRequest={
  kind:input.kind,profile,frame,candidate:input.candidate,candidateSource:input.candidateSource,
  candidateReferenceProofHash:input.candidateReferenceProofHash,candidateHash:input.scope.candidateHash,
  scope:input.scope,pathVersion:path,stages,openMarkId:input.openMarkId,openModelHash:input.openModelHash};
 const samples=await input.sampleOwnedFork(probeRequest);
 assert.equal(samples.length,stages.length,'Owned-fork stage sequence incomplete');
 for(let i=0;i<stages.length;i++)assert.equal(samples[i]!.action,stages[i],
  'Owned-fork stage sequence does not match the frozen path');
 const sampledAt=new Date(now).toISOString(),frameModel=serializedFrame(frame),candidate=serializeCandidate(input.candidate);
 const provisional=stages.map((stage,index)=>{
  const sample=samples[index]!;
  assert.equal(sample.sourceBlock,frame.source.block);
  assert(same(sample.sourceHash,frame.source.hash));
  assert(/^0x[0-9a-fA-F]{40}$/.test(sample.to),'Owned-fork stage target missing');
  const callHash=keccak256(sample.calldata as `0x${string}`),expected=BigInt(sample.estimate.gas),
   bound=(expected*13n+9n)/10n;
  assert(expected>0n&&BigInt(sample.estimate.parentGas)<=expected&&bound>=expected);
  const gasSource={block:frame.source.block,hash:frame.source.hash,estimatedAt:sampledAt,
   callHash,method:'owned_fork_nitro_exact_call_v1' as const};
  return {stage,allowanceState:allowance(stage),sourceHash:contentHash(gasSource),
   model:{schemaVersion:1 as const,source:gasSource,gasUnitsExpected:String(expected),
    gasUnitsBound:String(bound),poolAddress:p.pool,pathVersion:path,stage,
    allowanceState:allowance(stage),profileHash:input.scope.profileHash,
    candidateHash:input.scope.candidateHash,
    ...(input.scope.inventoryHash?{inventoryHash:input.scope.inventoryHash}:{}),
    deployedValue:String(input.scope.deployedValue),sharePpm:String(input.scope.sharePpm),
    range:input.scope.range,swapKind:input.scope.swapKind,
    simulation:{kind:'owned_fork_full_candidate_v1' as const,status:'success' as const,
     sourceBlock:frame.source.block,sourceHash:frame.source.hash,
     candidateHash:input.scope.candidateHash,sequenceHash:'pending'}},
   evidence:{to:sample.to,calldata:sample.calldata,returnData:sample.returnData,
    localHash:sample.localHash,localGasUsed:sample.localGasUsed,
    localEffectiveGasPriceWei:sample.localEffectiveGasPriceWei,estimate:sample.estimate,
    stateOverrideHash:sample.stateOverrideHash,stateOverrides:sample.stateOverrides}};
 });
 const sequenceHash=`0x${contentHash(provisional.map(row=>({stage:row.stage,
  allowanceState:row.allowanceState,callHash:row.model.source.callHash})))}`;
 for(const row of provisional)row.model.simulation.sequenceHash=sequenceHash;
 const reportBody={schemaVersion:1 as const,kind:'rangekeeper_paper_gas_report_v1' as const,
  reportKind:input.kind,campaignId:input.campaignId,revision:input.revision,
  configHash:input.configHash,buildId:input.buildId,profile,profileHash:input.scope.profileHash,
  frame:frameModel,candidateSource:input.candidateSource,
  candidateReferenceProofHash:input.candidateReferenceProofHash,candidate,candidateHash:input.scope.candidateHash,
  openMarkId:input.openMarkId,openModelHash:input.openModelHash,pathVersion:path,sizeBand,
  scope:{poolAddress:p.pool,profileHash:input.scope.profileHash,candidateHash:input.scope.candidateHash,
   deployedValue:String(input.scope.deployedValue),sharePpm:String(input.scope.sharePpm),
   range:input.scope.range,swapKind:input.scope.swapKind,
   ...(input.scope.inventoryHash?{inventoryHash:input.scope.inventoryHash}:{})},
  sequenceHash,marketGasPriceWei:String(input.marketGasPriceWei),sampledAt,stageProfiles:provisional};
 const report={...reportBody,reportHash:contentHash(reportBody)};
 return verifyRangeKeeperPaperGasReport(report);
}

/** Verifies a generated report and every stage row against the path, exact
 * source, candidate, inventory, call hash and common fork sequence. */
export function verifyRangeKeeperPaperGasReport(rawReport:unknown,now=Date.now()){
 const report=gasReportSchema.parse(rawReport),{reportHash,...body}=report;
 assert.equal(reportHash,contentHash(body),'RangeKeeper gas report hash mismatch');
 const profile=marketProfileSchema.parse(report.profile),candidate=deserializeCandidate(report.candidate),
  frame=report.frame,p=profile.pool;
 assert.equal(contentHash(profile),report.profileHash);
 assert.equal(report.scope.profileHash,report.profileHash);
 assert(same(report.scope.poolAddress,p.pool));
 assert.equal(referenceProofHash(frame.referenceProof),frame.referenceProofHash);
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:report.campaignId,revision:report.revision,
  profileHash:report.profileHash,configHash:report.configHash,source:report.candidateSource,
  referenceProofHash:report.candidateReferenceProofHash,candidate});
 assert.equal(candidateHash,report.candidateHash);
 assert.equal(report.scope.candidateHash,report.candidateHash);
 assert.equal(report.pathVersion,expectedPath(report.reportKind,candidate));
 assert.equal(report.sizeBand,rangeKeeperPaperSizeBand(report.pathVersion,{
  poolAddress:report.scope.poolAddress,profileHash:report.scope.profileHash,
  candidateHash:report.scope.candidateHash,deployedValue:BigInt(report.scope.deployedValue),
  sharePpm:BigInt(report.scope.sharePpm),range:report.scope.range,
  swapKind:report.scope.swapKind,...(report.scope.inventoryHash?{inventoryHash:report.scope.inventoryHash}:{})}));
 if(report.reportKind==='open')assert(report.openMarkId===null&&report.openModelHash===null&&
  !report.scope.inventoryHash&&report.candidateSource.block===frame.source.block&&
  same(report.candidateSource.hash,frame.source.hash),'Open report identity is inconsistent');
 else assert(report.openMarkId&&BigInt(report.openMarkId)>0n&&report.openModelHash&&report.scope.inventoryHash,
  'Terminal report identity is incomplete');
 const expectedShare=BigInt(candidate.liquidity)*PPM/
  (BigInt(frame.poolLiquidity)+BigInt(candidate.liquidity));
 assert(BigInt(frame.poolLiquidity)+BigInt(candidate.liquidity)>0n&&
  BigInt(report.scope.sharePpm)===expectedShare,'RangeKeeper gas share band differs from the source frame');
 if(report.reportKind==='open')assert(BigInt(report.scope.deployedValue)===candidate.deployedValue,
  'RangeKeeper open gas deployment size differs from candidate');
 else{
  const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,sqrtPriceX96:BigInt(frame.sqrtPriceX96)}),
   deployed=rawValue(principal.amount0,BigInt(frame.price0),p.decimals0)+
    rawValue(principal.amount1,BigInt(frame.price1),p.decimals1);
  assert(BigInt(report.scope.deployedValue)===deployed,
   'RangeKeeper terminal gas size band differs from current principal');
 }
 const expected=expectedStages(report.reportKind,candidate);
 assert.equal(report.stageProfiles.length,expected.length);
 const sequenceHash=`0x${contentHash(report.stageProfiles.map(stage=>({stage:stage.stage,
  allowanceState:stage.allowanceState,callHash:stage.model.source.callHash})))}`;
 assert.equal(report.sequenceHash,sequenceHash);
 const sampled=Date.parse(report.sampledAt),sourceMs=frame.source.timestamp*1000;
 assert(Number.isFinite(sampled)&&now>=sampled&&now-sampled<=86_400_000&&sampled>=sourceMs&&
  sampled-sourceMs<=180_000,'RangeKeeper gas evidence is stale or outside its canonical source window');
 for(let i=0;i<expected.length;i++){
  const row=report.stageProfiles[i]!,model=row.model,src=model.source,sim=model.simulation,evidence=row.evidence;
  assert.equal(row.stage,expected[i]);assert.equal(model.stage,row.stage);
  assert.equal(row.allowanceState,allowance(row.stage));assert.equal(model.allowanceState,row.allowanceState);
  assert.equal(model.pathVersion,report.pathVersion);assert.equal(model.poolAddress.toLowerCase(),p.pool.toLowerCase());
  assert.equal(model.profileHash,report.profileHash);assert.equal(model.candidateHash,report.candidateHash);
  assert.equal(model.inventoryHash,report.scope.inventoryHash);
  assert.equal(model.deployedValue,report.scope.deployedValue);assert.equal(model.sharePpm,report.scope.sharePpm);
  assert.deepEqual(model.range,report.scope.range);assert.equal(model.swapKind,report.scope.swapKind);
  assert.equal(src.block,frame.source.block);assert(same(String(src.hash),frame.source.hash));
  assert.equal(Date.parse(String(src.estimatedAt)),sampled);
  assert.equal(src.callHash,keccak256(evidence.calldata as `0x${string}`));
  assert.equal(row.sourceHash,contentHash(src));
  assert.equal(sim.kind,'owned_fork_full_candidate_v1');assert.equal(sim.status,'success');
  assert.equal(sim.sourceBlock,frame.source.block);assert(same(String(sim.sourceHash),frame.source.hash));
  assert.equal(sim.candidateHash,report.candidateHash);assert.equal(sim.sequenceHash,report.sequenceHash);
  assert.equal(evidence.to.length,42);assert(/^0x(?:[0-9a-fA-F]{2})+$/.test(evidence.calldata));
  assert(/^0x[0-9a-fA-F]{64}$/.test(evidence.localHash));
  assert.equal(evidence.stateOverrideHash,createHash('sha256').update(JSON.stringify(evidence.stateOverrides)).digest('hex'));
  const gas=BigInt(evidence.estimate.gas),parent=BigInt(evidence.estimate.parentGas),
   baseFee=BigInt(evidence.estimate.baseFeeWei);
  assert(parent<=gas&&BigInt(evidence.estimate.totalFeeWei)===gas*baseFee&&
   BigInt(evidence.estimate.parentFeeWei)===parent*baseFee&&
   BigInt(evidence.estimate.executionFeeWei)===(gas-parent)*baseFee);
  assert(BigInt(model.gasUnitsExpected)>0n&&BigInt(model.gasUnitsBound)>=BigInt(model.gasUnitsExpected));
 }
 return report;
}

export interface RangeKeeperPaperGasSourceAttestation {
 verificationClass:'rangekeeper_paper_candidate_replay_v1';reportHash:string;
 sourceHash:string;profileHash:string;candidateHash:string;replayHash:string;verifiedAt:string;
}
export type RangeKeeperPaperGasSourceReplayVerifier=(input:{report:ReturnType<typeof verifyRangeKeeperPaperGasReport>;
 frame:PaperOpenFrame})=>Promise<{replayHash:string}>;

/** Rechecks chain, pool, reference and report source, then delegates the
 * campaign/candidate/path replay to a trusted persisted-context callback. */
export async function verifyRangeKeeperPaperGasEvidenceSource(input:{client:RobinhoodClient;report:unknown;
 replayPersistedContext:RangeKeeperPaperGasSourceReplayVerifier;now?:number}){
 const report=verifyRangeKeeperPaperGasReport(input.report,input.now),profile=marketProfileSchema.parse(report.profile),
  source=report.frame.source,blockNumber=BigInt(source.block),p=profile.pool;
 assert.equal(await input.client.getChainId(),ROBINHOOD_CHAIN_ID);
 const latest=await input.client.getBlock();assert(latest.number>=blockNumber+64n,
  'RangeKeeper gas source is not confirmed');
 const candidateBlockNumber=BigInt(report.candidateSource.block),candidateBlock=await input.client.getBlock({
  blockNumber:candidateBlockNumber});
 assert(latest.number>=candidateBlockNumber+64n&&same(candidateBlock.hash,report.candidateSource.hash)&&
  Number(candidateBlock.timestamp)===report.candidateSource.timestamp,
  'RangeKeeper gas candidate source anchor changed');
 const block=await input.client.getBlock({blockNumber});
 assert(same(block.hash,source.hash)&&Number(block.timestamp)===source.timestamp,
  'RangeKeeper gas source anchor changed');
 const chainSource={block:blockNumber,hash:block.hash,timestamp:source.timestamp};
 await new RangeKeeperChain(input.client,p).verify(chainSource);
 const [slot,liquidity,references]=await Promise.all([
  input.client.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0',blockNumber}),
  input.client.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity',blockNumber}),
  readRangeKeeperReferences(input.client,chainSource,profile),
 ]);
 assert(references.eligible&&references.price0&&references.price1&&references.nativePrice,
  'RangeKeeper gas independent references unavailable');
 const proof=JSON.parse(JSON.stringify(references.proof,(_,value)=>
  typeof value==='bigint'?String(value):value)) as Record<string,unknown>,frame=report.frame;
 assert.equal(slot[1],frame.tick);assert.equal(String(slot[0]),frame.sqrtPriceX96);
 assert.equal(String(liquidity),frame.poolLiquidity);assert.equal(String(references.price0),frame.price0);
 assert.equal(String(references.price1),frame.price1);assert.equal(String(references.nativePrice),frame.nativePrice);
 assert.equal(referenceProofHash(frame.referenceProof),frame.referenceProofHash);
 for(const key of ['token0','token1','native'] as const)
  assert.equal(referenceProofHash(frame.referenceProof[key]),referenceProofHash(proof[key]),
   `RangeKeeper gas ${key} reference proof changed`);
 const frameValue:PaperOpenFrame={source:frame.source,tick:slot[1],sqrtPriceX96:slot[0],poolLiquidity:liquidity,
  price0:references.price0,price1:references.price1,nativePrice:references.nativePrice,
  referenceEligible:references.eligible,referenceReasons:references.reasons,
  referenceProofHash:frame.referenceProofHash,referenceProof:frame.referenceProof};
 const replay=await input.replayPersistedContext({report,frame:frameValue});
 assert(hash64.test(replay.replayHash),'RangeKeeper persisted candidate replay hash invalid');
 const [final,finalCandidate]=await Promise.all([
  input.client.getBlock({blockNumber}),
  input.client.getBlock({blockNumber:candidateBlockNumber}),
 ]);
 assert(same(final.hash,source.hash),'RangeKeeper gas source reorged during verification');
 assert(same(finalCandidate.hash,report.candidateSource.hash),
  'RangeKeeper gas candidate source reorged during verification');
 const verifiedAt=new Date().toISOString();
 return {verificationClass:'rangekeeper_paper_candidate_replay_v1' as const,
  reportHash:report.reportHash,sourceHash:source.hash,profileHash:report.profileHash,
  candidateHash:report.candidateHash,replayHash:replay.replayHash,verifiedAt} satisfies RangeKeeperPaperGasSourceAttestation;
}

export interface RangeKeeperPaperGasProfileInsert {
 version:number;poolAddress:string;pathVersion:string;stage:string;allowanceState:string;sizeBand:string;
 component:'gas_units';status:'provisional';evidenceClass:'fork_estimated';model:unknown;
 validation:Record<string,unknown>;sourceHash:string;observedUntil:Date;
}
export function rangeKeeperPaperGasProfileInserts(rawReport:unknown,
 attestation:RangeKeeperPaperGasSourceAttestation,version:number,now=Date.now()):RangeKeeperPaperGasProfileInsert[]{
 const report=verifyRangeKeeperPaperGasReport(rawReport,now);
 assert(Number.isSafeInteger(version)&&version>0,'RangeKeeper calibration version invalid');
 const verifiedAt=Date.parse(attestation.verifiedAt);
 assert(attestation.verificationClass==='rangekeeper_paper_candidate_replay_v1'&&
  Number.isFinite(verifiedAt)&&verifiedAt<=now&&now-verifiedAt<=300_000&&
  attestation.reportHash===report.reportHash&&attestation.sourceHash.toLowerCase()===
  report.frame.source.hash.toLowerCase()&&attestation.profileHash===report.profileHash&&
  attestation.candidateHash===report.candidateHash&&hash64.test(attestation.replayHash),
  'RangeKeeper gas source attestation does not match report');
 return report.stageProfiles.map(stage=>({version,poolAddress:report.scope.poolAddress.toLowerCase(),
  pathVersion:report.pathVersion,stage:stage.stage,allowanceState:stage.allowanceState,
  sizeBand:report.sizeBand,component:'gas_units',status:'provisional',evidenceClass:'fork_estimated',
  model:stage.model,validation:{validationPolicy:'rangekeeper_paper_candidate_replay_v1',
   statusReason:'single_owned_fork_candidate_sequence',sampleCount:1,distinctCampaigns:0,
   reportHash:report.reportHash,sourceAttestation:attestation,localEvidence:stage.evidence},
  sourceHash:stage.sourceHash,observedUntil:new Date(report.sampledAt)}));
}

/** Persists profiles only after canonical source verification and trusted
 * persisted candidate replay. `writeProfiles` must be append-only and insert
 * the complete common-version sequence in one transaction. */
export async function verifyAndPersistRangeKeeperPaperGasEvidence(input:{client:RobinhoodClient;
 report:unknown;replayPersistedContext:RangeKeeperPaperGasSourceReplayVerifier;
 writeProfiles:(input:{report:ReturnType<typeof verifyRangeKeeperPaperGasReport>;
  attestation:RangeKeeperPaperGasSourceAttestation;profiles:RangeKeeperPaperGasProfileInsert[]})=>Promise<unknown>;
 version:number;now?:number}){
 const report=verifyRangeKeeperPaperGasReport(input.report,input.now);
 const attestation=await verifyRangeKeeperPaperGasEvidenceSource({...input,report});
 const profiles=rangeKeeperPaperGasProfileInserts(report,attestation,input.version,input.now);
 return input.writeProfiles({report,attestation,profiles});
}
