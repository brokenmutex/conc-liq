import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {contentHash} from './deployments/contracts.js';
import {loadRangeKeeperPaperExitContext,rangeKeeperPaperExitContextSeed} from './deployments/rangekeeper-paper-context.js';
import {readCanonicalPaperNextFrame} from './deployments/paper-preview.js';
import {verifyCanonicalPaperAnchors} from './deployments/paper-canonical-anchors.js';
import {resolveRangeKeeperPaperPolicy} from './deployments/rangekeeper-paper-open-model.js';
import {rangeKeeperPaperSizeBand} from './deployments/rangekeeper-paper-cost.js';
import {produceRangeKeeperPaperGasEvidence} from './deployments/rangekeeper-paper-gas-evidence.js';
import {sampleRangeKeeperPaperGasStages,terminalInventoryHash} from './deployments/rangekeeper-paper-gas-sampler.js';
import {loadRuntimeIdentity} from './runtime/identity.js';
import {principalAmounts} from './backtest/principal.js';
import type {RangeKeeperCandidate} from './strategy/rangekeeper/domain.js';
import type {RangeKeeperPaperCandidateScope} from './deployments/rangekeeper-paper-cost.js';

const envSchema=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)});
const decimalCandidate=(raw:unknown):RangeKeeperCandidate=>{
 const c=raw as any;
 assert(c&&typeof c==='object'&&c.kind&&c.range&&c.amount0Desired!==undefined,'Persisted saved candidate missing');
 return {kind:c.kind,range:c.range,swap:c.swap?{...c.swap,amountIn:BigInt(c.swap.amountIn),quotedOut:BigInt(c.swap.quotedOut),
  minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),feeValue:BigInt(c.swap.feeValue),
  shortfallValue:BigInt(c.swap.shortfallValue)}:null,amount0Desired:BigInt(c.amount0Desired),
  amount1Desired:BigInt(c.amount1Desired),amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),
  liquidity:BigInt(c.liquidity),deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),
  sourceHash:c.sourceHash,expiresAt:c.expiresAt};
};
async function main(){
 const [campaignId,outputPath]=process.argv.slice(2);
 assert(process.argv.length===4&&campaignId&&outputPath&&z.uuid().safeParse(campaignId).success,
  'Usage: node --import tsx src/deployments-rangekeeper-paper-gas-terminal-sample.ts <campaign-uuid> <new-report.json>');
 const env=envSchema.parse(process.env),identity=loadRuntimeIdentity();
 assert(identity,'Terminal gas sampling requires sealed runtime identity');
 const store=new DeploymentStore(env.DATABASE_URL),client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,
  env.DEPLOYMENT_RPC_TIMEOUT_MS,{retryCount:0});
 try{
  await store.assertReady();
  const snapshot=await store.rangeKeeperPaperExitContextSnapshot(campaignId),seed=rangeKeeperPaperExitContextSeed(snapshot,campaignId);
  assert(seed,'Trusted persisted RangeKeeper terminal context unavailable');
  const frame=await readCanonicalPaperNextFrame(client,seed.profile,
   {sourceBlock:seed.previousSource.block,sourceHash:seed.previousSource.hash});
  await verifyCanonicalPaperAnchors(client,seed.profile.pool.chainId,[seed.openSource,seed.previousSource,frame.source]);
  const context=await loadRangeKeeperPaperExitContext({campaignId,buildId:identity.buildId,frame,
   readSnapshot:async()=>snapshot,readGasProfiles:q=>store.rangeKeeperPaperGasProfiles(q.poolAddress,q.pathVersion,q.sizeBand)});
  if(context.status!=='available')throw Error(`Persisted terminal context unavailable: ${context.reason}`);
  const resolved=resolveRangeKeeperPaperPolicy(context.draft,identity.buildId);
  assert(resolved.policy&&resolved.unavailable.length===0,'Persisted RangeKeeper policy unavailable');
  const candidate=decimalCandidate(context.openModel.candidate),p=context.draft.profile.pool;
  assert.equal(await client.getChainId(),p.chainId);
  const principal=principalAmounts({liquidity:candidate.liquidity,tickLower:candidate.range.tickLower,
   tickUpper:candidate.range.tickUpper,sqrtPriceX96:frame.sqrtPriceX96});
  const deployed=principal.amount0*frame.price0!/10n**BigInt(p.decimals0)+
   principal.amount1*frame.price1!/10n**BigInt(p.decimals1),denom=frame.poolLiquidity+candidate.liquidity;
  assert(denom>0n);
  const scope:RangeKeeperPaperCandidateScope={poolAddress:p.pool,profileHash:context.draft.profileHash,
   candidateHash:context.openModel.candidateHash!,deployedValue:deployed,
   sharePpm:candidate.liquidity*1_000_000n/denom,range:candidate.range,
   swapKind:candidate.swap?'direct_pool_exact_input':'none',inventoryHash:terminalInventoryHash(context,candidate,frame)};
  const report=await produceRangeKeeperPaperGasEvidence({kind:'retain_exit',campaignId,
   revision:context.draft.revision,configHash:context.draft.configHash,buildId:identity.buildId,
   profile:context.draft.profile,frame,candidateSource:context.openModel.source,
   candidateReferenceProofHash:context.openModel.reference.proofHash,candidate,openMarkId:context.openMarkId,
   openModelHash:contentHash(context.openModel),marketGasPriceWei:await client.getGasPrice(),scope,
   sampleOwnedFork:request=>sampleRangeKeeperPaperGasStages(request,{rpcUrl:env.ROBINHOOD_READ_HTTP_URL,
    beforeRead:async()=>{},maxRequests:1600,timeoutMs:300_000,limits:resolved.policy!.limits,terminalContext:context})});
  await writeFile(outputPath,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
  process.stdout.write(`${JSON.stringify({outputPath,reportHash:report.reportHash,source:report.frame.source,
   stages:report.stageProfiles.length,registration:'not_performed'})}\n`);
 }finally{await store.close();}
}
main().catch(error=>{
 const message=error instanceof Error?error.message:'rangekeeper_terminal_paper_gas_sample_failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gu,'[redacted-url]').slice(0,500)}\n`);process.exitCode=1;
});
