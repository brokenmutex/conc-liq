import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEnv} from 'node:util';
import {readFileSync} from 'node:fs';
import {parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.ts';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.ts';
import {planRangeKeeper,rawValue} from '../../src/strategy/rangekeeper/planner.ts';
import {createRobinhoodClient} from '../../src/client.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {readCanonicalPaperOpenFrame} from '../../src/deployments/paper-preview.ts';
import {contentHash} from '../../src/deployments/contracts.ts';
import {rangeKeeperPaperCandidateHash,rangeKeeperPaperPathVersion,rangeKeeperPaperSizeBand}
 from '../../src/deployments/rangekeeper-paper-cost.ts';
import {simulateRangeKeeperPaperConfirmationOnOwnedFork} from
 '../../src/deployments/rangekeeper-paper-confirmation-simulation.ts';
import {consumeTrustedRangeKeeperSimulation} from
 '../../src/deployments/rangekeeper-paper-confirmation-simulation.ts';
import {consumeRangeKeeperSimulationWithAnchors} from
 '../../src/deployments/rangekeeper-paper-confirmation-producer.ts';

// RPC-only diagnostic for the exact RangeKeeper confirmation fork runner. It
// uses a pinned canonical frame and a fresh local Anvil process; no DB, signer,
// signing, or chain broadcast is involved.
const safeError=error=>{
 const message=error instanceof Error?error.message:'RangeKeeper owned-fork diagnostic failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,350)}\n`);
 process.exitCode=1;
};
try{
 const dotenv=parseEnv(readFileSync('.env','utf8')),
  archive=dotenv.RH_ARCHIVE_RPC_URL,readRpc=dotenv.ROBINHOOD_READ_HTTP_URL??archive,
  streamKey=dotenv.INDEXER_STREAM_KEY??'robinhood-v3-rwa-usdg-v1';
 assert(archive&&readRpc&&streamKey,'Read-only RPC or indexer stream configuration unavailable');
 const config=parseRangeKeeperConfig(JSON.parse(readFileSync('config/rangekeeper-v1-aapl-disabled.json','utf8'))),
  profile=marketProfileSchema.parse({pool:config.pool,referencePolicy:config.referencePolicy}),
  client=createRobinhoodClient(readRpc,15_000,{retryCount:0}),startedAt=Date.now();
 assert.equal(config.broadcastEnabled,false);
 const frame=await readCanonicalPaperOpenFrame(client,profile),frameReadAt=Date.now();
 assert(frame.referenceEligible&&frame.price0&&frame.price1&&frame.nativePrice);
 const token0=250_000_000n,token1=0n,nativeWei=3_000_000_000_000_000n,
  value=rawValue(token0,frame.price0,profile.pool.decimals0)+rawValue(token1,frame.price1,profile.pool.decimals1),
  configHash=contentHash({fixture:'rangekeeper-paper-owned-fork-read-diagnostics-v1'}),
  profileHash=contentHash(profile),buildId='a'.repeat(64),
  state={schemaVersion:1,policyId:'rangekeeper_v1',strategyVersion:'1.0.0',
   configHash:`0x${configHash}`,buildId,lastEligible:null,exit:null,confirmation:null},
  chain=new RangeKeeperChain(client,profile.pool),source={block:BigInt(frame.source.block),
   hash:frame.source.hash,timestamp:frame.source.timestamp},
  quote=(token,amount)=>chain.quote(source,token,amount,frame.price0,frame.price1),
  observation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:frame.tick,
   sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical',wallet0:token0,wallet1:token1,
   released0:0n,released1:0n,nativeWei,requiredExitReserveWei:config.limits.exitReserveWei,
   price0:frame.price0,price1:frame.price1,nativePrice:frame.nativePrice,position:null,pending:false,
   entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:0,
   actionCost:config.limits.maxActionCost,actionGasWei:0n,reservedCost:0n,rollingSpentCost:0n,
   campaignSpentCost:0n,campaignStartValue:value,highWaterValue:value,recenters:0},
  proposal=await planRangeKeeper({state,observation,limits:config.limits,spacing:profile.pool.tickSpacing,
   decimals0:profile.pool.decimals0,decimals1:profile.pool.decimals1,quoteToken:profile.pool.quoteToken,
   maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,quote,simulate:async()=>true});
 assert.equal(proposal.action,'confirm',`Current source has no confirmation candidate: ${proposal.reason}`);
 assert(proposal.candidate);
 const campaignId=randomUUID(),candidate=proposal.candidate,
  candidateHash=rangeKeeperPaperCandidateHash({campaignId,revision:1,profileHash,configHash,
   source:frame.source,referenceProofHash:frame.referenceProofHash,candidate}),
  denominator=frame.poolLiquidity+candidate.liquidity;
 assert(denominator>0n);
 const scope={poolAddress:profile.pool.pool,profileHash,candidateHash,
  deployedValue:candidate.deployedValue,sharePpm:candidate.liquidity*1_000_000n/denominator,
  range:candidate.range,swapKind:candidate.swap?'direct_pool_exact_input':'none'},
  pathVersion=rangeKeeperPaperPathVersion(candidate),
  probe={status:'candidate',campaignId,revision:1,source:frame.source,candidate,candidateHash,scope,
   pathVersion,sizeBand:rangeKeeperPaperSizeBand(pathVersion,scope),actionAvailable:false};
 const baselineMetrics=[],prefetchMetrics=[];let readHints=[];
 const simulationInput={probe,profile,frame,configHash,initialBalances:[token0,token1],
  allocation:{token0Raw:String(token0),token1Raw:String(token1),nativeWei:String(nativeWei)},limits:config.limits,
  rpcUrl:archive,beforeRead:async()=>{},timeoutMs:180_000};
 const baselineStarted=Date.now();
 const baseline=await simulateRangeKeeperPaperConfirmationOnOwnedFork({...simulationInput,
  onReadDiagnostics:value=>baselineMetrics.push(value),onReadHints:value=>{readHints=value;}});
 const baselineMs=Date.now()-baselineStarted;
 const prefetchedStarted=Date.now();
 const prefetched=await simulateRangeKeeperPaperConfirmationOnOwnedFork({...simulationInput,prefetchHints:readHints,
  onReadDiagnostics:value=>prefetchMetrics.push(value)});
 const prefetchedMs=Date.now()-prefetchedStarted;
 assert(readHints.length>0,'Baseline owned fork did not observe any immutable read shapes');
 assert.equal(prefetched.ownedForkEvidence.sequenceHash,baseline.ownedForkEvidence.sequenceHash,
  'Fresh-prefetch owned fork changed the ten-stage evidence hash');
 assert.deepEqual(prefetched.ownedForkEvidence.stages.map(x=>x.txHash),
  baseline.ownedForkEvidence.stages.map(x=>x.txHash),'Fresh-prefetch owned fork changed stage transaction hashes');
 assert(Object.isFrozen(prefetched)&&Object.isFrozen(prefetched.ownedForkEvidence)&&
  Object.isFrozen(prefetched.ownedForkEvidence.stages),'Owned simulation capability is mutable');
 assert.throws(()=>{prefetched.ownedForkEvidence.stages[0].calldata='0x1234';},
  'Owned simulation evidence mutation was not blocked');
 const capabilityContext={probe,profile,frame,configHash,
  allocation:{token0Raw:String(token0),token1Raw:String(token1),nativeWei:String(nativeWei)},limits:config.limits};
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:structuredClone(prefetched),
  context:capabilityContext}),null,'Serialized simulation was accepted as a capability');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,configHash:'f'.repeat(64)}}),null,'Cross-config capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,allocation:{...capabilityContext.allocation,nativeWei:'1'}}}),null,
  'Cross-allocation capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,limits:{...config.limits,maxSlippageBps:config.limits.maxSlippageBps-1}}}),null,
  'Cross-limits capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,profile:{...profile,pool:{...profile.pool,fee:profile.pool.fee+1}}}}),null,
  'Cross-profile capability was accepted');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,frame:{...frame,referenceProof:{tampered:true}}}}),null,
  'Capability accepted a changed proof body');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,
  context:{...capabilityContext,frame:{...frame,referenceEligible:false}}}),null,
  'Capability accepted an ineligible reference frame');
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:prefetched,context:capabilityContext,
  now:probe.candidate.expiresAt*1000}),null,'Expired capability was accepted');
 const verifySource=async()=>{
  const block=await client.getBlock({blockNumber:BigInt(frame.source.block)});
  assert.equal(block.hash?.toLowerCase(),frame.source.hash.toLowerCase());
  assert.equal(Number(block.timestamp),frame.source.timestamp);
 };
 assert.equal(await consumeRangeKeeperSimulationWithAnchors({simulation:prefetched,context:capabilityContext,
  verifySource}),prefetched,'Exact source-bound simulation capability was not consumed');
 let anchorChecks=0;
 await assert.rejects(consumeRangeKeeperSimulationWithAnchors({simulation:baseline,context:capabilityContext,
  verifySource:async()=>{anchorChecks++;if(anchorChecks===2)throw new Error('pinned source reorged during consume');}}),
  /pinned source reorged during consume/);
 assert.equal(anchorChecks,2);
 assert.equal(consumeTrustedRangeKeeperSimulation({simulation:baseline,context:capabilityContext}),null,
  'Capability survived a failed post-consumption source anchor');
 process.stdout.write(JSON.stringify({event:'rangekeeper_owned_fork_read_diagnostics',
  source:frame.source,initialSourceAgeSeconds:Math.floor((frameReadAt-frame.source.timestamp*1000)/1000),
  seconds:{sourceFrame:(frameReadAt-startedAt)/1000,baselineOwnedFork:baselineMs/1000,
   prefetchedOwnedFork:prefetchedMs/1000,sourceToDone:(Date.now()-frameReadAt)/1000},
  stageCount:prefetched.ownedForkEvidence.stages.length,baselineMetrics:baselineMetrics[0]??null,
  prefetchMetrics:prefetchMetrics[0]??null,prefetchHintCount:readHints.length,
  evidenceHash:prefetched.ownedForkEvidence.sequenceHash,simulationCapabilityConsumedOnce:true,
  chainBroadcast:false,bookingAvailable:false,actionAvailable:false})+'\n');
}catch(error){safeError(error);}
