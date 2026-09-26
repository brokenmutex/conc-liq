import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256,stringToHex} from 'viem';
import {z} from 'zod';
import type {RangeKeeperLimits,RangeKeeperCandidate} from '../strategy/rangekeeper/domain.js';
import {referenceProofHash,type MarketProfile} from './market-profile.js';
import {contentHash} from './contracts.js';
import {rangeKeeperPaperCandidateHash,RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP,
 RANGEKEEPER_PAPER_OPEN_STAGES_SWAP,RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES}
 from './rangekeeper-paper-cost.js';
import {sampleRangeKeeperPaperGasStages} from './rangekeeper-paper-gas-sampler.js';
import type {RangeKeeperPaperGasProbeRequest,RangeKeeperPaperGasStageSample}
 from './rangekeeper-paper-gas-evidence.js';
import type {RangeKeeperPaperConfirmationProbe,RangeKeeperPaperConfirmationSimulation}
 from './rangekeeper-paper-confirmation.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {ForkReadDiagnostics,ForkReadHint} from '../paper/fork.js';
import {openPaperFork,type PaperFork} from '../paper/fork.js';

export interface RangeKeeperPaperOwnedForkConfirmationEvidence {
 schemaVersion:1;kind:'rangekeeper_paper_owned_fork_confirmation_simulation_v1';
 status:'success';evidenceClass:'caller_claimed_owned_anvil_fork';source:PaperOpenFrame['source'];
 referenceProofHash:string;campaignId:string;revision:number;configHash:string;profileHash:string;candidateHash:string;
 candidate:Record<string,unknown>;sequenceHash:`0x${string}`;
 stages:readonly {stage:string;localTransactionHash:string;to:string;calldata:string;returnData:string;
  gasUsed:string;effectiveGasPriceWei:string;estimate:RangeKeeperPaperGasStageSample['estimate'];
  stateOverrideHash:string;stateOverrides:Record<string,unknown>}[];
 admissionAvailable:false;openingBooked:false;
}
export type RangeKeeperPaperConfirmationCandidateBinding=Pick<RangeKeeperPaperConfirmationProbe,
 'status'|'campaignId'|'revision'|'source'|'candidate'|'candidateHash'|'scope'|'pathVersion'|'sizeBand'|'actionAvailable'>;
export interface RangeKeeperPaperSimulationCapabilityContext {
 probe:RangeKeeperPaperConfirmationCandidateBinding;profile:MarketProfile;frame:PaperOpenFrame;
 configHash:string;allocation:{token0Raw:string;token1Raw:string;nativeWei:string};limits:RangeKeeperLimits;
}
const trustedSimulationCapabilities=new WeakMap<object,{bindingHash:string;evidenceHash:string;consumed:boolean}>();
const preparedForkCapabilities=new WeakMap<object,{fork:PaperFork;bindingHash:string;
 beforeRead:()=>Promise<void>;onReadHints:((hints:readonly ForkReadHint[])=>void)|undefined}>();
function canonicalHash(value:unknown){return contentHash(JSON.parse(JSON.stringify(value,(_key,item)=>
 typeof item==='bigint'?String(item):item)));}
export function rangeKeeperPaperPreparedForkBindingHash(input:{profile:MarketProfile;frame:PaperOpenFrame;configHash:string;
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};limits:RangeKeeperLimits;rpcUrl:string;
 maxRequests:number;timeoutMs:number;prefetchHints:readonly ForkReadHint[]}){
 return canonicalHash({profileHash:contentHash(input.profile),source:input.frame.source,configHash:input.configHash,
  frame:{referenceEligible:input.frame.referenceEligible,referenceReasons:input.frame.referenceReasons,
   referenceProofHash:input.frame.referenceProofHash,
   referenceProof:input.frame.referenceProof?contentHash(input.frame.referenceProof):null,
   tick:input.frame.tick,sqrtPriceX96:String(input.frame.sqrtPriceX96),
   poolLiquidity:String(input.frame.poolLiquidity),price0:input.frame.price0===null?null:String(input.frame.price0),
   price1:input.frame.price1===null?null:String(input.frame.price1),
   nativePrice:input.frame.nativePrice===null?null:String(input.frame.nativePrice)},
  allocation:input.allocation,limits:input.limits,rpcUrlHash:createHash('sha256').update(input.rpcUrl).digest('hex'),
  maxRequests:input.maxRequests,timeoutMs:input.timeoutMs,deterministicClock:true,
  prefetchHints:input.prefetchHints});
}

export interface RangeKeeperPaperPreparedForkCapability {readonly kind:'rangekeeper_prepared_owned_fork_v1'}

/** Opens a fresh, source-pinned local fork before candidate planning so its
 * bounded upstream prefetch/startup can overlap read-only planning. The opaque
 * handle contains no RPC client and cannot be serialized or caller-forged. */
export async function prepareRangeKeeperPaperConfirmationFork(input:{profile:MarketProfile;
 frame:PaperOpenFrame;configHash:string;allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 limits:RangeKeeperLimits;rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
 prefetchHints?:readonly ForkReadHint[];onReadHints?:(hints:readonly ForkReadHint[])=>void
}):Promise<RangeKeeperPaperPreparedForkCapability>{
 assert(input.profile.pool.chainId===4663&&/^[a-f0-9]{64}$/.test(input.configHash)&&
  input.rpcUrl.length>0,'RangeKeeper prepared fork context invalid');
 assert(input.frame.referenceEligible&&input.frame.referenceProof&&
  referenceProofHash(input.frame.referenceProof)===input.frame.referenceProofHash,
  'RangeKeeper prepared fork reference proof invalid');
 const maxRequests=input.maxRequests??1600,timeoutMs=input.timeoutMs??180_000,
  prefetchHints=structuredClone(input.prefetchHints??[]),source={number:BigInt(input.frame.source.block),
   hash:input.frame.source.hash as `0x${string}`,timestamp:BigInt(input.frame.source.timestamp)},
  bindingHash=rangeKeeperPaperPreparedForkBindingHash({...input,maxRequests,timeoutMs,prefetchHints});
 assert(Number.isSafeInteger(maxRequests)&&maxRequests>0&&maxRequests<=2000&&
  Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300_000,
  'RangeKeeper prepared fork budget invalid');
 const fork=await openPaperFork({source,
  rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,maxRequests,timeoutMs,deterministicClock:true,
  prefetchHints,onReadHints:input.onReadHints});
 const handle=Object.freeze({kind:'rangekeeper_prepared_owned_fork_v1' as const});
 preparedForkCapabilities.set(handle,{fork,bindingHash,
  beforeRead:input.beforeRead,onReadHints:input.onReadHints});
 return handle;
}

/** Closes an unused prepared fork after a planning failure or expiry. */
export async function discardRangeKeeperPaperConfirmationFork(handle:RangeKeeperPaperPreparedForkCapability){
 const entry=preparedForkCapabilities.get(handle as object);
 if(!entry)return;
 preparedForkCapabilities.delete(handle as object);
 await entry.fork.close();
}

async function consumePreparedFork(handle:RangeKeeperPaperPreparedForkCapability|undefined,input:{
 profile:MarketProfile;frame:PaperOpenFrame;configHash:string;
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};limits:RangeKeeperLimits;
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests:number;timeoutMs:number;
 prefetchHints:readonly ForkReadHint[];onReadHints:((hints:readonly ForkReadHint[])=>void)|undefined
}):Promise<PaperFork|undefined>{
 if(!handle)return undefined;
 const entry=preparedForkCapabilities.get(handle as object);
 if(!entry)throw Error('RangeKeeper prepared fork capability unavailable');
 if(entry.beforeRead!==input.beforeRead||entry.onReadHints!==input.onReadHints||
  entry.bindingHash!==rangeKeeperPaperPreparedForkBindingHash({...input,prefetchHints:input.prefetchHints})){
  preparedForkCapabilities.delete(handle as object);
  await entry.fork.close();
  throw Error('RangeKeeper prepared fork context changed');
 }
 preparedForkCapabilities.delete(handle as object);
 return entry.fork;
}
function capabilityBindingHash(context:RangeKeeperPaperSimulationCapabilityContext){
 const {probe,profile,frame,configHash,allocation,limits}=context;
 assert(frame.referenceEligible&&frame.referenceProof&&
  referenceProofHash(frame.referenceProof)===frame.referenceProofHash,
  'Simulation capability frame reference proof is invalid');
 return canonicalHash({campaignId:probe.campaignId,revision:probe.revision,configHash,
  profileHash:contentHash(profile),allocation,limits,source:frame.source,
  frame:{referenceEligible:frame.referenceEligible,referenceReasons:frame.referenceReasons,
   referenceProofHash:frame.referenceProofHash,tick:frame.tick,sqrtPriceX96:String(frame.sqrtPriceX96),
   poolLiquidity:String(frame.poolLiquidity),price0:frame.price0===null?null:String(frame.price0),
   price1:frame.price1===null?null:String(frame.price1),nativePrice:frame.nativePrice===null?null:String(frame.nativePrice)},
  candidateHash:probe.candidateHash,candidate:serializeCandidate(probe.candidate),scope:probe.scope,
  pathVersion:probe.pathVersion,sizeBand:probe.sizeBand});
}
function freezeDeep<T>(value:T):T{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.freeze(value);for(const child of Object.values(value as Record<string,unknown>))freezeDeep(child);
 }
 return value;
}

/** Consumes an in-process capability issued only by the owned-fork runner.
 * It cannot be reconstructed from serialized evidence and is one-shot. */
export function consumeTrustedRangeKeeperSimulation(input:{simulation:RangeKeeperPaperConfirmationSimulation&{
 ownedForkEvidence:RangeKeeperPaperOwnedForkConfirmationEvidence};context:RangeKeeperPaperSimulationCapabilityContext;
 now?:number}):RangeKeeperPaperConfirmationSimulation&{
 ownedForkEvidence:RangeKeeperPaperOwnedForkConfirmationEvidence}|null{
 const {simulation,context}=input,record=trustedSimulationCapabilities.get(simulation as object),now=input.now??Date.now();
 let validProof=false;
 try{validProof=!!context.frame.referenceEligible&&!!context.frame.referenceProof&&
  referenceProofHash(context.frame.referenceProof)===context.frame.referenceProofHash;}catch{return null;}
 if(!record||record.consumed||!validProof||
  now>=context.probe.candidate.expiresAt*1000||
  now<context.frame.source.timestamp*1000||now-context.frame.source.timestamp*1000>180_000||
  record.bindingHash!==capabilityBindingHash(context))return null;
 let evidenceHash:string;
 try{evidenceHash=contentHash(simulation.ownedForkEvidence);}catch{return null;}
 if(evidenceHash!==record.evidenceHash||simulation.status!=='success'||
  simulation.simulationHash!==simulation.ownedForkEvidence.sequenceHash||
  simulation.sourceBlock!==context.frame.source.block||
  simulation.sourceHash.toLowerCase()!==context.frame.source.hash.toLowerCase()||
  simulation.candidateHash!==context.probe.candidateHash)return null;
 record.consumed=true;
 return simulation;
}
const evmHash=z.string().regex(/^0x[0-9a-fA-F]{64}$/),hash64=z.string().regex(/^[a-f0-9]{64}$/),
 raw=z.string().regex(/^(0|[1-9][0-9]*)$/),
 candidateSchema=z.object({kind:z.enum(['entry','recenter']),range:z.object({tickLower:z.number().int(),
 tickUpper:z.number().int()}).strict(),swap:z.object({token:z.union([z.literal(0),z.literal(1)]),
 amountIn:raw,quotedOut:raw,minOut:raw,priceAfter:raw,feeValue:raw,shortfallValue:raw}).strict().nullable(),
 amount0Desired:raw,amount1Desired:raw,amount0Min:raw,amount1Min:raw,liquidity:raw,
 deployedValue:raw,sourceBlock:raw,sourceHash:evmHash,expiresAt:z.number().int().nonnegative()}).strict(),
 stageSchema=z.object({stage:z.string().min(1),localTransactionHash:evmHash,to:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
 calldata:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),returnData:z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
 gasUsed:z.string().regex(/^[1-9][0-9]*$/),effectiveGasPriceWei:z.string().regex(/^[1-9][0-9]*$/),
 estimate:z.object({gas:raw,parentGas:raw,baseFeeWei:raw,parentBaseFeeWei:raw,totalFeeWei:raw,
 parentFeeWei:raw,executionFeeWei:raw,basis:z.literal('node_estimateGas_with_paper_prestate_and_parent_component')}).strict(),
 stateOverrideHash:hash64,stateOverrides:z.record(z.string(),z.unknown())}).strict(),
 evidenceSchema=z.object({schemaVersion:z.literal(1),
 kind:z.literal('rangekeeper_paper_owned_fork_confirmation_simulation_v1'),status:z.literal('success'),
 evidenceClass:z.literal('caller_claimed_owned_anvil_fork'),source:z.object({block:raw,hash:evmHash,
 timestamp:z.number().int().nonnegative()}).strict(),referenceProofHash:hash64,campaignId:z.uuid(),
 revision:z.number().int().positive(),configHash:hash64,profileHash:hash64,candidateHash:hash64,
 candidate:candidateSchema,sequenceHash:evmHash,stages:z.array(stageSchema).min(8).max(10),
 admissionAvailable:z.literal(false),openingBooked:z.literal(false)}).strict();

export function verifyRangeKeeperPaperOwnedForkConfirmationEvidence(value:unknown,expected:{
 campaignId:string;revision:number;configHash:string;profileHash:string;source:PaperOpenFrame['source'];
 referenceProofHash:string;candidate:RangeKeeperCandidate;candidateHash:string;simulationHash:string;
}):RangeKeeperPaperOwnedForkConfirmationEvidence{
 const evidence=evidenceSchema.parse(value),{sequenceHash,...body}=evidence;
 const candidate=serializeCandidate(expected.candidate),stages=[...(expected.candidate.swap?
  RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
 assert.equal(evidence.campaignId,expected.campaignId);assert.equal(evidence.revision,expected.revision);
 assert.equal(evidence.configHash,expected.configHash);assert.equal(evidence.profileHash,expected.profileHash);
 assert.equal(evidence.source.block,expected.source.block);
 assert.equal(evidence.source.hash.toLowerCase(),expected.source.hash.toLowerCase());
 assert.equal(evidence.source.timestamp,expected.source.timestamp);
 assert.equal(evidence.referenceProofHash,expected.referenceProofHash);
 assert.equal(evidence.candidateHash,expected.candidateHash);
 assert.equal(contentHash(evidence.candidate),contentHash(candidate));
 assert.deepEqual(evidence.stages.map(row=>row.stage),stages);
 assert.equal(sequenceHash,expected.simulationHash);
 assert.equal(sequenceHash,keccak256(stringToHex(contentHash(body))));
 return evidence as unknown as RangeKeeperPaperOwnedForkConfirmationEvidence;
}

function serializeCandidate(candidate:RangeKeeperCandidate){
 return {kind:candidate.kind,range:candidate.range,swap:candidate.swap?{token:candidate.swap.token,
  amountIn:String(candidate.swap.amountIn),quotedOut:String(candidate.swap.quotedOut),
  minOut:String(candidate.swap.minOut),priceAfter:String(candidate.swap.priceAfter),
  feeValue:String(candidate.swap.feeValue),shortfallValue:String(candidate.swap.shortfallValue)}:null,
  amount0Desired:String(candidate.amount0Desired),amount1Desired:String(candidate.amount1Desired),
  amount0Min:String(candidate.amount0Min),amount1Min:String(candidate.amount1Min),
  liquidity:String(candidate.liquidity),deployedValue:String(candidate.deployedValue),
  sourceBlock:String(candidate.sourceBlock),sourceHash:candidate.sourceHash,expiresAt:candidate.expiresAt};
}

/** Validates and hashes only the fixed entry+retain sequence returned by the
 * owned Anvil runner. This is simulation evidence, not a receipt or booking. */
export function buildRangeKeeperPaperOwnedForkConfirmationEvidence(input:{
 probe:RangeKeeperPaperConfirmationCandidateBinding;frame:PaperOpenFrame;configHash:string;
 samples:readonly RangeKeeperPaperGasStageSample[];
}):RangeKeeperPaperOwnedForkConfirmationEvidence{
 const {probe,frame,samples}=input;
 assert.equal(probe.status,'candidate');
 assert.equal(probe.actionAvailable,false);
 assert.equal(probe.source.block,frame.source.block);
 assert.equal(probe.source.hash.toLowerCase(),frame.source.hash.toLowerCase());
 assert.equal(probe.candidate.sourceBlock,BigInt(frame.source.block));
 assert.equal(probe.candidate.sourceHash.toLowerCase(),frame.source.hash.toLowerCase());
 assert.equal(probe.candidateHash,probe.scope.candidateHash);
 assert(/^[a-f0-9]{64}$/.test(input.configHash));
 assert(frame.referenceEligible&&frame.referenceProof&&frame.price0!==null&&frame.price1!==null&&
  frame.nativePrice!==null&&referenceProofHash(frame.referenceProof)===frame.referenceProofHash,
  'Pinned fork simulation frame is missing independent references');
 const stages=[...(probe.candidate.swap?RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:
  RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
 assert.equal(samples.length,stages.length,'Owned-fork simulation stage count differs from the frozen path');
 assert.equal(rangeKeeperPaperCandidateHash({campaignId:probe.campaignId,revision:probe.revision,
  profileHash:probe.scope.profileHash,configHash:input.configHash,source:frame.source,
  referenceProofHash:frame.referenceProofHash,candidate:probe.candidate}),probe.candidateHash,
  'Candidate hash does not commit to the simulation source and campaign context');
 const stageEvidence=samples.map((sample,index)=>{
  assert.equal(sample.action,stages[index],'Owned-fork simulation stage order differs from the frozen path');
  assert.equal(sample.sourceBlock,frame.source.block);
  assert.equal(sample.sourceHash.toLowerCase(),frame.source.hash.toLowerCase());
  assert(/^0x[0-9a-fA-F]{64}$/.test(sample.localHash));
  assert(/^0x[0-9a-fA-F]{40}$/.test(sample.to));
  assert(/^0x(?:[0-9a-fA-F]{2})+$/.test(sample.calldata));
  assert(BigInt(sample.localGasUsed)>0n&&BigInt(sample.estimate.gas)>0n);
  assert(/^[a-f0-9]{64}$/.test(sample.stateOverrideHash));
  return {stage:sample.action,localTransactionHash:sample.localHash,to:sample.to,
   calldata:sample.calldata.toLowerCase(),returnData:sample.returnData.toLowerCase(),
   gasUsed:sample.localGasUsed,effectiveGasPriceWei:sample.localEffectiveGasPriceWei,
   estimate:sample.estimate,stateOverrideHash:sample.stateOverrideHash,stateOverrides:sample.stateOverrides};
 });
 const body={schemaVersion:1 as const,kind:'rangekeeper_paper_owned_fork_confirmation_simulation_v1' as const,
  status:'success' as const,evidenceClass:'caller_claimed_owned_anvil_fork' as const,source:frame.source,
  referenceProofHash:frame.referenceProofHash,campaignId:probe.campaignId,revision:probe.revision,
  configHash:input.configHash,profileHash:probe.scope.profileHash,
  candidateHash:probe.candidateHash,candidate:serializeCandidate(probe.candidate),
  stages:stageEvidence,admissionAvailable:false as const,
  openingBooked:false as const};
 return {...body,sequenceHash:keccak256(stringToHex(contentHash(body))) as `0x${string}`};
}

/** Runs the confirmed second-observation candidate through a fresh owned fork.
 * Upstream RPC access is pinned read-only; local Anvil is the only place where
 * fixture funding and simulated transactions occur. */
export async function simulateRangeKeeperPaperConfirmationOnOwnedFork(input:{
 probe:RangeKeeperPaperConfirmationCandidateBinding;profile:MarketProfile;frame:PaperOpenFrame;
 configHash:string;initialBalances:readonly [bigint,bigint];limits:RangeKeeperLimits;
 allocation:{token0Raw:string;token1Raw:string;nativeWei:string};
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
 onReadDiagnostics?:(diagnostics:ForkReadDiagnostics)=>void;
 prefetchHints?:readonly ForkReadHint[];onReadHints?:(hints:readonly ForkReadHint[])=>void;
 preparedFork?:RangeKeeperPaperPreparedForkCapability;
}):Promise<RangeKeeperPaperConfirmationSimulation&{
 ownedForkEvidence:RangeKeeperPaperOwnedForkConfirmationEvidence}>{
 const {probe,profile,frame}=input;
 assert(/^[a-f0-9]{64}$/.test(input.configHash));
 assert.equal(input.allocation.token0Raw,String(input.initialBalances[0]));
 assert.equal(input.allocation.token1Raw,String(input.initialBalances[1]));
 assert.equal(probe.scope.profileHash,contentHash(profile));
 assert.equal(probe.scope.poolAddress.toLowerCase(),profile.pool.pool.toLowerCase());
 assert.equal(probe.source.block,frame.source.block);
 assert.equal(probe.source.hash.toLowerCase(),frame.source.hash.toLowerCase());
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:probe.campaignId,
  revision:probe.revision,profileHash:probe.scope.profileHash,configHash:input.configHash,
  source:frame.source,referenceProofHash:frame.referenceProofHash,candidate:probe.candidate});
 assert.equal(candidateHash,probe.candidateHash,'Confirmation candidate identity changed before fork simulation');
 const stages=[...(probe.candidate.swap?RANGEKEEPER_PAPER_OPEN_STAGES_SWAP:
  RANGEKEEPER_PAPER_OPEN_STAGES_NO_SWAP),...RANGEKEEPER_PAPER_RETAIN_EXIT_STAGES];
 const preparedFork=await consumePreparedFork(input.preparedFork,{profile,frame,configHash:input.configHash,
  allocation:input.allocation,limits:input.limits,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??180_000,
  prefetchHints:input.prefetchHints??[],onReadHints:input.onReadHints});
 const request:RangeKeeperPaperGasProbeRequest={kind:'open',profile,frame,candidate:probe.candidate,
  candidateSource:probe.source,candidateReferenceProofHash:frame.referenceProofHash,
  candidateHash,scope:probe.scope,pathVersion:probe.pathVersion,stages,openMarkId:null,openModelHash:null};
 const samples=await sampleRangeKeeperPaperGasStages(request,{rpcUrl:input.rpcUrl,
  beforeRead:input.beforeRead,maxRequests:input.maxRequests,timeoutMs:input.timeoutMs,
  onReadDiagnostics:input.onReadDiagnostics,prefetchHints:input.prefetchHints,onReadHints:input.onReadHints,
  limits:input.limits,initialBalances:input.initialBalances,preparedFork});
 const evidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,
  configHash:input.configHash,samples});
 const result={status:'success' as const,sourceBlock:frame.source.block,sourceHash:frame.source.hash,
  candidateHash,simulationHash:evidence.sequenceHash,ownedForkEvidence:evidence};
 freezeDeep(result);
 trustedSimulationCapabilities.set(result,{bindingHash:capabilityBindingHash(input),
  evidenceHash:contentHash(evidence),consumed:false});
 return result;
}
