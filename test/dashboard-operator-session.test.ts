import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error JavaScript browser module has no declaration file.
import {createOperatorSession} from '../dashboard/operator-session.js';

function response(status:number,data:unknown){return {ok:status>=200&&status<300,status,json:async()=>data};}

test('operator bootstrap is empty, same-origin, and deduplicated',async()=>{
 const calls:any[]=[];
 const session=createOperatorSession({fetchImpl:async(path:string,options:any)=>{
  calls.push({path,options});return response(200,{csrfToken:'csrf-a',expiresInSeconds:14_400});
 }});
 assert.deepEqual(await Promise.all([session.bootstrap(),session.bootstrap()]),[true,true]);
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/session');
 assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body,'{}');
 assert.equal(calls[0].options.credentials,'same-origin');assert.equal(session.isReady(),true);
});

test('forced reconnect performs a fresh command-session handshake',async()=>{
 const calls:string[]=[];let available=true;
 const session=createOperatorSession({fetchImpl:async(path:string)=>{
  calls.push(path);
  if(!available)return response(503,{error:'command_unavailable'});
  return response(200,{csrfToken:`csrf-${calls.length}`,expiresInSeconds:14_400});
 }});
 await session.bootstrap();
 assert.deepEqual(calls,['/api/session']);
 available=false;
 await assert.rejects(session.bootstrap({force:true}),{status:503});
 assert.deepEqual(calls,['/api/session','/api/session']);
 assert.equal(session.isReady(),false,'a failed forced check must not leave operator controls enabled');
 available=true;
 await session.bootstrap({force:true});
 assert.deepEqual(calls,['/api/session','/api/session','/api/session']);
 assert.equal(session.isReady(),true);
});

test('explicit 401 renews once and retries the exact original body and idempotency key',async()=>{
 const calls:any[]=[];let sessionCount=0,operationCount=0;
 const payload={requestId:'3f178b18-d942-40c9-9723-498795285f44',idempotencyKey:'5c1f91f5-d99b-42c9-a66a-038a7ac0c02b',amount:'250'};
 const originalBody=JSON.stringify(payload);
 const session=createOperatorSession({fetchImpl:async(path:string,options:any)=>{
  calls.push({path,options});
  if(path==='/api/session'){
   sessionCount++;
   return response(200,{csrfToken:`csrf-${sessionCount}`,expiresInSeconds:14_400});
  }
  operationCount++;
  if(operationCount===1){payload.amount='999';return response(401,{error:'operator_session_expired'});}
  return response(200,{status:'accepted'});
 }});
 await session.bootstrap();
 const result=await session.request('/api/operation',{method:'POST',body:payload,csrf:true});
 assert.deepEqual(result,{status:'accepted'});
 const operationCalls=calls.filter(call=>call.path==='/api/operation');
 assert.equal(operationCalls.length,2);
 assert.equal(operationCalls[0].options.body,originalBody);
 assert.equal(operationCalls[1].options.body,originalBody);
 assert.equal(operationCalls[0].options.headers['x-csrf-token'],'csrf-1');
 assert.equal(operationCalls[1].options.headers['x-csrf-token'],'csrf-2');
 assert.equal(sessionCount,2);assert.equal(operationCount,2);assert.equal(session.isReady(),true);
});

test('only 401 retries and a second 401 ends the session without another retry',async()=>{
 for(const status of [403,500]){
  let sessions=0,requests=0;
  const session=createOperatorSession({fetchImpl:async(path:string)=>{
   if(path==='/api/session'){sessions++;return response(200,{csrfToken:'csrf',expiresInSeconds:14_400});}
   requests++;return response(status,{error:'rejected'});
  }});
  await session.bootstrap();
  await assert.rejects(session.request('/api/protected',{method:'POST',body:{key:'same'},csrf:true}));
  assert.equal(sessions,1);assert.equal(requests,1);
 }
 let sessions=0,requests=0;
 const session=createOperatorSession({fetchImpl:async(path:string)=>{
  if(path==='/api/session'){sessions++;return response(200,{csrfToken:`csrf-${sessions}`,expiresInSeconds:14_400});}
  requests++;return response(401,{error:'operator_session_expired'});
 }});
 await session.bootstrap();
 await assert.rejects(session.request('/api/protected',{method:'POST',body:{key:'same'},csrf:true}),{status:401});
 assert.equal(sessions,2);assert.equal(requests,2);assert.equal(session.isReady(),false);
});
