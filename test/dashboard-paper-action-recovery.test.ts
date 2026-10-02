import assert from 'node:assert/strict';
import {test} from 'node:test';
// Browser module is intentionally plain JavaScript and has no TypeScript declarations.
// @ts-expect-error JavaScript browser module has no declaration file.
import {mountPaperLifecycleAction,mountStaticConvertAction,mountPaperConvertAction,mountStaticRetainAction,mountPendingPaperAcceptanceRecovery} from '../dashboard/deployment-actions.js';

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
function mount(kind:'close_retain'|'pause'|'resume',request:(path:string,options?:any)=>Promise<any>,strategyId='static_manual_v1'){
 const root=new ElementMock(),props={campaignId,authenticated:()=>true,request};
 if(kind==='close_retain')mountStaticRetainAction(root,{...props,strategyId});
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

test('retain and convert reviews have distinct accessible identities and state their different outcomes',async()=>withBrowser(async()=>{
 const retainRoot=new ElementMock(),convertRoot=new ElementMock(),positionLabel='AAPL / USDG · Paper campaign';
 const retainPreview={...preview('close_retain'),retainedLowerBound:{token0Raw:'10',token1Raw:'20'}};
 const convertPreview={id:previewId,kind:'close_convert',terminalModelVersion:3,status:'indicative',
  trustedPreviewSaved:true,actionAvailable:true,operationAcceptanceAvailable:true,contentDigest:digest,
  modelHash:'b'.repeat(64),expectedRevision:2,expiresAt:new Date(Date.now()+60_000).toISOString(),
  paidCostsAvailable:false,feeAccrualAvailable:false,costs:{status:'provisional',scope:'candidate_prestate_gas_only',
   pathVersion:'paper_static_manual_close_convert_prestate_v1',paidGasAvailable:false},
  quote:{inputAmountRaw:'100',minimumOutputRaw:'90',expectedOutputRaw:'95'}};
 // Each action has its own handler because both preview routes share a URL.
 mountStaticRetainAction(retainRoot,{campaignId,positionLabel,authenticated:()=>true,
  request:async(path:string,options:any={})=>path.endsWith('/previews')?retainPreview:null});
 mountStaticConvertAction(convertRoot,{campaignId,positionLabel,authenticated:()=>true,
  request:async(path:string,options:any={})=>path.endsWith('/previews')?convertPreview:null});
 assert.equal(retainRoot.attributes['aria-label'],`Close ${positionLabel} · retain token balances`);
 assert.equal(convertRoot.attributes['aria-label'],`Close ${positionLabel} · convert tokens to USDG`);
 assert.equal(button(retainRoot,'Review retain-close')?.attributes['aria-label'],
  `Review close · retain ${positionLabel} token balances`);
 assert.equal(button(convertRoot,'Review convert-close')?.attributes['aria-label'],
  `Review close · convert ${positionLabel} tokens to USDG`);
 assert.match(retainRoot.children.find(item=>item.className==='retain-action-status')?.textContent??'',/retain the position token balances.*no USDG swap/i);
 assert.match(convertRoot.children.find(item=>item.className==='convert-action-status')?.textContent??'',/convert the position tokens to USDG.*will not be retained/i);
 await button(retainRoot,'Review retain-close')?.click();
 await button(convertRoot,'Review convert-close')?.click();
 const retainReview=find(retainRoot,item=>item.className==='retain-action-review');
 const convertReview=find(convertRoot,item=>item.className==='convert-action-review');
 assert.ok(retainReview&&!retainReview.hidden);assert.ok(convertReview&&!convertReview.hidden);
 assert.match(retainReview.children.map(item=>item.textContent).join(' '),/keeps the token balances in their current assets/i);
 assert.match(retainReview.children.map(item=>item.textContent).join(' '),/does not swap them into USDG/i);
 assert.match(convertReview.children.map(item=>item.textContent).join(' '),/swapping the position tokens into USDG/i);
 assert.match(convertReview.children.map(item=>item.textContent).join(' '),/does not retain the token balances/i);
 assert.match(retainReview.children[0]?.textContent??'',/AAPL \/ USDG · Paper campaign · Close · retain token balances/);
 assert.match(convertReview.children[0]?.textContent??'',/AAPL \/ USDG · Paper campaign · Close · convert tokens to USDG/);
 assert.ok(button(retainRoot,'Accept retain-close')?.className==='retain-confirm-button');
 assert.ok(button(convertRoot,'Confirm close · convert to USDG')?.className==='convert-confirm-button');
 assert.equal(button(retainRoot,'Accept retain-close')?.attributes['aria-label'],
  `Confirm close · retain ${positionLabel} token balances`);
 assert.equal(button(convertRoot,'Confirm close · convert to USDG')?.attributes['aria-label'],
  `Confirm close · convert ${positionLabel} tokens to USDG`);
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

test('RangeKeeper retain-close routes acceptance and lost-response recovery through its strategy endpoint after preview expiry',async()=>withBrowser(async()=>{
 const key=storageKey('close_retain');let posted:any=null;
 const rkPreview={...preview('close_retain'),kind:'rangekeeper_paper_exit_model',
  strategyId:'rangekeeper_v1',exitKind:'retain',trustedPreviewSaved:true,
  position:{retainedLowerBound0:'30',retainedLowerBound1:'40'},
  costs:{expectedGasUnits:'100',boundGasUnits:'150',expectedValue:'1000000000000000000',boundValue:'2000000000000000000'}};
 rkPreview.expiresAt=new Date(Date.now()+60_000).toISOString();
 const root=mount('close_retain',async(path,options={})=>{
  if(path.endsWith('/previews'))return rkPreview;
  posted={path,payload:options.body};throw error(502,'gateway_timeout');
 },'rangekeeper_v1');
 await button(root,'Review retain-close')?.click();
 assert.equal(button(root,'Accept retain-close')?.disabled,false,
  'a saved RangeKeeper retain-exit model with a complete acceptance binding must be actionable');
 const facts=find(root,item=>item.className==='retain-preview-facts');
 assert.match(facts?.children.map(item=>item.children.map(child=>child.textContent).join(' ')).join(' ')??'',/30|150/);
 await button(root,'Accept retain-close')?.click();
 assert.equal(posted.path,`/api/deployments/${campaignId}/rangekeeper/close-operations`);
 const saved=JSON.parse((globalThis as any).localStorage.getItem(key));
 assert.equal(saved.strategyId,'rangekeeper_v1');assert.deepEqual(saved.payload,posted.payload);
 rkPreview.expiresAt=new Date(Date.now()-1).toISOString();
 const recovery=new ElementMock();let replayPath='';
 mountPendingPaperAcceptanceRecovery(recovery,{authenticated:()=>true,request:async(path:string,options:any)=>{
  replayPath=path;assert.deepEqual(options.body,posted.payload);return {id:operationId,status:'queued'};
 }});
 await button(recovery,'Reconcile saved acceptance')?.click();
 assert.equal(replayPath,`/api/deployments/${campaignId}/rangekeeper/close-operations`);
 assert.equal((globalThis as any).localStorage.getItem(key),null);
}));

test('RangeKeeper Exit · convert to USDG renders its quote and recovers the exact strategy acceptance',async()=>withBrowser(async()=>{
 const key=`concliq.operator.paper-convert.pending.v1.${campaignId}`,previewModel:any={
  id:previewId,kind:'rangekeeper_paper_exit_model',status:'indicative',strategyId:'rangekeeper_v1',
  exitKind:'convert',trustedPreviewSaved:true,actionAvailable:true,operationAcceptanceAvailable:true,
  contentDigest:digest,modelHash:'b'.repeat(64),expectedRevision:2,
  expiresAt:new Date(Date.now()+60_000).toISOString(),conversion:{
   pathVersion:'rangekeeper_paper_direct_convert_exit_v1',inputToken:1,outputToken:0,
   inputAmount:'1000',expectedOutput:'950',minimumOutput:'900',expectedProceedsValue:'950000000000000000',
   minimumProceedsValue:'900000000000000000',feeValue:'1000000000000000',
   shortfallValue:'2000000000000000',quoteHash:'c'.repeat(64)},
  costs:{status:'provisional',kind:'convert',scope:'range_keeper_terminal_exit_gas_only',
   evidenceClass:'fork_estimated',pathVersion:'rangekeeper-paper-convert-exit-v1',
   expectedGasUnits:'100',boundGasUnits:'150',expectedWei:'1000',boundWei:'1500',
   expectedValue:'1000000000000000',boundValue:'2000000000000000',unavailable:[]}};
 let posted:any=null;
 const root=new ElementMock();
 mountPaperConvertAction(root,{campaignId,strategyId:'rangekeeper_v1',positionLabel:'AAPL / USDG · RK',
  authenticated:()=>true,request:async(path:string,options:any={})=>{
   if(path.endsWith('/previews'))return previewModel;
   posted={path,payload:options.body};throw error(502,'gateway_timeout');
  }});
 await button(root,'Review exit · convert to USDG')?.click();
 const review=find(root,item=>item.className==='convert-action-review');
 assert.ok(review&&!review.hidden);
 const facts=review.children.find(item=>item.className==='retain-preview-facts');
 const rendered=facts?.children.map(item=>item.children.map(child=>child.textContent).join(' ')).join(' ')??'';
 assert.match(rendered,/minimum output.*900/i);assert.match(rendered,/expected proceeds.*0\.950000/i);
 assert.match(rendered,/fork estimated, not paid/);assert.match(rendered,/Earned fees, paid gas and final net value\s+Unavailable/);
 assert.equal(button(root,'Confirm exit · convert to USDG')?.disabled,false);
 await button(root,'Confirm exit · convert to USDG')?.click();
 assert.equal(posted.path,`/api/deployments/${campaignId}/rangekeeper/close-operations`);
 const saved=JSON.parse((globalThis as any).localStorage.getItem(key));
 assert.equal(saved.strategyId,'rangekeeper_v1');assert.equal(saved.kind,'close_convert');
 assert.deepEqual(saved.payload,posted.payload);
 previewModel.expiresAt=new Date(Date.now()-1).toISOString();
 const recovery=new ElementMock();let replayPath='';
 mountPendingPaperAcceptanceRecovery(recovery,{authenticated:()=>true,request:async(path:string,options:any)=>{
  replayPath=path;assert.deepEqual(options.body,posted.payload);return {id:operationId,status:'queued'};
 }});
 await button(recovery,'Reconcile saved acceptance')?.click();
 assert.equal(replayPath,`/api/deployments/${campaignId}/rangekeeper/close-operations`);
 assert.equal((globalThis as any).localStorage.getItem(key),null);
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

test('a reconcile refused before any acceptance clears its saved record',async()=>withBrowser(async()=>{
 // These are returned after the route's idempotent replay lookup and before it
 // calls an acceptance, so no operation was created and none exists to find.
 // Treating them as unknown left a convert record that could never be cleared.
 const payload={previewId,contentDigest:digest,expectedRevision:2,idempotencyKey:operationId};
 const storage=(globalThis as any).localStorage;
 const cases:[string,number,string][]=[
  [`concliq.operator.paper-convert.pending.v1.${campaignId}`,503,'paper_close_convert_preparation_unavailable'],
  [`concliq.operator.paper-convert.pending.v1.${campaignId}`,503,'paper_close_convert_acceptance_unavailable'],
  [storageKey('pause'),503,'operation_worker_not_ready'],
  [storageKey('close_retain'),409,'campaign_not_found'],
 ];
 for(const [key,status,code] of cases){
  const kind=key.includes('paper-convert')?'close_convert':key.endsWith('pause')?'pause':'close_retain';
  storage.setItem(key,JSON.stringify({campaignId,kind,payload}));
  const root=new ElementMock();
  mountPendingPaperAcceptanceRecovery(root,{authenticated:()=>true,
   request:async()=>{throw error(status,code);}});
  await button(root,'Reconcile saved acceptance')?.click();
  assert.equal(storage.getItem(key),null,`${code} must clear the saved record`);
 }
 // A refusal that leaves the outcome genuinely unknown must still be retained.
 const key=storageKey('pause');
 storage.setItem(key,JSON.stringify({campaignId,kind:'pause',payload}));
 const kept=new ElementMock();
 mountPendingPaperAcceptanceRecovery(kept,{authenticated:()=>true,
  request:async()=>{throw error(503,'dashboard_read_source_unavailable');}});
 await button(kept,'Reconcile saved acceptance')?.click();
 assert.deepEqual(JSON.parse(storage.getItem(key)).payload,payload);
}));

test('an unreadable saved record can be discarded without sending a request',async()=>withBrowser(async()=>{
 const storage=(globalThis as any).localStorage,key=storageKey('close_retain');
 storage.setItem(key,'{not valid json');
 let calls=0;
 const root=new ElementMock();
 mountPendingPaperAcceptanceRecovery(root,{authenticated:()=>true,
  request:async()=>{calls++;return {id:operationId,status:'succeeded'};}});
 assert.equal(root.hidden,false);
 assert.equal(button(root,'Reconcile saved acceptance'),undefined,
  'an unreadable record has no request to replay, so reconciling must not be offered');
 const discard=button(root,'Discard unreadable record');
 assert(discard&&discard.disabled===false);
 assert.match(find(root,item=>item.textContent.includes('unreadable'))?.textContent??'',
  /cannot be reconciled\. Check Positions/);
 discard.click();
 assert.equal(calls,0,'discarding must never submit an acceptance');
 assert.equal(storage.getItem(key),null);
 assert.equal(root.hidden,true);
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
