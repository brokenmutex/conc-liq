import assert from 'node:assert/strict';
import {test} from 'node:test';
// Browser module is intentionally plain JavaScript and has no TypeScript declarations.
// @ts-expect-error JavaScript browser module has no declaration file.
import {liveConvertAcceptPayload,liveConvertAcceptResult,liveConvertOperationPathFor,liveConvertPreviewCanBeAccepted,liveConvertPreviewPathFor,liveConvertStorageKey,mountLiveConvertAction} from '../dashboard/deployment-actions.js';

const campaignId='67b2b303-e821-4450-bb7b-27171b12079f';
const previewId='18a77044-72c3-471d-91cf-099324233830';
const jobId='da00e8f8-35e5-455f-8e5b-8b13a7f5fadb';
const digest='a'.repeat(64);

class ElementMock {
 type='';className='';textContent='';disabled=false;hidden=false;attributes:Record<string,string>={};children:ElementMock[]=[];
 handlers:Record<string,(event:unknown)=>unknown>={};
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
const byText=(root:ElementMock,text:string)=>find(root,item=>item.type==='button'&&item.textContent===text);
const statusOf=(root:ElementMock)=>find(root,item=>item.className==='convert-action-status')!.textContent;
const factsText=(root:ElementMock)=>find(root,item=>item.className==='retain-preview-facts')?.children.map(item=>item.children.map(c=>c.textContent).join(' ')).join(' | ')??'';
function failure(status:number,code:string){return Object.assign(new Error(code),{status,data:{error:code}});}
async function withBrowser<T>(work:(storage:Map<string,string>)=>Promise<T>,pathname='/operator'){
 const global=globalThis as any,original={document:global.document,location:global.location,localStorage:global.localStorage};
 const storage=new Map<string,string>();
 global.document={createElement:()=>new ElementMock()};global.location={pathname};
 global.localStorage={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},
  removeItem:(key:string)=>{storage.delete(key);}};
 try{return await work(storage);}
 finally{for(const [name,value] of Object.entries(original)){if(value===undefined)delete global[name];else global[name]=value;}}
}
const now=Date.now();
const convertPreview=(over:Record<string,unknown>={},conversion:Record<string,unknown>={})=>({kind:'rangekeeper_live_convert_preview',mode:'live',strategyId:'rangekeeper_v1',
 status:'indicative',trustedPreviewSaved:true,previewId,contentDigest:digest,expectedRevision:1,expiresAt:new Date(now+60_000).toISOString(),
 source:{block:'78211393',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(now/1000)-10},position:{tokenId:'77'},
 costs:{status:'estimated',gasWei:'12345',gasValueUsdX18:'3000000000000000',actionCostValue:'700000000000000000',
  conversion:{mode:'convert',swapRequired:true,withdrawn0:'30000000',withdrawn1:'250000000000000000',maxSlippageBps:50,quoteIndex:0,decimals0:6,decimals1:18,
   token:1,amountIn:'250000000000000000',minOut:'80000000',expectedOut:'80400000',feeValue:'40000000000000000',shortfallValue:'400000000000000000',
   route:{kind:'direct_exact_input_single',fee:500},...conversion}},
 missing:[],actionAvailable:true,operationAcceptanceAvailable:true,executionEligible:false,liveWorker:{ready:true,missing:[]},...over});

test('a live convert review is acceptable only while it is a fresh, saved, server-frozen convert preview with conversion evidence',()=>{
 assert.equal(liveConvertPreviewCanBeAccepted(convertPreview(),now),true);
 assert.equal(liveConvertPreviewCanBeAccepted(convertPreview({kind:'rangekeeper_live_retain_preview'}),now),false,'a retain review is not a convert review');
 for(const over of [{status:'unavailable'},{trustedPreviewSaved:false},{previewId:'x'},{contentDigest:'abc'},{expectedRevision:0},{executionEligible:true},
  {actionAvailable:false},{operationAcceptanceAvailable:false},{mode:'paper'},{strategyId:'static_manual_v1'},{expiresAt:new Date(now-1).toISOString()},
  {source:{block:'1',hash:`0x${'b'.repeat(64)}`,timestamp:Math.floor(now/1000)-600}},{source:null},{costs:{status:'provisional'}},{costs:null}])
  assert.equal(liveConvertPreviewCanBeAccepted(convertPreview(over),now),false,JSON.stringify(over));
 for(const conversion of [{mode:'retain'},{swapRequired:undefined},{amountIn:'0'},{minOut:'0'},{expectedOut:'1'},{token:2},{shortfallValue:undefined},{withdrawn0:'x'}])
  assert.equal(liveConvertPreviewCanBeAccepted(convertPreview({},conversion),now),false,JSON.stringify(conversion));
 assert.equal(liveConvertPreviewCanBeAccepted(convertPreview({},{swapRequired:false,amountIn:undefined,minOut:undefined,expectedOut:undefined,token:undefined,
  shortfallValue:'0',feeValue:'0'}),now),true,'a withdraw-only convert is acceptable');
 assert.deepEqual(liveConvertAcceptPayload(convertPreview(),'40000000-0000-4000-8000-000000000001',now),
  {previewId,contentDigest:digest,expectedRevision:1,idempotencyKey:'40000000-0000-4000-8000-000000000001'});
 assert.equal(liveConvertAcceptPayload(convertPreview({status:'unavailable'}),'40000000-0000-4000-8000-000000000001',now),null);
 assert.equal(liveConvertAcceptPayload(convertPreview(),'not-a-uuid',now),null);
 assert.equal(liveConvertPreviewPathFor(campaignId),`/api/deployments/${campaignId}/live/convert-preview`);
 assert.equal(liveConvertOperationPathFor(campaignId),`/api/deployments/${campaignId}/live/convert-operations`);
 assert.equal(liveConvertPreviewPathFor('../x'),null);assert.equal(liveConvertOperationPathFor('nope'),null);
 assert.equal(liveConvertAcceptResult({status:'queued',campaignId,jobId,replayed:false},campaignId),true);
 assert.equal(liveConvertAcceptResult({status:'queued',campaignId:jobId,jobId,replayed:false},campaignId),false);
 assert.equal(liveConvertAcceptResult({status:'unavailable',campaignId,jobId,replayed:false},campaignId),false);
});

test('the live exit command reviews, shows the withdraw and sale to USDG, saves the key before posting and queues once',async()=>withBrowser(async storage=>{
 const root=new ElementMock();const captured:{post:any}={post:null};let previewBody:unknown=null,storedBeforePost=false,accepted=0;
 mountLiveConvertAction(root,{campaignId,positionLabel:'GOOGL / USDG · campaign',authenticated:()=>true,now:()=>now,onAccepted:async()=>{accepted++;},
  request:async(path:string,options:any={})=>{
   if(path.endsWith('/live/convert-preview')){previewBody=options.body;assert.equal(options.csrf,true);return convertPreview();}
   if(path.endsWith('/live/convert-operations')){captured.post={path,body:options.body,csrf:options.csrf};
    storedBeforePost=storage.has(liveConvertStorageKey(campaignId));return {status:'queued',campaignId,jobId,replayed:false,executionEligible:false};}
   throw new Error(`unexpected path ${path}`);}});
 const review=byText(root,'Review exit · withdraw and convert to USDG')!;
 assert.equal(review.disabled,false);assert.match(root.attributes['aria-label']!,/withdraw and convert to USDG/);
 await review.click();
 assert.deepEqual(previewBody,{});
 const facts=factsText(root);
 assert.match(facts,/Withdraw estimate · token 0 \/ token 1 30\.000000 \/ 0\.250000/);
 assert.match(facts,/Sell · non-USDG leg 0\.250000/);
 assert.match(facts,/Receive USDG · expected 80\.400000/);
 assert.match(facts,/minimum \(50 bps slippage limit\) 80\.000000/);
 assert.match(facts,/Shortfall vs independent reference · USD 0\.400000/);
 assert.match(facts,/Exit gas · estimated \/ not paid 12345 wei/);
 assert.match(facts,/Estimated total exit cost · USD 0\.700000/);
 assert.match(find(root,item=>item.className==='convert-action-consequence')!.textContent,/falls back to a retained close/);
 const confirm=byText(root,'Confirm exit · withdraw and convert to USDG')!;
 assert.equal(confirm.disabled,false);
 assert.equal(captured.post,null,'reviewing never submits anything');
 await confirm.click();
 const posted=captured.post as unknown as {path:string;body:Record<string,any>;csrf:boolean};
 assert.equal(storedBeforePost,true,'the durable same-request key is saved before the POST');
 assert.equal(posted.path,`/api/deployments/${campaignId}/live/convert-operations`);assert.equal(posted.csrf,true);
 assert.deepEqual(Object.keys(posted.body).sort(),['contentDigest','expectedRevision','idempotencyKey','previewId'],'the request carries no economics, wallet or calldata');
 assert.equal(posted.body.previewId,previewId);assert.equal(posted.body.contentDigest,digest);
 assert.equal(storage.has(liveConvertStorageKey(campaignId)),false,'the key is cleared once the server queued the exit');
 assert.match(statusOf(root),new RegExp(`Exit queued as job ${jobId}`));assert.match(statusOf(root),/falls back to a retained close/);
 assert.equal(accepted,1);assert.equal(confirm.disabled,true);assert.equal(review.disabled,true,'one review, one confirmation');
}));

test('an unknown outcome keeps the same request key for a retry and a refused admission clears it',async()=>withBrowser(async storage=>{
 let mode:'timeout'|'ok'|'stale'='timeout';const bodies:any[]=[];
 const request=async(path:string,options:any={})=>{
  if(path.endsWith('/live/convert-preview'))return convertPreview();
  bodies.push(options.body);
  if(mode==='timeout')throw failure(502,'gateway_timeout');
  if(mode==='stale')throw failure(409,'Convert exit could not be re-validated against a fresh canonical source');
  return {status:'queued',campaignId,jobId,replayed:true,executionEligible:false};
 };
 const root=new ElementMock();
 mountLiveConvertAction(root,{campaignId,authenticated:()=>true,now:()=>now,request});
 await byText(root,'Review exit · withdraw and convert to USDG')!.click();
 await byText(root,'Confirm exit · withdraw and convert to USDG')!.click();
 assert.match(statusOf(root),/outcome unknown \(gateway_timeout\)/);
 const saved=JSON.parse(storage.get(liveConvertStorageKey(campaignId))!);assert.equal(saved.campaignId,campaignId);
 // A remount (page reload) offers only the same-key retry; a fresh review is blocked until reconciled.
 const reloaded=new ElementMock();
 mountLiveConvertAction(reloaded,{campaignId,authenticated:()=>true,now:()=>now,request});
 assert.equal(byText(reloaded,'Review exit · withdraw and convert to USDG')!.disabled,true);
 const retry=byText(reloaded,'Retry same exit · convert to USDG')!;assert.equal(retry.hidden,false);
 mode='ok';await retry.click();
 assert.deepEqual(bodies[1],bodies[0],'the retry replays the exact saved payload');
 assert.equal(storage.has(liveConvertStorageKey(campaignId)),false);assert.match(statusOf(reloaded),/Exit queued as job/);
 // A server refusal (stale or conflicting) clears the key and asks for a fresh review.
 const fresh=new ElementMock();
 mountLiveConvertAction(fresh,{campaignId,authenticated:()=>true,now:()=>now,request});
 mode='stale';
 await byText(fresh,'Review exit · withdraw and convert to USDG')!.click();
 await byText(fresh,'Confirm exit · withdraw and convert to USDG')!.click();
 assert.match(statusOf(fresh),/Exit admission unavailable \(.*fresh canonical source\)\. No operation was accepted; request a fresh review/);
 assert.equal(storage.has(liveConvertStorageKey(campaignId)),false);
}));

test('the live exit command is closed when unauthenticated, ineligible, pending a retain, off the operator surface, or the review is unusable',async()=>{
 const noRequest=async()=>{throw new Error('must not call the server');};
 await withBrowser(async storage=>{
  let root=new ElementMock();mountLiveConvertAction(root,{campaignId,authenticated:()=>false,request:noRequest});
  assert.equal(byText(root,'Review exit · withdraw and convert to USDG')!.disabled,true);assert.match(statusOf(root),/Operator authentication is required/);
  root=new ElementMock();mountLiveConvertAction(root,{campaignId,authenticated:()=>true,canReview:false,request:noRequest});
  assert.equal(byText(root,'Review exit · withdraw and convert to USDG')!.disabled,true);assert.match(statusOf(root),/unavailable while the campaign has pending work/);
  storage.set(`concliq.operator.live-retain.pending.v1.${campaignId}`,'{}');
  root=new ElementMock();mountLiveConvertAction(root,{campaignId,authenticated:()=>true,request:noRequest});
  assert.equal(byText(root,'Review exit · withdraw and convert to USDG')!.disabled,true);assert.match(statusOf(root),/retain-close request may already be queued/);
  storage.clear();
  root=new ElementMock();mountLiveConvertAction(root,{campaignId:'not-a-uuid',authenticated:()=>true,request:noRequest});
  assert.equal(root.children.length,0,'an invalid campaign id mounts nothing');
  // An unusable or expired review never offers a confirmation.
  let posts=0;
  root=new ElementMock();
  mountLiveConvertAction(root,{campaignId,authenticated:()=>true,now:()=>now,request:async(path:string)=>{
   if(path.endsWith('/live/convert-operations')){posts++;return {};}
   return convertPreview({status:'unavailable',trustedPreviewSaved:false,missing:['Convert exit could not be priced'],actionAvailable:false});}});
  await byText(root,'Review exit · withdraw and convert to USDG')!.click();
  assert.match(statusOf(root),/Exit review unavailable: Convert exit could not be priced\. No operation was submitted\./);
  assert.equal(byText(root,'Confirm exit · withdraw and convert to USDG'),undefined);assert.equal(posts,0);
 });
 await withBrowser(async()=>{
  const root=new ElementMock();mountLiveConvertAction(root,{campaignId,authenticated:()=>true,request:noRequest});
  assert.equal(root.children.length,0,'nothing is mounted on the public dashboard');
 },'/');
});
