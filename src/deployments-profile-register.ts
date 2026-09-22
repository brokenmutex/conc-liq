import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {createRobinhoodClient} from './client.js';
import {verifyMarketProfile} from './deployments/market-profile.js';
import {DeploymentStore} from './deployments/store.js';

const environment=z.object({
 DATABASE_URL:z.string().min(1),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 INDEXER_STREAM_KEY:z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9_-]*$/),
 PROFILE_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
});

async function main(){
 const path=process.argv[2];
 if(!path||process.argv.length!==3)throw Error('Usage: deployments-profile-register <profile.json>');
 const env=environment.parse(process.env);
 const raw=JSON.parse(await readFile(path,'utf8')) as unknown;
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.PROFILE_RPC_TIMEOUT_MS);
 const proof=await verifyMarketProfile(client,raw,env.INDEXER_STREAM_KEY);
 const store=new DeploymentStore(env.DATABASE_URL);
 try{
  await store.assertReady();
  const row=await store.registerVerifiedMarketProfile(proof);
  process.stdout.write(`${JSON.stringify({id:row.id,created:row.created,profileHash:proof.profileHash,
   source:proof.source,verificationClass:'canonical_chain_and_independent_reference_v1'})}\n`);
 }finally{await store.close();}
}

main().catch(error=>{
 process.stderr.write(`${error instanceof Error?error.message:'profile_registration_failed'}\n`);
 process.exitCode=1;
});
