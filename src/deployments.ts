import {once} from 'node:events';
import {z} from 'zod';
import {DeploymentStore} from './deployments/store.js';
import {DeploymentConflict} from './deployments/store.js';
import {createDeploymentCommandServer} from './deployments/server.js';
import {buildIndicativePaperOpenPreview,readCanonicalPaperOpenFrame,readCanonicalPaperNextFrame,
 type PaperOpenFrame} from './deployments/paper-preview.js';
import {costIndicativePaperOpenPreview} from './deployments/paper-cost.js';
import {readCanonicalRangeKeeperPaperOpenModel,
 type RangeKeeperPaperDraft} from './deployments/rangekeeper-paper-open-model.js';
import {loadRangeKeeperPaperExitContext,rangeKeeperPaperExitContextSeed} from './deployments/rangekeeper-paper-context.js';
import {buildRangeKeeperPaperExitModel} from './deployments/rangekeeper-paper-exit-model.js';
import {verifyCanonicalPaperAnchors} from './deployments/paper-canonical-anchors.js';
import {createRobinhoodClient} from './client.js';
import {log} from './logger.js';

const envSchema=z.object({
 DATABASE_URL:z.string().min(1),
 DEPLOYMENT_OPERATOR_PASSWORD_HASH:z.string().min(1),
 DEPLOYMENT_HOST:z.enum(['127.0.0.1','::1']).default('127.0.0.1'),
 DEPLOYMENT_PORT:z.coerce.number().int().min(1).max(65535).default(4174),
 ROBINHOOD_READ_HTTP_URL:z.url(),
 DEPLOYMENT_RPC_TIMEOUT_MS:z.coerce.number().int().min(1000).max(30000).default(12000),
});

async function main(){
 const env=envSchema.parse(process.env);
 const store=new DeploymentStore(env.DATABASE_URL);
 try{await store.assertReady();}
 catch(error){await store.close();throw error;}
 const host=env.DEPLOYMENT_HOST,port=env.DEPLOYMENT_PORT;
 const origin=`http://${host==='::1'?'[::1]':host}:${port}`;
 const client=createRobinhoodClient(env.ROBINHOOD_READ_HTTP_URL,env.DEPLOYMENT_RPC_TIMEOUT_MS);
 let previewBusy=false;
 const paperPreview=async(campaignId:string,kind:'open'|'close_retain'|'close_convert')=>{
  if(previewBusy)throw new DeploymentConflict('paper_preview_busy');
  previewBusy=true;
  try{
   if(kind!=='open'){
    const strategyId=await store.paperStrategyId(campaignId);
    if(strategyId!=='rangekeeper_v1')return {status:'unavailable',
     reason:strategyId==='static_manual_v1'?'static_manual_paper_terminal_preview_unavailable':
      'paper_terminal_preview_strategy_unavailable',campaignId,actionAvailable:false};
    const snapshot=await store.rangeKeeperPaperExitContextSnapshot(campaignId),
     seed=rangeKeeperPaperExitContextSeed(snapshot,campaignId);
    if(!seed)return {status:'unavailable',reason:'rangekeeper_persisted_context_unavailable',
     campaignId,actionAvailable:false};
    let buildId='';
    try{
     const identity=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'null') as unknown;
     if(identity&&typeof identity==='object'&&typeof (identity as {buildId?:unknown}).buildId==='string')
      buildId=(identity as {buildId:string}).buildId;
    }catch{/* Missing or malformed release identity leaves the preview unavailable. */}
    if(!buildId)return {status:'unavailable',reason:'rangekeeper_runtime_build_identity_unavailable',
     campaignId,actionAvailable:false};
    let frame:PaperOpenFrame;
    try{frame=await readCanonicalPaperNextFrame(client,seed.profile,
     {sourceBlock:seed.previousSource.block,sourceHash:seed.previousSource.hash});}
    catch{return {status:'unavailable',reason:'rangekeeper_canonical_exit_source_unavailable',
     campaignId,actionAvailable:false};}
    try{await verifyCanonicalPaperAnchors(client,seed.profile.pool.chainId,
     [seed.openSource,seed.previousSource,frame.source]);}
    catch{return {status:'unavailable',reason:'rangekeeper_persisted_source_not_canonical',
     campaignId,actionAvailable:false};}
    const contextNow=Date.now(),context=await loadRangeKeeperPaperExitContext({campaignId,buildId,frame,
     now:contextNow,
     readSnapshot:async()=>snapshot,readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(
      query.poolAddress,query.pathVersion,query.sizeBand)});
    if(context.status!=='available')return context;
    const exitKind=kind==='close_retain'?'retain':'convert';
    let marketGasPriceWei:bigint|null=null,marketGasPriceObservedAt:number|null=null;
    try{marketGasPriceWei=await client.getGasPrice();marketGasPriceObservedAt=Date.now();}
    catch{/* The builder returns a blocked model with explicit gas evidence unavailable. */}
    const now=Date.now();
    return buildRangeKeeperPaperExitModel({client,draft:context.draft,
     openModel:context.openModel,openMarkId:context.openMarkId,previous:context.previous,
     kernel:context.kernel,readGasProfiles:context.readGasProfiles,buildId,exitKind,frame,now,
     marketGasPriceWei,marketGasPriceObservedAt,
     // This preview must stay blocked until the owned-fork stage runner is wired.
     simulate:async()=>false});
   }
   const draft=await store.paperDraft(campaignId);
   if(draft.strategyId==='rangekeeper_v1'){
    let buildId='';
    try{
     const identity=JSON.parse(process.env.CONC_LIQ_RUNTIME_IDENTITY??'null') as unknown;
     if(identity&&typeof identity==='object'&&
      typeof (identity as {buildId?:unknown}).buildId==='string')
      buildId=(identity as {buildId:string}).buildId;
    }catch{/* Missing or malformed release identity leaves the preview unavailable. */}
    return readCanonicalRangeKeeperPaperOpenModel({client,
     draft:draft as RangeKeeperPaperDraft,buildId,
     readGasProfiles:query=>store.rangeKeeperPaperGasProfiles(query.poolAddress,
      query.pathVersion,query.sizeBand)});
   }
   const frame=await readCanonicalPaperOpenFrame(client,draft.profile);
   const preview=buildIndicativePaperOpenPreview(draft,frame);
   if(preview.status!=='indicative')return preview;
   const rows=await store.paperGasProfiles(draft.profile.pool.pool);
   let gasPriceWei=0n;
   if(rows.length)try{gasPriceWei=await client.getGasPrice();}catch{/* explicit unavailable cost below */}
   return costIndicativePaperOpenPreview(preview,rows,draft.profile.pool.pool,
    frame.nativePrice??0n,gasPriceWei);
  }finally{previewBusy=false;}
 };
 const server=createDeploymentCommandServer(store,{origin,passwordHash:env.DEPLOYMENT_OPERATOR_PASSWORD_HASH,paperPreview});
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
