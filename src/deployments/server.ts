import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {resolve} from 'node:path';
import {z,ZodError} from 'zod';
import {acceptInput,draftInput,STRATEGY_IDS,type AcceptInput,type DraftInput} from './contracts.js';
import {DeploymentConflict} from './store.js';
import {paperSetupPreflightInput,type PaperSetupPreflightInput} from './paper-setup-preflight.js';
import {staticPaperDraftAdmissionInputSchema} from './static-paper-draft-admission.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionInput=z.object({}).strict();
const paperPreviewInput=z.object({kind:z.enum([
 'open','pause','resume','close_retain','close_convert'])}).strict();
const SESSION_SECONDS=4*60*60;
const BODY_BYTES=16*1024;

export interface CommandServerOptions {origin:string;publicOrigin?:string;now?:()=>number;
 paperPreview?:(campaignId:string,kind:'open'|'pause'|'resume'|'close_retain'|'close_convert')=>Promise<unknown>;
 paperSetupPreflight?:(input:PaperSetupPreflightInput)=>Promise<unknown>;
 paperSetupDraftAdmission?:(input:unknown)=>Promise<unknown>;
 paperSetupDraftList?:()=>Promise<unknown>;
 dashboardRead?:(path:string)=>Promise<unknown>;
 paperOpenAcceptance?:(campaignId:string,input:AcceptInput,actor:string)=>Promise<unknown>;
 paperRetainAcceptance?:(campaignId:string,input:AcceptInput,actor:string)=>Promise<unknown>;
 paperConvertAcceptance?:(campaignId:string,input:AcceptInput,actor:string)=>Promise<unknown>;
 paperConvertPreparationReady?:(campaignId:string)=>Promise<boolean>;
 paperLifecycleAcceptance?:(campaignId:string,input:AcceptInput,actor:string)=>Promise<unknown>;
 paperOperationReplay?:(campaignId:string,input:AcceptInput,
  allowedKinds:readonly ('open'|'pause'|'resume'|'close_retain'|'close_convert')[])=>Promise<unknown|null>;
 paperRetainWorkerReady?:()=>Promise<boolean>}
interface Session {csrf:string;expires:number;secure:boolean}
export interface CommandStore {
 createDraft(input:DraftInput):Promise<unknown>;
 acceptOperation(campaignId:string,input:AcceptInput,actor:string):Promise<unknown>;
 operation(id:string):Promise<unknown|null>;
 listMarketProfiles():Promise<unknown>;
}

function send(response:ServerResponse,status:number,body:unknown){
 const json=JSON.stringify(body);
 response.statusCode=status;
 response.setHeader('Cache-Control','no-store');
 response.setHeader('Content-Type','application/json; charset=utf-8');
 response.setHeader('Content-Length',Buffer.byteLength(json));
 response.end(json);
}
function harden(response:ServerResponse){
 response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
 response.setHeader('Referrer-Policy','no-referrer');
 response.setHeader('X-Content-Type-Options','nosniff');
 response.setHeader('X-Frame-Options','DENY');
}
const OPERATOR_ASSETS=new Map<string,{file:string;contentType:string}>([
 ['/operator',{file:'index.html',contentType:'text/html; charset=utf-8'}],
 ['/operator/',{file:'index.html',contentType:'text/html; charset=utf-8'}],
 ['/app.js',{file:'app.js',contentType:'text/javascript; charset=utf-8'}],
 ['/deployment-actions.js',{file:'deployment-actions.js',contentType:'text/javascript; charset=utf-8'}],
 ['/tabs.js',{file:'tabs.js',contentType:'text/javascript; charset=utf-8'}],
 ['/operator-session.js',{file:'operator-session.js',contentType:'text/javascript; charset=utf-8'}],
 ['/research.js',{file:'research.js',contentType:'text/javascript; charset=utf-8'}],
 ['/styles.css',{file:'styles.css',contentType:'text/css; charset=utf-8'}],
 ['/research.css',{file:'research.css',contentType:'text/css; charset=utf-8'}],
]);
async function sendOperatorAsset(request:IncomingMessage,response:ServerResponse,
 asset:{file:string;contentType:string}){
 const body=await readFile(resolve(process.cwd(),'dashboard',asset.file));
 response.statusCode=200;response.setHeader('Cache-Control','no-cache');
 response.setHeader('Content-Type',asset.contentType);response.setHeader('Content-Length',body.byteLength);
 response.end(request.method==='HEAD'?undefined:body);
}
async function jsonBody(request:IncomingMessage){
 if(request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')
  throw new DeploymentConflict('json_content_type_required');
 const declared=Number(request.headers['content-length']);
 if(Number.isFinite(declared)&&declared>BODY_BYTES)throw new DeploymentConflict('request_too_large');
 let size=0;const chunks:Buffer[]=[];
 for await(const chunk of request){
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);
  size+=bytes.length;if(size>BODY_BYTES)throw new DeploymentConflict('request_too_large');
  chunks.push(bytes);
 }
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}
 catch{throw new DeploymentConflict('invalid_json');}
}
const tokenKey=(token:string)=>createHash('sha256').update(token).digest('hex');
const cookie=(request:IncomingMessage)=>{
 const parts=(request.headers.cookie??'').split(';').map(part=>part.trim());
 const entry=parts.find(part=>part.startsWith('cq_session='));
 return entry?.slice('cq_session='.length)??null;
};

/** Separate loopback command surface; it never loads a signer or executes DDL. */
export function createDeploymentCommandServer(store:CommandStore,
 options:CommandServerOptions){
 const origin=new URL(options.origin);
 if(origin.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(origin.hostname)||origin.pathname!=='/'||origin.search||origin.hash)
  throw Error('Command API must bind to an explicit loopback origin');
 if(options.publicOrigin!==undefined){
  const external=new URL(options.publicOrigin);
  if(external.protocol!=='https:'||external.origin!==options.publicOrigin)
   throw Error('Public operator origin must be an exact HTTPS origin');
 }
 const now=options.now??Date.now;
 const sessions=new Map<string,Session>();
 // Trust only explicit configuration, never proxy-supplied forwarding headers.
 const sameOrigin=(request:IncomingMessage)=>request.headers.origin===options.origin||
  (options.publicOrigin!==undefined&&request.headers.origin===options.publicOrigin);
 const authenticated=(request:IncomingMessage)=>{
  const token=cookie(request);
  if(!token||!/^[0-9a-f]{64}$/.test(token))return null;
  const key=tokenKey(token),session=sessions.get(key);
  if(!session)return null;
  if(session.expires<=now()){sessions.delete(key);return null;}
  return {key,session};
 };
 return createServer(async(request,response)=>{
  harden(response);
  try{
   const path=new URL(request.url??'/',options.origin).pathname;
   if((request.method==='GET'||request.method==='HEAD')&&OPERATOR_ASSETS.has(path)){
    const asset=OPERATOR_ASSETS.get(path)!;
    if(path==='/operator'||path==='/operator/')
     response.setHeader('Content-Security-Policy',"default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
    await sendOperatorAsset(request,response,asset);return;
   }
   if(request.method==='GET'&&(path==='/api/research'||path==='/api/dashboard'||
    path==='/api/positions'||
    /^\/api\/positions\/(paper-[1-9]\d*|paper-adaptive-[a-z0-9.]+|(paper|live)-dep-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|live-(rk-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(path))){
    const query=new URL(request.url??'/',options.origin).searchParams;
    const hours=query.get('hours')??'24';
    const positionsPath=path==='/api/positions'||path.startsWith('/api/positions/');
    if((positionsPath&&(query.size>1||![1,6,24,168].includes(Number(hours))))||
     (!positionsPath&&query.size>0)){
     send(response,400,{error:'invalid_position_request'});return;
    }
    if(!options.dashboardRead){send(response,503,{error:'dashboard_read_source_unavailable'});return;}
    try{
     const result=await options.dashboardRead(path+(query.size?`?${query.toString()}`:''));
     send(response,result===null?404:200,result??{error:'position_not_found'});
    }
    catch{send(response,503,{error:'dashboard_read_source_unavailable'});}
    return;
   }
   if(path==='/healthz'&&request.method==='GET'){send(response,200,{status:'ok'});return;}
   if(request.method==='POST'||request.method==='DELETE'){
    if(!sameOrigin(request)){send(response,403,{error:'origin_mismatch'});return;}
   }
   if(path==='/api/session'&&request.method==='POST'){
    sessionInput.parse(await jsonBody(request));
    // This is an automatic CSRF handshake, not an access-control boundary.
    // Reuse the browser session so opening another tab preserves its token.
    const existing=authenticated(request);
    if(existing){
     send(response,200,{csrfToken:existing.session.csrf,
      expiresInSeconds:Math.max(0,Math.floor((existing.session.expires-now())/1000))});return;
    }
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    if(sessions.size>=32)sessions.delete(sessions.keys().next().value!);
    const secure=request.headers.origin===options.publicOrigin;
    sessions.set(tokenKey(token),{csrf,expires:now()+SESSION_SECONDS*1000,secure});
    response.setHeader('Set-Cookie',`cq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${secure?'; Secure':''}`);
    send(response,200,{csrfToken:csrf,expiresInSeconds:SESSION_SECONDS});return;
   }
   const auth=authenticated(request);
   if(!auth){send(response,401,{error:'authentication_required'});return;}
   if(request.method==='POST'||request.method==='DELETE'){
    if(request.headers['x-csrf-token']!==auth.session.csrf){send(response,403,{error:'csrf_mismatch'});return;}
   }
   if(path==='/api/session'&&request.method==='DELETE'){
    sessions.delete(auth.key);
    response.setHeader('Set-Cookie',`cq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${auth.session.secure?'; Secure':''}`);
    send(response,200,{status:'logged_out'});return;
   }
   if(path==='/api/strategies'&&request.method==='GET'){
    // This advertises installed paper support; worker readiness is checked
    // independently when previews and operations are requested.
    const staticPaperAvailable=Boolean(options.paperPreview&&options.paperSetupPreflight&&
     options.paperSetupDraftAdmission&&options.paperSetupDraftList&&options.paperOpenAcceptance&&
     options.paperRetainAcceptance&&options.paperLifecycleAcceptance&&options.paperOperationReplay&&
     options.paperRetainWorkerReady);
    send(response,200,{strategies:STRATEGY_IDS.map(id=>({id,version:'1.0.0',
     paper:id==='static_manual_v1'&&staticPaperAvailable,live:false}))});return;
   }
   if(path==='/api/market-profiles'&&request.method==='GET'){
    send(response,200,{profiles:await store.listMarketProfiles()});return;
   }
   if(path==='/api/deployments/setup-drafts'&&request.method==='GET'){
    if(!options.paperSetupDraftList){send(response,503,{error:'paper_setup_draft_list_unavailable'});return;}
    try{send(response,200,{drafts:await options.paperSetupDraftList()});}
    catch{send(response,503,{error:'paper_setup_draft_list_unavailable'});}
    return;
   }
   if(path==='/api/deployments/setup-preflight'&&request.method==='POST'){
    const input=paperSetupPreflightInput.parse(await jsonBody(request));
    if(!options.paperSetupPreflight){send(response,503,{error:'paper_setup_preflight_unavailable'});return;}
    send(response,200,await options.paperSetupPreflight(input));return;
   }
   if(path==='/api/deployments/setup-drafts'&&request.method==='POST'){
    if(!options.paperSetupDraftAdmission){send(response,503,{error:'paper_setup_draft_admission_unavailable'});return;}
    const input=staticPaperDraftAdmissionInputSchema.parse(await jsonBody(request));
    const result=await options.paperSetupDraftAdmission(input) as {status?:string;replayed?:boolean;
     missing?:string[];retrySafe?:boolean};
    if(result.status==='draft_created'){
     send(response,result.replayed?200:201,result);return;
    }
    if(result.status==='request_conflict'){
     send(response,409,{error:'draft_request_id_conflict',...result});return;
    }
    if(result.status==='reconciliation_required'){
     send(response,503,{error:'draft_creation_reconciliation_required',...result});return;
    }
    const reason=result.missing?.[0]??'paper_setup_draft_unavailable';
    const stale=['setup_review_binding_stale','setup_review_evidence_expired',
     'setup_cost_evidence_changed_since_review','setup_gas_price_exceeds_reviewed_bound',
     'setup_review_cache_miss','registered_profile_changed_since_preflight']
     .includes(reason);
    send(response,stale?409:422,{error:reason,...result});return;
   }
   if(path==='/api/deployments/drafts'&&request.method==='POST'){
    const input=draftInput.parse(await jsonBody(request));
    if(input.mode==='paper'&&input.strategyId==='static_manual_v1'){
     send(response,409,{error:'static_paper_setup_admission_required'});return;
    }
    const result=await store.createDraft(input);
    send(response,201,result);return;
   }
   const previewMatch=/^\/api\/deployments\/([^/]+)\/previews$/.exec(path);
   if(previewMatch&&request.method==='POST'){
    if(!uuid.test(previewMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    const input=paperPreviewInput.parse(await jsonBody(request));
    if(!options.paperPreview){send(response,503,{error:'paper_preview_unavailable'});return;}
    const result=await options.paperPreview(previewMatch[1]!,input.kind);
    const saved=result&&typeof result==='object'&&!Array.isArray(result)&&
     (result as {status?:unknown;kind?:unknown;trustedPreviewSaved?:unknown}).status==='indicative'&&
     (result as {kind?:unknown}).kind==='close_retain'&&
     (result as {trustedPreviewSaved?:unknown}).trustedPreviewSaved===true;
    let workerReady=false;
    if(saved&&input.kind==='close_retain'&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    const lifecycleId=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {id?:unknown}).id:null;
    const lifecycleExpiresAt=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {expiresAt?:unknown}).expiresAt:null;
    const lifecycleRevision=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {expectedRevision?:unknown}).expectedRevision:null;
    const lifecycleProposal=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {proposal?:unknown}).proposal:null;
    const lifecycleFrom=input.kind==='pause'?'active':'paused',
     lifecycleTo=input.kind==='pause'?'paused':'active';
    const lifecycleSaved=result&&typeof result==='object'&&!Array.isArray(result)&&
     (result as {status?:unknown;kind?:unknown;id?:unknown;contentDigest?:unknown;expiresAt?:unknown})
      .status==='indicative'&&['pause','resume'].includes(input.kind)&&
     (result as {kind?:unknown}).kind===input.kind&&
     typeof lifecycleId==='string'&&uuid.test(lifecycleId)&&
     Number.isSafeInteger(lifecycleRevision)&&Number(lifecycleRevision)>0&&
     /^[0-9a-f]{64}$/.test(String((result as {contentDigest?:unknown}).contentDigest))&&
     typeof lifecycleExpiresAt==='string'&&Number.isFinite(Date.parse(lifecycleExpiresAt))&&
     Date.parse(lifecycleExpiresAt)>Date.now()&&lifecycleProposal!==null&&
     typeof lifecycleProposal==='object'&&!Array.isArray(lifecycleProposal)&&
     Object.keys(lifecycleProposal).length===2&&
     (lifecycleProposal as Record<string,unknown>).from===lifecycleFrom&&
     (lifecycleProposal as Record<string,unknown>).to===lifecycleTo;
    if(lifecycleSaved&&options.paperLifecycleAcceptance&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    const openId=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {id?:unknown}).id:null;
    const openDigest=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {contentDigest?:unknown}).contentDigest:null;
    const openRevision=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {expectedRevision?:unknown}).expectedRevision:null;
    const openExpiry=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {expiresAt?:unknown}).expiresAt:null;
    const openExpiryMs=openExpiry instanceof Date?openExpiry.getTime():
     typeof openExpiry==='string'?Date.parse(openExpiry):Number.NaN;
    const openSource=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {source?:unknown}).source:null;
    const openModelHash=result&&typeof result==='object'&&!Array.isArray(result)?
     (result as {modelHash?:unknown}).modelHash:null;
    const openSourceRecord=openSource&&typeof openSource==='object'&&!Array.isArray(openSource)?
     openSource as {block?:unknown;hash?:unknown;timestamp?:unknown}:null;
    const openSourceFresh=Boolean(openSourceRecord&&
     typeof openSourceRecord.block==='string'&&/^(0|[1-9][0-9]*)$/.test(openSourceRecord.block)&&
     typeof openSourceRecord.hash==='string'&&/^0x[0-9a-f]{64}$/i.test(openSourceRecord.hash)&&
     Number.isSafeInteger(openSourceRecord.timestamp)&&Number(openSourceRecord.timestamp)>=0&&
     Number(openSourceRecord.timestamp)*1000<=now()&&
     now()-Number(openSourceRecord.timestamp)*1000<=180_000);
    const openSaved=result&&typeof result==='object'&&!Array.isArray(result)&&
     (result as {status?:unknown;kind?:unknown;trustedPreviewSaved?:unknown}).status==='indicative'&&
     (result as {kind?:unknown}).kind==='open'&&
     (result as {trustedPreviewSaved?:unknown}).trustedPreviewSaved===true&&
     typeof openId==='string'&&uuid.test(openId)&&typeof openDigest==='string'&&
     /^[0-9a-f]{64}$/.test(openDigest)&&Number.isSafeInteger(openRevision)&&Number(openRevision)>0&&
     Number.isFinite(openExpiryMs)&&openExpiryMs>now()&&
     openSourceFresh&&
     typeof openModelHash==='string'&&/^[0-9a-f]{64}$/.test(openModelHash);
    const convertModelRecord=result&&typeof result==='object'&&!Array.isArray(result)?
     result as {terminalModelVersion?:unknown;modelHash?:unknown;source?:unknown;costs?:unknown}:null;
    const convertSource=convertModelRecord?.source&&typeof convertModelRecord.source==='object'&&
     !Array.isArray(convertModelRecord.source)?convertModelRecord.source as
      {block?:unknown;hash?:unknown;timestamp?:unknown}:null;
    const convertSaved=result&&typeof result==='object'&&!Array.isArray(result)&&
     (result as {status?:unknown;kind?:unknown;trustedPreviewSaved?:unknown}).status==='indicative'&&
     (result as {kind?:unknown}).kind==='close_convert'&&
     (result as {trustedPreviewSaved?:unknown}).trustedPreviewSaved===true&&
     convertModelRecord?.terminalModelVersion===3&&
     typeof (result as {id?:unknown}).id==='string'&&uuid.test(String((result as {id?:unknown}).id))&&
     typeof (result as {contentDigest?:unknown}).contentDigest==='string'&&
     /^[0-9a-f]{64}$/.test(String((result as {contentDigest?:unknown}).contentDigest))&&
     Number.isSafeInteger((result as {expectedRevision?:unknown}).expectedRevision)&&
     Number((result as {expectedRevision?:unknown}).expectedRevision)>0&&
     typeof convertModelRecord?.modelHash==='string'&&/^[0-9a-f]{64}$/.test(convertModelRecord.modelHash)&&
     Boolean(convertSource&&typeof convertSource.block==='string'&&/^(0|[1-9][0-9]*)$/.test(convertSource.block)&&
      typeof convertSource.hash==='string'&&/^0x[0-9a-f]{64}$/i.test(convertSource.hash)&&
      Number.isSafeInteger(convertSource.timestamp)&&Number(convertSource.timestamp)*1000<=now()&&
      now()-Number(convertSource.timestamp)*1000<=180_000)&&
     Boolean(convertModelRecord?.costs&&typeof convertModelRecord.costs==='object'&&
      !Array.isArray(convertModelRecord.costs)&&
      (convertModelRecord.costs as {pathVersion?:unknown}).pathVersion===
       'paper_static_manual_close_convert_prestate_v1'&&
      (convertModelRecord.costs as {paidGasAvailable?:unknown}).paidGasAvailable===false);
    let convertPreparationReady=false;
    if(convertSaved&&options.paperConvertAcceptance&&options.paperRetainWorkerReady&&
     options.paperConvertPreparationReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
     if(workerReady){try{convertPreparationReady=await options.paperConvertPreparationReady(previewMatch[1]!);}
      catch{convertPreparationReady=false;}}
    }
    if(openSaved&&options.paperOpenAcceptance&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    const actionable=Boolean(saved&&input.kind==='close_retain'&&workerReady&&options.paperRetainAcceptance)||
     Boolean(openSaved&&workerReady&&options.paperOpenAcceptance)||
     Boolean(convertSaved&&input.kind==='close_convert'&&workerReady&&convertPreparationReady&&
      options.paperConvertAcceptance)||
     Boolean(lifecycleSaved&&workerReady&&options.paperLifecycleAcceptance);
    const body=result&&typeof result==='object'&&!Array.isArray(result)?
     {...result,actionAvailable:actionable,operationAcceptanceAvailable:actionable}:result;
    send(response,200,body);return;
   }
   const acceptMatch=/^\/api\/deployments\/([^/]+)\/operations$/.exec(path);
   if(acceptMatch&&request.method==='POST'){
    if(!uuid.test(acceptMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    const input=acceptInput.parse(await jsonBody(request));
    const replay=await options.paperOperationReplay?.(acceptMatch[1]!,input,['close_retain']);
    if(replay){send(response,202,replay);return;}
    let workerReady=false;
    if(options.paperRetainAcceptance&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    if(!workerReady||!options.paperRetainAcceptance){
     send(response,503,{error:'operation_worker_not_ready'});return;
    }
    send(response,202,await options.paperRetainAcceptance(acceptMatch[1]!,input,'operator'));return;
   }
   const lifecycleAcceptMatch=/^\/api\/deployments\/([^/]+)\/lifecycle-operations$/.exec(path);
   if(lifecycleAcceptMatch&&request.method==='POST'){
    if(!uuid.test(lifecycleAcceptMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    const input=acceptInput.parse(await jsonBody(request));
    const replay=await options.paperOperationReplay?.(lifecycleAcceptMatch[1]!,input,['pause','resume']);
    if(replay){send(response,202,replay);return;}
    let workerReady=false;
    if(options.paperLifecycleAcceptance&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    if(!workerReady||!options.paperLifecycleAcceptance){
     send(response,503,{error:'operation_worker_not_ready'});return;
    }
    send(response,202,await options.paperLifecycleAcceptance(lifecycleAcceptMatch[1]!,input,'operator'));return;
   }
   const openAcceptMatch=/^\/api\/deployments\/([^/]+)\/open-operations$/.exec(path);
   if(openAcceptMatch&&request.method==='POST'){
    if(!uuid.test(openAcceptMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    const input=acceptInput.parse(await jsonBody(request));
    const replay=await options.paperOperationReplay?.(openAcceptMatch[1]!,input,['open']);
    if(replay){send(response,202,replay);return;}
    let workerReady=false;
    if(options.paperOpenAcceptance&&options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    if(!workerReady||!options.paperOpenAcceptance){
     send(response,503,{error:'operation_worker_not_ready'});return;
    }
    send(response,202,await options.paperOpenAcceptance(openAcceptMatch[1]!,input,'operator'));return;
   }
   const convertAcceptMatch=/^\/api\/deployments\/([^/]+)\/close-convert-operations$/.exec(path);
   if(convertAcceptMatch&&request.method==='POST'){
    if(!uuid.test(convertAcceptMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    const input=acceptInput.parse(await jsonBody(request));
    const replay=await options.paperOperationReplay?.(convertAcceptMatch[1]!,input,['close_convert']);
    if(replay){send(response,202,replay);return;}
    if(!options.paperConvertAcceptance){send(response,503,{error:'paper_close_convert_acceptance_unavailable'});return;}
    let preparationReady=false;
    if(options.paperConvertPreparationReady){
     try{preparationReady=await options.paperConvertPreparationReady(convertAcceptMatch[1]!);}
     catch{preparationReady=false;}
    }
    if(!preparationReady){send(response,503,{error:'paper_close_convert_preparation_unavailable'});return;}
    let workerReady=false;
    if(options.paperRetainWorkerReady){
     try{workerReady=await options.paperRetainWorkerReady();}catch{workerReady=false;}
    }
    if(!workerReady){send(response,503,{error:'operation_worker_not_ready'});return;}
    send(response,202,await options.paperConvertAcceptance(convertAcceptMatch[1]!,input,'operator'));return;
   }
   const operationMatch=/^\/api\/operations\/([^/]+)$/.exec(path);
   if(operationMatch&&request.method==='GET'){
    if(!uuid.test(operationMatch[1]!)){send(response,400,{error:'invalid_operation_id'});return;}
    const result=await store.operation(operationMatch[1]!);
    send(response,result?200:404,result??{error:'operation_not_found'});return;
   }
   send(response,404,{error:'not_found'});
  }catch(error){
   if(response.headersSent){response.destroy();return;}
   if(error instanceof ZodError){send(response,400,{error:'invalid_request'});return;}
   if(error instanceof DeploymentConflict){
    const status=error.code==='request_too_large'?413:error.code==='json_content_type_required'?415:
     error.code==='invalid_json'?400:409;
    send(response,status,{error:error.code});return;
   }
   send(response,500,{error:'command_failed'});
  }
 });
}
