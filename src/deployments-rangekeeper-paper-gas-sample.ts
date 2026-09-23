import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {marketProfileSchema,type MarketProfile} from './deployments/market-profile.js';
import {produceRangeKeeperPaperGasEvidence} from './deployments/rangekeeper-paper-gas-evidence.js';
import {sampleRangeKeeperPaperGasStages} from './deployments/rangekeeper-paper-gas-sampler.js';
import {resolveRangeKeeperPaperPolicy,type RangeKeeperPaperDraft} from './deployments/rangekeeper-paper-open-model.js';
import {contentHash} from './deployments/contracts.js';
import type {RangeKeeperCandidate} from './strategy/rangekeeper/domain.js';
import type {PaperOpenFrame} from './deployments/paper-preview.js';
import type {RangeKeeperPaperCandidateScope} from './deployments/rangekeeper-paper-cost.js';
import {loadRuntimeIdentity} from './runtime/identity.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const sourceSchema=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
const candidateSchema=z.object({kind:z.enum(['entry','recenter']),range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swap:z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:raw,quotedOut:raw,minOut:raw,priceAfter:raw,
  feeValue:raw,shortfallValue:raw}).strict().nullable(),amount0Desired:raw,amount1Desired:raw,amount0Min:raw,
 amount1Min:raw,liquidity:raw,deployedValue:raw,sourceBlock:raw,sourceHash:hash,expiresAt:z.number().int().nonnegative()}).strict();
const inputSchema=z.object({kind:z.enum(['open','retain_exit','convert_exit']),campaignId:z.uuid(),revision:z.number().int().positive(),
 configHash:z.string().regex(/^[a-f0-9]{64}$/),profile:marketProfileSchema,frame:z.object({source:sourceSchema,
 tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw,price0:raw,price1:raw,nativePrice:raw,
 referenceEligible:z.literal(true),referenceReasons:z.array(z.string()),referenceProofHash:z.string().regex(/^[a-f0-9]{64}$/),
 referenceProof:z.record(z.string(),z.unknown())}).strict(),candidateSource:sourceSchema,
 candidateReferenceProofHash:z.string().regex(/^[a-f0-9]{64}$/),candidate:candidateSchema,
 openMarkId:raw.nullable(),openModelHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
 scope:z.object({poolAddress:z.string().regex(/^0x[0-9a-fA-F]{40}$/),profileHash:z.string().regex(/^[a-f0-9]{64}$/),
 candidateHash:z.string().regex(/^[a-f0-9]{64}$/),deployedValue:raw,sharePpm:raw,
 range:z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict(),
 swapKind:z.enum(['none','direct_pool_exact_input']),inventoryHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()}).strict();
const envSchema=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)});

const candidate=(c:z.infer<typeof candidateSchema>):RangeKeeperCandidate=>({kind:c.kind,range:c.range,
 swap:c.swap?{token:c.swap.token,amountIn:BigInt(c.swap.amountIn),quotedOut:BigInt(c.swap.quotedOut),
  minOut:BigInt(c.swap.minOut),priceAfter:BigInt(c.swap.priceAfter),feeValue:BigInt(c.swap.feeValue),
  shortfallValue:BigInt(c.swap.shortfallValue)}:null,amount0Desired:BigInt(c.amount0Desired),amount1Desired:BigInt(c.amount1Desired),
 amount0Min:BigInt(c.amount0Min),amount1Min:BigInt(c.amount1Min),liquidity:BigInt(c.liquidity),
 deployedValue:BigInt(c.deployedValue),sourceBlock:BigInt(c.sourceBlock),sourceHash:c.sourceHash as `0x${string}`,expiresAt:c.expiresAt});
const frame=(f:z.infer<typeof inputSchema>['frame']):PaperOpenFrame=>({...f,sqrtPriceX96:BigInt(f.sqrtPriceX96),
 poolLiquidity:BigInt(f.poolLiquidity),price0:BigInt(f.price0),price1:BigInt(f.price1),nativePrice:BigInt(f.nativePrice)});

async function main(){
 const [inputPath,outputPath]=process.argv.slice(2);
 if(!inputPath||!outputPath||process.argv.length!==4)
  throw Error('Usage: node --import tsx src/deployments-rangekeeper-paper-gas-sample.ts <probe-input.json> <new-report.json>');
 const env=envSchema.parse(process.env),identity=loadRuntimeIdentity();
 assert(identity,'RangeKeeper gas sampling requires a sealed runtime identity');
 const bytes=await readFile(inputPath);assert(bytes.byteLength<=250_000,'RangeKeeper probe input exceeds 250 KB');
 const parsed=inputSchema.parse(JSON.parse(bytes.toString('utf8')));
 assert.equal(parsed.kind,'open','This command samples open plus retain-exit evidence only');
 const store=new DeploymentStore(env.DATABASE_URL);let draft;
 try{await store.assertReady();draft=await store.paperDraft(parsed.campaignId);}
 finally{await store.close();}
 assert.equal(draft.strategyId,'rangekeeper_v1','Persisted draft is not RangeKeeper');
 assert.equal(draft.revision,parsed.revision);assert.equal(draft.configHash,parsed.configHash);
 assert.equal(draft.profileHash,parsed.scope.profileHash);assert.equal(contentHash(draft.profile),contentHash(parsed.profile));
 const resolved=resolveRangeKeeperPaperPolicy(draft as RangeKeeperPaperDraft,identity.buildId);
 assert(resolved.policy&&resolved.unavailable.length===0,
  `Persisted RangeKeeper policy unavailable: ${resolved.unavailable.join(',')}`);
 const profile=parsed.profile as MarketProfile,rkCandidate=candidate(parsed.candidate),
  paperFrame=frame(parsed.frame),scope:RangeKeeperPaperCandidateScope={
   ...parsed.scope,deployedValue:BigInt(parsed.scope.deployedValue),sharePpm:BigInt(parsed.scope.sharePpm)};
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS,{retryCount:0});
 assert.equal(await client.getChainId(),profile.pool.chainId,'Probe RPC chain differs from profile');
 const report=await produceRangeKeeperPaperGasEvidence({kind:parsed.kind,campaignId:parsed.campaignId,
  revision:parsed.revision,configHash:parsed.configHash,buildId:identity.buildId,profile,frame:paperFrame,
  candidateSource:parsed.candidateSource,candidateReferenceProofHash:parsed.candidateReferenceProofHash,
  candidate:rkCandidate,openMarkId:parsed.openMarkId,openModelHash:parsed.openModelHash,
  marketGasPriceWei:await client.getGasPrice(),scope,
  sampleOwnedFork:request=>sampleRangeKeeperPaperGasStages(request,{rpcUrl:env.ROBINHOOD_READ_HTTP_URL,
   beforeRead:async()=>{},maxRequests:1600,timeoutMs:300_000,limits:resolved.policy!.limits,
   initialBalances:[BigInt(draft.allocation.token0Raw),BigInt(draft.allocation.token1Raw)]})});
 await writeFile(outputPath,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
 process.stdout.write(`${JSON.stringify({outputPath,reportHash:report.reportHash,
  source:report.frame.source,stages:report.stageProfiles.length,registration:'not_performed'})}\n`);
}
main().catch(error=>{
 const message=error instanceof Error?error.message:'rangekeeper_paper_gas_sample_failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gu,'[redacted-url]').slice(0,500)}\n`);
 process.exitCode=1;
});
