import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {z,ZodError} from 'zod';
import {draftInput,STRATEGY_IDS,type AcceptInput,type DraftInput} from './contracts.js';
import {DeploymentConflict} from './store.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loginInput=z.object({password:z.string().min(1).max(1024)}).strict();
const SESSION_SECONDS=4*60*60;
const BODY_BYTES=16*1024;

export interface CommandServerOptions {origin:string;passwordHash:string;now?:()=>number}
interface Session {csrf:string;expires:number}
export interface CommandStore {
 createDraft(input:DraftInput):Promise<unknown>;
 acceptOperation(campaignId:string,input:AcceptInput,actor:string):Promise<unknown>;
 operation(id:string):Promise<unknown|null>;
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
function passwordVerifier(encoded:string){
 const match=/^scrypt:([0-9a-f]{32,128}):([0-9a-f]{64})$/.exec(encoded);
 if(!match)throw Error('Invalid operator password hash configuration');
 const salt=Buffer.from(match[1]!,'hex'),expected=Buffer.from(match[2]!,'hex');
 return (password:string)=>timingSafeEqual(scryptSync(password,salt,expected.length),expected);
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
 const verify=passwordVerifier(options.passwordHash),now=options.now??Date.now;
 const sessions=new Map<string,Session>(),attempts=new Map<string,{count:number;reset:number}>();
 const sameOrigin=(request:IncomingMessage)=>request.headers.origin===options.origin;
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
   if(path==='/healthz'&&request.method==='GET'){send(response,200,{status:'ok'});return;}
   if(request.method==='POST'||request.method==='DELETE'){
    if(!sameOrigin(request)){send(response,403,{error:'origin_mismatch'});return;}
   }
   if(path==='/api/session'&&request.method==='POST'){
    const ip=request.socket.remoteAddress??'unknown',entry=attempts.get(ip);
    if(entry&&entry.reset>now()&&entry.count>=5){send(response,429,{error:'login_rate_limited'});return;}
    const {password}=loginInput.parse(await jsonBody(request));
    if(!verify(password)){
     const fresh=entry&&entry.reset>now()?entry:{count:0,reset:now()+15*60*1000};
     fresh.count++;attempts.set(ip,fresh);
     send(response,401,{error:'invalid_credentials'});return;
    }
    attempts.delete(ip);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    if(sessions.size>=32)sessions.delete(sessions.keys().next().value!);
    sessions.set(tokenKey(token),{csrf,expires:now()+SESSION_SECONDS*1000});
    response.setHeader('Set-Cookie',`cq_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`);
    send(response,200,{csrfToken:csrf,expiresInSeconds:SESSION_SECONDS});return;
   }
   const auth=authenticated(request);
   if(!auth){send(response,401,{error:'authentication_required'});return;}
   if(request.method==='POST'||request.method==='DELETE'){
    if(request.headers['x-csrf-token']!==auth.session.csrf){send(response,403,{error:'csrf_mismatch'});return;}
   }
   if(path==='/api/session'&&request.method==='DELETE'){
    sessions.delete(auth.key);
    response.setHeader('Set-Cookie','cq_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(response,200,{status:'logged_out'});return;
   }
   if(path==='/api/strategies'&&request.method==='GET'){
    send(response,200,{strategies:STRATEGY_IDS.map(id=>({id,version:'1.0.0',paper:false,live:false}))});return;
   }
   if(path==='/api/deployments/drafts'&&request.method==='POST'){
    const input=draftInput.parse(await jsonBody(request));
    const result=await store.createDraft(input);
    send(response,201,result);return;
   }
   const acceptMatch=/^\/api\/deployments\/([^/]+)\/operations$/.exec(path);
   if(acceptMatch&&request.method==='POST'){
    if(!uuid.test(acceptMatch[1]!)){send(response,400,{error:'invalid_campaign_id'});return;}
    // Fresh chain and cost preflight is not wired yet. A trusted preview in
    // storage alone must never make the incomplete worker path operable.
    send(response,503,{error:'operation_preflight_unavailable'});return;
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
