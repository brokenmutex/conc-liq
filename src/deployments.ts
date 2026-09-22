import {once} from 'node:events';
import {z} from 'zod';
import {DeploymentStore} from './deployments/store.js';
import {createDeploymentCommandServer} from './deployments/server.js';
import {log} from './logger.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 DEPLOYMENT_OPERATOR_PASSWORD_HASH:z.string().min(1),
 DEPLOYMENT_HOST:z.enum(['127.0.0.1','::1']).default('127.0.0.1'),
 DEPLOYMENT_PORT:z.coerce.number().int().min(1).max(65535).default(4174),
});

async function main(){
 const env=envSchema.parse(process.env);
 const store=new DeploymentStore(env.DATABASE_URL);
 try{await store.assertReady();}
 catch(error){await store.close();throw error;}
 const host=env.DEPLOYMENT_HOST,port=env.DEPLOYMENT_PORT;
 const origin=`http://${host==='::1'?'[::1]':host}:${port}`;
 const server=createDeploymentCommandServer(store,{origin,passwordHash:env.DEPLOYMENT_OPERATOR_PASSWORD_HASH});
 server.listen(port,host);await once(server,'listening');
 log('info','deployment_command_api_started',{host,port});
 let stopping=false;
 const stop=(signal:NodeJS.Signals)=>{
  if(stopping)return;stopping=true;
  log('info','deployment_command_api_stopping',{signal});
  server.close(()=>void store.close().then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;}));
 };
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
}

main().catch(error=>{
 log('error','deployment_command_api_failed',{reason:error instanceof Error?error.message:'unknown'});
 process.exitCode=1;
});
