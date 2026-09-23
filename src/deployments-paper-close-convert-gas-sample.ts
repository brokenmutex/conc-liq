import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {marketProfileSchema} from './deployments/market-profile.js';
import {paperOpenModelSchema} from './deployments/paper-open-model.js';
import {paperCloseConvertRouteSchema} from './deployments/paper-close-convert-model.js';
import {sampleStaticPaperCloseConvertGas} from './deployments/paper-gas-sampler.js';
import {verifyPaperCloseConvertGasSource} from './deployments/paper-gas-source.js';
import {assertPaperCloseConvertSampleContext} from './deployments/paper-close-convert-gas-sample-context.js';
import {contentHash} from './deployments/contracts.js';
import type {PaperOpenFrame} from './deployments/paper-preview.js';
import type {PaperFeeCarry} from './deployments/paper-fee-replay.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const sourceSchema=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict();
const inputSchema=z.object({campaignId:z.uuid(),terminalMarkId:raw,previousMarkId:raw,
 profile:marketProfileSchema,openModel:paperOpenModelSchema,
 frame:z.object({source:sourceSchema,tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw,
  price0:raw,price1:raw,nativePrice:raw,referenceEligible:z.literal(true),referenceReasons:z.array(z.string()),
  referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),referenceProof:z.record(z.string(),z.unknown())}).strict(),
 route:paperCloseConvertRouteSchema,feeCarry:z.record(z.string(),z.unknown()),
 feeEvidence:z.object({id:raw,proofHash:z.string().regex(/^[0-9a-f]{64}$/),
  carryHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict()}).strict();
const envSchema=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)});

function parseFrame(rawFrame:z.infer<typeof inputSchema>['frame']):PaperOpenFrame{
 return {...rawFrame,sqrtPriceX96:BigInt(rawFrame.sqrtPriceX96),poolLiquidity:BigInt(rawFrame.poolLiquidity),
  price0:BigInt(rawFrame.price0),price1:BigInt(rawFrame.price1),nativePrice:BigInt(rawFrame.nativePrice)};
}

async function main(){
 const [inputPath,outputPath]=process.argv.slice(2);
 assert(process.argv.length===4&&inputPath&&outputPath,
  'Usage: deployments-paper-close-convert-gas-sample <persisted-context.json> <new-report.json>');
 const env=envSchema.parse(process.env),bytes=await readFile(inputPath);
 assert(bytes.byteLength<=250_000,'Close-convert context exceeds 250 KB');
 const input=inputSchema.parse(JSON.parse(bytes.toString('utf8'))),frame=parseFrame(input.frame),
  profile=input.profile,openModel=input.openModel;
 assert.equal(input.campaignId,openModel.campaignId);assert.equal(contentHash(profile),openModel.profileHash);
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS,{retryCount:0}),
  store=new DeploymentStore(env.DATABASE_URL);
 try{
  await store.assertReady();
  const terminal=await store.paperFeeSamplingState(input.campaignId);
  assertPaperCloseConvertSampleContext({campaignId:input.campaignId,terminalMarkId:input.terminalMarkId,
   previousMarkId:input.previousMarkId,profile,openModel,frame},terminal);
  assert.equal(await client.getChainId(),profile.pool.chainId);
  const report=await sampleStaticPaperCloseConvertGas({rpcUrl:env.ROBINHOOD_READ_HTTP_URL,
   openModel,profile,frame,route:input.route,feeCarry:input.feeCarry as unknown as PaperFeeCarry,
   feeEvidence:input.feeEvidence,terminalMarkId:input.terminalMarkId,previousMarkId:input.previousMarkId,
   beforeRead:async()=>{},maxRequests:1000,timeoutMs:150_000});
  const attestation=await verifyPaperCloseConvertGasSource(client,report,
   evidence=>store.verifyPersistedPaperCloseConvertGasEvidence(evidence),
   {rpcUrl:env.ROBINHOOD_READ_HTTP_URL,beforeRead:async()=>{},maxRequests:1000,timeoutMs:150_000});
  const result={report,attestation,registration:'not_performed' as const};
  await writeFile(outputPath,`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
  process.stdout.write(`${JSON.stringify({outputPath,reportHash:report.reportHash,
   source:report.source,stages:report.stageProfiles.length,attestation:attestation.verificationClass,
   registration:'not_performed'})}\n`);
 }finally{await store.close();}
}
main().catch(error=>{
 const message=error instanceof Error?error.message:'paper_close_convert_gas_sample_failed';
 process.stderr.write(`${message.replace(/https?:\/\/\S+/gu,'[redacted-url]').slice(0,500)}\n`);
 process.exitCode=1;
});
