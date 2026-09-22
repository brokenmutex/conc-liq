import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {verifyPaperGasSource} from './deployments/paper-gas-source.js';
import {DeploymentStore} from './deployments/store.js';

const envSchema=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)});

async function main(){
 const path=process.argv[2];
 if(!path||process.argv.length!==3)throw Error('Usage: deployments-paper-gas-register <report.json>');
 const env=envSchema.parse(process.env),bytes=await readFile(path);
 if(bytes.length>1_000_000)throw Error('Paper gas report exceeds one-megabyte ingestion bound');
 const report=JSON.parse(bytes.toString('utf8')) as unknown;
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS);
 const attestation=await verifyPaperGasSource(client,report);
 const store=new DeploymentStore(env.DATABASE_URL);
 try{
  await store.assertReady();
  const result=await store.registerPaperGasEvidence(report,attestation);
  process.stdout.write(`${JSON.stringify({created:result.created,version:result.version,
   profileIds:result.profileIds,reportHash:result.reportHash,sizeBand:result.sizeBand,
   status:'provisional',attestation})}\n`);
 }finally{await store.close();}
}

main().catch(error=>{
 process.stderr.write(`${error instanceof Error?error.message:'paper_gas_registration_failed'}\n`);
 process.exitCode=1;
});
