import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {contentHash,rangeKeeperParameters} from '../../src/deployments/contracts.js';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.js';
import {marketProfileSchema} from '../../src/deployments/market-profile.js';
import {resolveRangeKeeperPaperPolicy} from '../../src/deployments/rangekeeper-paper-open-model.js';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand}
 from '../../src/deployments/rangekeeper-paper-cost.js';
import {consumeTrustedRangeKeeperSimulation,simulateRangeKeeperPaperConfirmationOnOwnedFork}
 from '../../src/deployments/rangekeeper-paper-confirmation-simulation.js';
import {consumeRangeKeeperSimulationWithAnchors} from
 '../../src/deployments/rangekeeper-paper-confirmation-producer.js';
import {isRangeKeeperPaperConfirmationReplayCapability,replayRangeKeeperPaperConfirmationOnOwnedFork}
 from '../../src/deployments/rangekeeper-paper-confirmation-replay-verifier.js';
import {validateRangeKeeperPaperConfirmationEnvelope}
 from '../../src/deployments/rangekeeper-paper-persistence.js';
import {readRangeKeeperPaperConfirmationFrame} from
 '../../src/deployments/rangekeeper-paper-confirmation-frame.js';
import {replayPaperMint} from '../../src/v3/position-math.js';
import {rangeKeeperConfirmedSource} from '../../src/strategy/rangekeeper/source.js';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.js';
import {planRangeKeeper} from '../../src/strategy/rangekeeper/planner.js';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.js';
import {createRobinhoodClient} from '../../src/client.js';

// Opt-in positive simulation check. Archive RPC is used only for pinned reads;
// all generated transactions run on the owned local Anvil fork.
const envPath=process.argv[2]??'.env';
const pinnedBlock=process.argv[3];
const secondPinnedBlock=process.argv[4];
const failSafe=(error)=>{
 const safe=error instanceof Error?error.message:'owned replay failed';
 process.stderr.write(`${safe.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,240)}\n`);
 process.exitCode=1;
};
function differingPaths(left,right,path='evidence'){
 if(contentHash(left)===contentHash(right))return [];
 if(left&&right&&typeof left==='object'&&typeof right==='object'&&!Array.isArray(left)&&!Array.isArray(right)){
  const keys=[...new Set([...Object.keys(left),...Object.keys(right)])].sort();
  return keys.flatMap(key=>differingPaths(left[key],right[key],`${path}.${key}`));
 }
 if(Array.isArray(left)&&Array.isArray(right)){
  const length=Math.max(left.length,right.length),out=[];
  for(let i=0;i<length;i++)out.push(...differingPaths(left[i],right[i],`${path}[${i}]`));
  return out;
 }
 return [path];
}

try{
 const env=parseEnv(readFileSync(envPath,'utf8'));
 const archive=env.RH_ARCHIVE_RPC_URL;
 assert(archive,'Archive RPC unavailable');
 const rawConfig=JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8'));
 const config=parseRangeKeeperConfig(rawConfig);
 assert.equal(config.broadcastEnabled,false);
 const profile=marketProfileSchema.parse({pool:config.pool,referencePolicy:config.referencePolicy});
 const {fullWidthSpacings,...kernelLimits}=config.limits;
 const parameters=rangeKeeperParameters.parse({fullWidthSpacings,
  limits:{...Object.fromEntries(Object.entries(kernelLimits).map(([key,value])=>
   [key,typeof value==='bigint'?String(value):value])),minDeploymentValue:'0'}});
 const configHash=contentHash({...parameters,strategyId:'rangekeeper_v1',strategyVersion:'1.0.0',stateSchemaVersion:1});
 const draft={id:'15155a1c-178b-48b0-941c-36d73e763554',revision:1,strategyId:'rangekeeper_v1',
  strategyVersion:'1.0.0',stateSchemaVersion:1,parameters,configHash,profile,profileHash:contentHash(profile),
  allocation:{token0Raw:'250000000',token1Raw:'0',nativeWei:'3000000000000000'}};
 const buildId='a'.repeat(64),policy=resolveRangeKeeperPaperPolicy(draft,buildId);
 assert(policy.policy&&policy.unavailable.length===0,'Frozen campaign policy unavailable');
 const client=createRobinhoodClient(archive,15_000,{retryCount:0,beforeRequest:async()=>{}});
 const readFrame=async()=>{
  const source=await rangeKeeperConfirmedSource(client);
  return readCanonicalPaperOpenFrame(client,profile,{block:String(source.block),hash:source.hash,
   timestamp:source.timestamp});
 };
 const readPinnedFrame=async(blockNumber)=>{
  const source=await client.getBlock({blockNumber:BigInt(blockNumber)});
  assert(source.hash,'Pinned fixture block is unavailable');
  return readCanonicalPaperOpenFrame(client,profile,{block:String(source.number),hash:source.hash,
   timestamp:Number(source.timestamp)});
 };
 const p=profile.pool,chain=new RangeKeeperChain(client,p),limits=policy.policy.limits;
 const quote=(frame)=>(token,amount)=>chain.quote({block:BigInt(frame.source.block),
  hash:frame.source.hash,timestamp:frame.source.timestamp},token,amount,frame.price0,frame.price1);
 const observation=(frame)=>{
  assert(frame.price0&&frame.price1&&frame.nativePrice&&frame.referenceEligible);
  const strategyValue=BigInt(draft.allocation.token0Raw)*frame.price0/10n**BigInt(p.decimals0)+
   BigInt(draft.allocation.token1Raw)*frame.price1/10n**BigInt(p.decimals1);
  return {block:BigInt(frame.source.block),hash:frame.source.hash,timestamp:frame.source.timestamp,
   tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',
   wallet0:BigInt(draft.allocation.token0Raw),wallet1:BigInt(draft.allocation.token1Raw),
   released0:0n,released1:0n,nativeWei:BigInt(draft.allocation.nativeWei),
   requiredExitReserveWei:limits.exitReserveWei,price0:frame.price0,price1:frame.price1,
   nativePrice:frame.nativePrice,position:null,pending:false,entryAllowed:true,safeExitRequired:false,
   executionReady:true,liquiditySharePpm:0,actionCost:limits.maxActionCost,actionGasWei:0n,
   reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,campaignStartValue:strategyValue,
   highWaterValue:strategyValue,recenters:0};
 };
 const state={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
  configHash:`0x${policy.policy.policyHash}`,buildId,lastEligible:null,exit:null,confirmation:null};
 let firstFrame,first,lastFirstReason='no_fresh_source';
 for(let attempt=0;attempt<(pinnedBlock?1:12);attempt++){
  const frame=pinnedBlock?await readPinnedFrame(pinnedBlock):await readFrame();
  if(firstFrame&&frame.source.block===firstFrame.source.block){
   await new Promise(resolve=>setTimeout(resolve,3_000));continue;
  }
  firstFrame=frame;
  first=await planRangeKeeper({state,observation:observation(frame),limits,
   spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
   maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,quote:quote(frame),simulate:async()=>true});
  lastFirstReason=first.reason;
  if(first.action==='confirm')break;
  await new Promise(resolve=>setTimeout(resolve,3_000));
 }
 assert(firstFrame&&first?.action==='confirm',`No fresh first-observation candidate: ${lastFirstReason}`);
 assert(first.candidate&&first.state.confirmation,'First candidate unavailable');
 let secondFrame,second,confirmed=false;
 if(secondPinnedBlock){
  secondFrame=await readPinnedFrame(secondPinnedBlock);
  assert(secondFrame.source.timestamp-firstFrame.source.timestamp>=30&&
   secondFrame.source.timestamp-firstFrame.source.timestamp<=limits.maxObservationGapSeconds,
   'Pinned test sources violate the frozen observation gap');
  second=await planRangeKeeper({state:first.state,observation:observation(secondFrame),limits,
   spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
   maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,quote:quote(secondFrame),simulate:async()=>true});
  confirmed=second.action==='execute'&&second.reason==='two_confirmations'&&second.candidate!==null;
 }else if(!pinnedBlock){
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,2_000));
   const next=await readFrame();
   if(next.source.timestamp-firstFrame.source.timestamp>=30){
    secondFrame=next;
    second=await planRangeKeeper({state:first.state,observation:observation(next),limits,
     spacing:p.tickSpacing,decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
     maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,quote:quote(next),simulate:async()=>true});
    confirmed=second.action==='execute'&&second.reason==='two_confirmations'&&second.candidate!==null;
    if(confirmed)break;
   }
   if(next.source.timestamp-firstFrame.source.timestamp>limits.maxObservationGapSeconds)break;
  }
 }
 // If real source movement invalidates the saved candidate, retain a valid
 // first-frame construction solely for runner determinism diagnostics. It is
 // reported as non-confirmation evidence and cannot support booking.
 const evidenceFrame=confirmed?secondFrame:firstFrame;
 const reboundFrame=await readRangeKeeperPaperConfirmationFrame({client,profile,saved:evidenceFrame});
 assert.equal(reboundFrame.referenceProofHash,evidenceFrame.referenceProofHash);
 assert.equal(contentHash(reboundFrame.referenceProof),contentHash(evidenceFrame.referenceProof));
 const candidate=confirmed?second.candidate:first.candidate;
 assert(candidate,'No candidate to replay on an owned fork');
 const source=evidenceFrame.source;
 const candidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source,
  referenceProofHash:evidenceFrame.referenceProofHash,candidate});
 const denominator=evidenceFrame.poolLiquidity+candidate.liquidity;
 assert(denominator>0n);
 const scope={poolAddress:p.pool,profileHash:draft.profileHash,candidateHash,
  deployedValue:candidate.deployedValue,sharePpm:candidate.liquidity*1_000_000n/denominator,
  range:candidate.range,swapKind:candidate.swap?'direct_pool_exact_input':'none'};
 const pathVersion=rangeKeeperPaperPathVersion(candidate),probe={status:'candidate',campaignId:draft.id,
  revision:draft.revision,firstModelHash:'0'.repeat(64),firstCandidateHash:'1'.repeat(64),source,
  candidate,candidateHash,scope,pathVersion,sizeBand:rangeKeeperPaperSizeBand(pathVersion,scope),actionAvailable:false};
 const simulate=(readDelayMs)=>simulateRangeKeeperPaperConfirmationOnOwnedFork({probe,profile,frame:evidenceFrame,
  configHash:draft.configHash,initialBalances:[BigInt(draft.allocation.token0Raw),BigInt(draft.allocation.token1Raw)],
  allocation:draft.allocation,
  limits,rpcUrl:archive,beforeRead:async()=>{if(readDelayMs)await new Promise(resolve=>setTimeout(resolve,readDelayMs));},
  timeoutMs:180_000});
 const firstReplay=await simulate(0),secondReplay=await simulate(17);
 const capabilityContext={probe,profile,frame:evidenceFrame,configHash,allocation:draft.allocation,limits};
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:structuredClone(firstReplay),
  context:capabilityContext}),null,'Serialized owned-fork capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:firstReplay,
  context:{...capabilityContext,configHash:'9'.repeat(64)}}),null,'Cross-config capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:firstReplay,context:capabilityContext}),firstReplay,
  'Exact owned-fork capability could not be consumed');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:firstReplay,context:capabilityContext}),null,
  'Owned-fork capability was reusable more than once');
 let anchorChecks=0;
 await assert.rejects(consumeRangeKeeperSimulationWithAnchors({simulation:secondReplay,context:capabilityContext,
  verifySource:async()=>{anchorChecks++;if(anchorChecks===2)throw new Error('source reorg during capability consume');}}),
  /source reorg during capability consume/);
 assert.equal(anchorChecks,2);
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:secondReplay,context:capabilityContext}),null,
  'Reorged capability remained reusable');
 const evidenceDiff=differingPaths(firstReplay.ownedForkEvidence,secondReplay.ownedForkEvidence);
 if(evidenceDiff.length)process.stderr.write(`fork-evidence-diff=${evidenceDiff.slice(0,30).join(',')}\n`);
 assert.equal(contentHash(firstReplay.ownedForkEvidence),contentHash(secondReplay.ownedForkEvidence),
  'Fresh owned forks produced different exact source-bound stage evidence');
 assert.equal(firstReplay.simulationHash,secondReplay.simulationHash);
 assert.equal(firstReplay.candidateHash,candidateHash);
 assert(confirmed&&secondFrame&&second?.candidate,'Replay capability requires two actual observations');
 const firstCandidateHash=rangeKeeperPaperCandidateHash({campaignId:draft.id,revision:draft.revision,
  profileHash:draft.profileHash,configHash:draft.configHash,source:firstFrame.source,
  referenceProofHash:firstFrame.referenceProofHash,candidate:first.candidate});
 const serialCandidate=c=>({kind:c.kind,range:c.range,swap:c.swap?{token:c.swap.token,
  amountIn:String(c.swap.amountIn),quotedOut:String(c.swap.quotedOut),minOut:String(c.swap.minOut),
  priceAfter:String(c.swap.priceAfter),feeValue:String(c.swap.feeValue),
  shortfallValue:String(c.swap.shortfallValue)}:null,amount0Desired:String(c.amount0Desired),
  amount1Desired:String(c.amount1Desired),amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),
  liquidity:String(c.liquidity),deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),
  sourceHash:c.sourceHash,expiresAt:c.expiresAt});
 const mint=replayPaperMint(secondFrame.sqrtPriceX96,second.candidate.range,
  second.candidate.amount0Desired,second.candidate.amount1Desired,0n);
 let idle0=BigInt(draft.allocation.token0Raw),idle1=BigInt(draft.allocation.token1Raw);
 if(second.candidate.swap){if(second.candidate.swap.token===0){idle0-=second.candidate.swap.amountIn;
  idle1+=second.candidate.swap.quotedOut;}else{idle1-=second.candidate.swap.amountIn;
  idle0+=second.candidate.swap.quotedOut;}}
 idle0-=mint.amount0;idle1-=mint.amount1;assert(idle0>=0n&&idle1>=0n);
 const replayState=JSON.parse(JSON.stringify(second.state,(_key,value)=>
  typeof value==='bigint'?String(value):value));
 const envelopeBody={schemaVersion:1,kind:'rangekeeper_paper_open_confirmation_v1',status:'confirmed',
  campaignId:draft.id,revision:draft.revision,draftConfigHash:draft.configHash,profileHash:draft.profileHash,
  firstObservation:{source:firstFrame.source,modelHash:'d'.repeat(64),candidateHash:firstCandidateHash},
  confirmationObservation:{source:secondFrame.source,candidateHash,
   candidate:serialCandidate(second.candidate),poolState:{tick:secondFrame.tick,
    sqrtPriceX96:String(secondFrame.sqrtPriceX96),poolLiquidity:String(secondFrame.poolLiquidity)},
   reference:{price0:String(secondFrame.price0),price1:String(secondFrame.price1),
    nativePrice:String(secondFrame.nativePrice),proofHash:secondFrame.referenceProofHash,
    proof:secondFrame.referenceProof}},
  decision:{action:'execute',reason:'two_confirmations',gasSequenceHash:firstReplay.simulationHash,
   simulation:{status:'success',sourceBlock:source.block,sourceHash:source.hash,candidateHash,
    simulationHash:firstReplay.simulationHash}},
  simulationEvidence:firstReplay.ownedForkEvidence,
  costs:{status:'provisional',profileIds:[]},strategyState:replayState,
  inventory:{position:{tickLower:second.candidate.range.tickLower,tickUpper:second.candidate.range.tickUpper,
   liquidity:String(second.candidate.liquidity)},idle:{token0:String(idle0),token1:String(idle1)}},
  selectedGasProfileIds:[],executionEvidence:'source_bound_caller_simulation_evidence_unverified',
  openingBooked:false,actionAvailable:false};
 const envelope=validateRangeKeeperPaperConfirmationEnvelope({...envelopeBody,
  envelopeHash:contentHash(envelopeBody)},{campaignId:draft.id,revision:draft.revision});
 const operationId='a00df4b1-b778-4cae-8274-4b437098c52e',openPreviewId='8e9b81e8-407c-4b4b-858a-8847b902d8de',
  operationSnapshotHash='c'.repeat(64);
 const replay=await replayRangeKeeperPaperConfirmationOnOwnedFork({draft,envelope,frame:secondFrame,
  operationId,openPreviewId,operationSnapshotHash,rpcUrl:archive,beforeRead:async()=>{},timeoutMs:180_000});
 assert(isRangeKeeperPaperConfirmationReplayCapability(replay,{operationId,openPreviewId,operationSnapshotHash,
  campaignId:draft.id,revision:draft.revision,envelopeHash:envelope.envelopeHash,candidateHash,
  simulationHash:firstReplay.simulationHash}));
 process.stdout.write(JSON.stringify({status:'matched',stageCount:firstReplay.ownedForkEvidence.stages.length,
  candidateHash,replayHash:contentHash(firstReplay.ownedForkEvidence),freshForks:3,
  twoObservationConfirmation:confirmed,testOnlyPinnedSource:Boolean(pinnedBlock||secondPinnedBlock),
  operationBoundReplayCapability:true,bookingAvailable:false,actionAvailable:false})+'\n');
}catch(error){failSafe(error);}
