import assert from 'node:assert/strict';
import {test} from 'node:test';
// Browser module is intentionally plain JavaScript and has no TypeScript declarations.
// @ts-expect-error JavaScript browser module has no declaration file.
import {mountPaperLifecycleAction,mountStaticRetainAction,mountPendingPaperAcceptanceRecovery} from '../dashboard/deployment-actions.js';

const campaignId='67b2b303-e821-4450-bb7b-27171b12079f';
const operationId='da00e8f8-35e5-455f-8e5b-8b13a7f5fadb';
const previewId='18a77044-72c3-471d-91cf-099324233830';
const digest='a'.repeat(64);
const storageKey=(kind:string)=>`concliq.operator.paper-action.pending.v1.${campaignId}.${kind}`;

class ElementMock {
 type='';className='';textContent='';disabled=false;hidden=false;title='';attributes:Record<string,string>={};dataset:Record<string,string>={};
 children:ElementMock[]=[];handlers:Record<string,(event:unknown)=>unknown>={};
 append(...items:ElementMock[]){this.children.push(...items);}
 replaceChildren(...items:ElementMock[]){this.children=[...items];}
 addEventListener(name:string,handler:(event:unknown)=>unknown){this.handlers[name]=handler;}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 click(){if(this.disabled||this.hidden)return;return this.handlers.click?.({preventDefault(){}});}
}
function find(root:ElementMock,predicate:(element:ElementMock)=>boolean):ElementMock|undefined{
 if(predicate(root))return root;
 for(const child of root.children){const found=find(child,predicate);if(found)return found;}
 return undefined;
}
const button=(root:ElementMock,text:string)=>find(root,item=>item.type==='button'&&item.textContent===text);
function error(status:number,code:string){return Object.assign(new Error(code),{status,data:{error:code}});}
async function withBrowser<T>(work:()=>Promise<T>){
 const global=globalThis as any,original={document:global.document,location:global.location,
  localStorage:global.localStorage,setTimeout:global.setTimeout};
 const storage=new Map<string,string>();
 global.document={createElement:()=>new ElementMock()};global.location={pathname:'/operator'};
 global.localStorage={get length(){return storage.size;},key:(index:number)=>[...storage.keys()][index]??null,
  getItem:(key:string)=>storage.get(key)??null,
  setItem:(key:string,value:string)=>{storage.set(key,String(value));},
  removeItem:(key:string)=>{storage.delete(key);}};
 global.setTimeout=((callback:()=>void)=>{queueMicrotask(callback);return 0;}) as typeof setTimeout;
 try{return await work();}
 finally{for(const [name,value] of Object.entries(original)){if(value===undefined)delete global[name];else global[name]=value;}}
}
function mount(kind:'close_retain'|'pause'|'resume',request:(path:string,options?:any)=>Promise<any>){
 const root=new ElementMock(),props={campaignId,authenticated:()=>true,request};
 if(kind==='close_retain')mountStaticRetainAction(root,props);
 else mountPaperLifecycleAction(root,{...props,kind});
 return root;
}
const preview=(kind:'close_retain'|'pause'|'resume')=>({id:previewId,kind,status:'indicative',
 actionAvailable:true,operationAcceptanceAvailable:true,contentDigest:digest,expectedRevision:2,
 expiresAt:new Date(Date.now()+60_000).toISOString(),retainedLowerBound:{token0Raw:'10',token1Raw:'20'},
 proposal:{from:kind==='pause'?'active':'paused',to:kind==='pause'?'paused':'active'}});

test('retain-close saves before POST and replays the same payload after remount',async()=>withBrowser(async()=>{
 let posted:any=null,storedBeforePost=false,previewCalls=0;
 const firstRequest=async(path:string,options:any={})=>{
  if(path.endsWith('/previews')){previewCalls++;return preview('close_retain');}
  if(path.endsWith('/operations')){posted=options.body;storedBeforePost=Boolean((globalThis as any).localStorage.getItem(storageKey('close_retain')));
   throw error(502,'gateway_timeout');}
  throw new Error(`unexpected path ${path}`);
 };
 const first=mount('close_retain',firstRequest);
 await button(first,'Review retain-close')?.click();
 await button(first,'Accept retain-close')?.click();
 assert.equal(storedBeforePost,true);assert.equal(previewCalls,1);
 assert.match(first.children.find(element=>element.className==='retain-action-status')?.textContent??'',/outcome is unknown/);
 const saved=JSON.parse((globalThis as any).localStorage.getItem(storageKey('close_retain')));
 assert.deepEqual(saved,{campaignId,kind:'close_retain',payload:posted});
 assert.equal(typeof posted.idempotencyKey,'string');

 const replayRequest=async(path:string,options:any={})=>{
  if(path.endsWith('/operations')){assert.deepEqual(options.body,posted);return {id:operationId,status:'queued'};}
  if(path===`/api/operations/${operationId}`)return {id:operationId,status:'succeeded',stage:'completed'};
  throw new Error(`unexpected path ${path}`);
 };
 const restored=mount('close_retain',replayRequest);
 assert.equal(button(restored,'Review retain-close')?.disabled,true);
 await button(restored,'Retry same acceptance / reconcile')?.click();
 assert.equal((globalThis as any).localStorage.getItem(storageKey('close_retain')),null);
}));

test('pause and resume recovery keeps exact keys for ambiguous errors and clears only proven conflict/readiness failures',async()=>withBrowser(async()=>{
 for(const kind of ['pause','resume'] as const){
  const actionName=kind==='pause'?'Pause':'Resume';
  let lastBody:any=null,storedBeforePost=false;
  const fresh=mount(kind,async(path,options:any={})=>{
   if(path.endsWith('/previews'))return preview(kind);
   assert(path.endsWith('/lifecycle-operations'));
   lastBody=options.body;storedBeforePost=Boolean((globalThis as any).localStorage.getItem(storageKey(kind)));
   throw error(502,'gateway_timeout');
  });
  await button(fresh,`Review ${kind}`)?.click();
  await button(fresh,`${actionName} management`)?.click();
  assert.equal(storedBeforePost,true);
  let saved=JSON.parse((globalThis as any).localStorage.getItem(storageKey(kind)));
  assert.deepEqual(saved,{campaignId,kind,payload:lastBody});
  const payload=saved.payload;

  const serviceUnavailable=mount(kind,async(path,options:any={})=>{
   assert(path.endsWith('/lifecycle-operations'));lastBody=options.body;throw error(503,'temporary_upstream_unavailable');
  });
  await button(serviceUnavailable,`Retry same ${kind} / reconcile`)?.click();
  assert.deepEqual(lastBody,payload);
  assert.notEqual((globalThis as any).localStorage.getItem(storageKey(kind)),null);
  assert.equal(button(serviceUnavailable,`Review ${kind}`)?.disabled,true);

  const throttled=mount(kind,async(_path,options:any={})=>{assert.deepEqual(options.body,payload);throw error(429,'rate_limited');});
  await button(throttled,`Retry same ${kind} / reconcile`)?.click();
  assert.notEqual((globalThis as any).localStorage.getItem(storageKey(kind)),null);

  const conflict=mount(kind,async(_path,options:any={})=>{assert.deepEqual(options.body,payload);throw error(409,'stale_preview');});
  await button(conflict,`Retry same ${kind} / reconcile`)?.click();
  assert.equal((globalThis as any).localStorage.getItem(storageKey(kind)),null);
  assert.equal(button(conflict,`Review ${kind}`)?.disabled,false);

  (globalThis as any).localStorage.setItem(storageKey(kind),JSON.stringify({campaignId,kind,payload}));
  const leaseFailure=mount(kind,async(_path,options:any={})=>{assert.deepEqual(options.body,payload);throw error(503,'operation_worker_not_ready');});
  await button(leaseFailure,`Retry same ${kind} / reconcile`)?.click();
  assert.equal((globalThis as any).localStorage.getItem(storageKey(kind)),null);
  assert.equal(button(leaseFailure,`Review ${kind}`)?.disabled,false);
 }
}));

test('malformed persisted action payload blocks a fresh preview instead of discarding recovery state',async()=>withBrowser(async()=>{
 (globalThis as any).localStorage.setItem(storageKey('pause'),'{invalid');
 let previewCalls=0;
 const root=mount('pause',async()=>{previewCalls++;return preview('pause');});
 assert.equal(button(root,'Review pause')?.disabled,true);
 assert.equal(button(root,'Retry same pause / reconcile')?.disabled,true);
 assert.match(root.children.find(element=>element.className==='retain-action-status')?.textContent??'',/recovery record is invalid/);
 await button(root,'Review pause')?.click();
 assert.equal(previewCalls,0);
}));

test('pending acceptance recovery remains available independently of lifecycle widgets',async()=>withBrowser(async()=>{
 const payload={previewId,contentDigest:digest,expectedRevision:2,idempotencyKey:operationId};
 const storage=(globalThis as any).localStorage;
 const records=[['pause',storageKey('pause'),'lifecycle-operations'],
  ['close_retain',storageKey('close_retain'),'operations'],
  ['close_convert',`concliq.operator.paper-convert.pending.v1.${campaignId}`,'close-convert-operations']];
 for(const [kind,key,suffix] of records){
  storage.setItem(key,JSON.stringify({campaignId,kind,payload,csrfToken:'must-not-send'}));
  let calls=0,accepted=0;
  const root=new ElementMock();
  mountPendingPaperAcceptanceRecovery(root,{authenticated:()=>true,
   request:async(path:string,options:any)=>{
    calls++;assert.equal(path,`/api/deployments/${campaignId}/${suffix}`);
    assert.deepEqual(options,{method:'POST',body:payload});
    return {id:operationId,status:'succeeded',replayed:true};
   },onAccepted:async()=>{accepted++;}});
  assert.equal(root.hidden,false);
  await button(root,'Reconcile saved acceptance')?.click();
  assert.equal(calls,1);assert.equal(accepted,1);assert.equal(storage.getItem(key),null);
 }
}));

test('recovery panel preserves unknown outcomes and never clears a replaced recovery key',async()=>withBrowser(async()=>{
 const payload={previewId,contentDigest:digest,expectedRevision:2,idempotencyKey:operationId},
  storage=(globalThis as any).localStorage,key=storageKey('pause');
 storage.setItem(key,JSON.stringify({campaignId,kind:'pause',payload}));
 const root=new ElementMock();
 mountPendingPaperAcceptanceRecovery(root,{authenticated:()=>true,request:async()=>{throw error(502,'gateway_timeout');}});
 await button(root,'Reconcile saved acceptance')?.click();
 assert.deepEqual(JSON.parse(storage.getItem(key)).payload,payload);
 const replaced={...payload,idempotencyKey:previewId};
 const remount=new ElementMock();
 mountPendingPaperAcceptanceRecovery(remount,{authenticated:()=>true,request:async()=>{
  storage.setItem(key,JSON.stringify({campaignId,kind:'pause',payload:replaced}));
  return {id:operationId,status:'succeeded'};
 }});
 await button(remount,'Reconcile saved acceptance')?.click();
 assert.deepEqual(JSON.parse(storage.getItem(key)).payload,replaced);
 (globalThis as any).location.pathname='/';
 const publicRoot=new ElementMock();
 mountPendingPaperAcceptanceRecovery(publicRoot,{authenticated:()=>true,request:async()=>{throw Error('public command');}});
 assert.equal(publicRoot.hidden,true);assert.equal(publicRoot.children.length,0);
}));
