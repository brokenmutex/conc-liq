import pg from 'pg';
import {createDeploymentCommandServer} from '../../src/deployments/server.ts';
import {DeploymentStore} from '../../src/deployments/store.ts';
import {deploymentPosition,readDeploymentByKey,readDeploymentDetail,readDeploymentRows}
 from '../../src/dashboard/deployment-position.ts';

const {DATABASE_URL,COMMAND_PORT,COMMAND_PASSWORD_HASH}=process.env;
if(!DATABASE_URL||!COMMAND_PORT||!COMMAND_PASSWORD_HASH)throw Error('process fixture environment incomplete');
const store=new DeploymentStore(DATABASE_URL),dashboard=new pg.Pool({connectionString:DATABASE_URL,max:2});
await store.assertReady();
const dashboardRead=async(rawPath)=>{
 const url=new URL(rawPath,'http://127.0.0.1'),path=url.pathname;
 const client=await dashboard.connect();
 try{
  const rows=await readDeploymentRows(client);
  if(path==='/api/positions')return {positions:rows.map(deploymentPosition),serverTime:new Date().toISOString()};
  const match=/^\/api\/positions\/(paper-dep-[0-9a-f-]{36})$/.exec(path);
  if(match){const row=await readDeploymentByKey(client,match[1]);
   return row?await readDeploymentDetail(client,row,Number(url.searchParams.get('hours')??24)):null;}
  throw Error('unsupported fixture dashboard path');
 }finally{client.release();}
};
const server=createDeploymentCommandServer(store,{origin:`http://127.0.0.1:${COMMAND_PORT}`,
 passwordHash:COMMAND_PASSWORD_HASH,dashboardRead,
 paperPreview:async(campaignId,kind)=>{
  if(kind==='pause'||kind==='resume')return store.recordPaperLifecyclePreview(campaignId,kind);
  return {kind,status:'unavailable',campaignId,reason:'process_harness_boundary',actionAvailable:false};
 },paperLifecycleAcceptance:(campaignId,input,actor)=>
  store.acceptStaticPaperLifecycleOperation(campaignId,input,actor),
 paperOperationReplay:(campaignId,input,kinds)=>store.acceptedOperationReplay(campaignId,input,kinds),
 paperRetainWorkerReady:()=>store.paperOperationWorkerReady()});
server.listen(Number(COMMAND_PORT),'127.0.0.1',()=>process.stdout.write('COMMAND_SERVER_READY\n'));
const close=()=>{server.close(()=>{void Promise.all([store.close(),dashboard.end()]).then(()=>process.exit(0));});};
process.once('SIGTERM',close);process.once('SIGINT',close);
