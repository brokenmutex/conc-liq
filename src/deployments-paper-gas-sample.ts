import {writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {DeploymentStore} from './deployments/store.js';
import {readCanonicalPaperOpenFrame} from './deployments/paper-preview.js';
import {sampleStaticPaperGas} from './deployments/paper-gas-sampler.js';

const envSchema=z.object({DATABASE_URL:z.string().min(1),ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000)});

async function main(){
 const [draftId,outputPath]=process.argv.slice(2);
 if(!draftId||!outputPath||process.argv.length!==4)
  throw Error('Usage: deployments-paper-gas-sample <paper-draft-uuid> <new-output.json>');
 const env=envSchema.parse(process.env),store=new DeploymentStore(env.DATABASE_URL);
 let draft;
 try{await store.assertReady();draft=await store.paperDraft(draftId);}
 finally{await store.close();}
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS);
 const frame=await readCanonicalPaperOpenFrame(client,draft.profile);
 const report=await sampleStaticPaperGas({rpcUrl:env.ROBINHOOD_READ_HTTP_URL,draft,frame,
  beforeRead:async()=>{}});
 await writeFile(outputPath,`${JSON.stringify(report,null,2)}\n`,{flag:'wx',mode:0o600});
 process.stdout.write(`${JSON.stringify({outputPath,reportHash:report.reportHash,
  source:report.source,stages:report.stageProfiles.length})}\n`);
}

main().catch(error=>{
 process.stderr.write(`${error instanceof Error?error.message:'paper_gas_sample_failed'}\n`);
 process.exitCode=1;
});
