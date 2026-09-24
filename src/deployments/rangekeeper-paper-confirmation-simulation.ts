import assert from 'node:assert/strict';
import {keccak256,stringToHex} from 'viem';
import type {RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import type {MarketProfile} from './market-profile.js';
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

export interface RangeKeeperPaperOwnedForkConfirmationEvidence {
 schemaVersion:1;kind:'rangekeeper_paper_owned_fork_confirmation_simulation_v1';
 status:'success';evidenceClass:'local_owned_anvil_fork';source:PaperOpenFrame['source'];
 referenceProofHash:string;campaignId:string;revision:number;configHash:string;profileHash:string;candidateHash:string;
 candidate:Record<string,unknown>;sequenceHash:`0x${string}`;
 stages:readonly {stage:string;localTransactionHash:string;to:string;calldata:string;returnData:string;
  gasUsed:string;effectiveGasPriceWei:string;estimate:RangeKeeperPaperGasStageSample['estimate'];
  stateOverrideHash:string;stateOverrides:Record<string,unknown>}[];
 admissionAvailable:false;openingBooked:false;
}

/** Validates and hashes only the fixed entry+retain sequence returned by the
 * owned Anvil runner. This is simulation evidence, not a receipt or booking. */
export function buildRangeKeeperPaperOwnedForkConfirmationEvidence(input:{
 probe:RangeKeeperPaperConfirmationProbe;frame:PaperOpenFrame;configHash:string;
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
  frame.nativePrice!==null,'Pinned fork simulation frame is missing independent references');
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
  status:'success' as const,evidenceClass:'local_owned_anvil_fork' as const,source:frame.source,
  referenceProofHash:frame.referenceProofHash,campaignId:probe.campaignId,revision:probe.revision,
  configHash:input.configHash,profileHash:probe.scope.profileHash,
  candidateHash:probe.candidateHash,candidate:{kind:probe.candidate.kind,range:probe.candidate.range,
   swap:probe.candidate.swap?{token:probe.candidate.swap.token,
    amountIn:String(probe.candidate.swap.amountIn),quotedOut:String(probe.candidate.swap.quotedOut),
    minOut:String(probe.candidate.swap.minOut)}:null,
   amount0Desired:String(probe.candidate.amount0Desired),amount1Desired:String(probe.candidate.amount1Desired),
   amount0Min:String(probe.candidate.amount0Min),amount1Min:String(probe.candidate.amount1Min),
   liquidity:String(probe.candidate.liquidity)},stages:stageEvidence,admissionAvailable:false as const,
  openingBooked:false as const};
 return {...body,sequenceHash:keccak256(stringToHex(contentHash(body)))};
}

/** Runs the confirmed second-observation candidate through a fresh owned fork.
 * Upstream RPC access is pinned read-only; local Anvil is the only place where
 * fixture funding and simulated transactions occur. */
export async function simulateRangeKeeperPaperConfirmationOnOwnedFork(input:{
 probe:RangeKeeperPaperConfirmationProbe;profile:MarketProfile;frame:PaperOpenFrame;
 configHash:string;initialBalances:readonly [bigint,bigint];limits:RangeKeeperLimits;
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;
}):Promise<{simulation:RangeKeeperPaperConfirmationSimulation;
 evidence:RangeKeeperPaperOwnedForkConfirmationEvidence}>{
 const {probe,profile,frame}=input;
 assert(/^[a-f0-9]{64}$/.test(input.configHash));
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
 const request:RangeKeeperPaperGasProbeRequest={kind:'open',profile,frame,candidate:probe.candidate,
  candidateSource:probe.source,candidateReferenceProofHash:frame.referenceProofHash,
  candidateHash,scope:probe.scope,pathVersion:probe.pathVersion,stages,openMarkId:null,openModelHash:null};
 const samples=await sampleRangeKeeperPaperGasStages(request,{rpcUrl:input.rpcUrl,
  beforeRead:input.beforeRead,maxRequests:input.maxRequests,timeoutMs:input.timeoutMs,
  limits:input.limits,initialBalances:input.initialBalances});
 const evidence=buildRangeKeeperPaperOwnedForkConfirmationEvidence({probe,frame,
  configHash:input.configHash,samples});
 return {simulation:{status:'success',sourceBlock:frame.source.block,sourceHash:frame.source.hash,
  candidateHash,simulationHash:evidence.sequenceHash},evidence};
}
