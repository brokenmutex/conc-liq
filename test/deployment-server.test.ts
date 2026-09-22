import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import {it} from 'node:test';
import {createDeploymentCommandServer} from '../src/deployments/server.js';

it('command API requires operator session, exact origin and CSRF before a draft is stored',async()=>{
 const salt=randomBytes(16),password='test-only-operator-secret';
 const hash=`scrypt:${salt.toString('hex')}:${scryptSync(password,salt,32).toString('hex')}`;
 const origin='http://127.0.0.1:4174';
 const calls:unknown[]=[];
 const store={
  async createDraft(input:unknown){calls.push(input);return {id:'67b2b303-e821-4450-bb7b-27171b12079f',revision:1};},
  async acceptOperation(){throw Error('not expected');},
  async operation(){return null;},
 };
 const server=createDeploymentCommandServer(store, {origin,passwordHash:hash});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address&&typeof address!=='string');
 const url=`http://127.0.0.1:${address.port}`;
 const post=(path:string,body:unknown,headers:Record<string,string>={})=>fetch(url+path,{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(url+'/api/strategies')).status,401);
  assert.equal((await post('/api/session',{password})).status,403);
  assert.equal((await post('/api/session',{password:'wrong'},{origin})).status,401);
  const login=await post('/api/session',{password},{origin});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie);
  const {csrfToken}=await login.json() as {csrfToken:string};
  const draft={mode:'paper',chainId:4663,wallet:'0x1111111111111111111111111111111111111111',
   marketProfileId:'aef5f51e-18ef-4e9c-952d-8d772970f708',strategyId:'static_manual_v1',
   strategyVersion:'1.0.0',stateSchemaVersion:1,
   allocation:{token0Raw:'0',token1Raw:'250000000',nativeWei:'0'},
   config:{tickLower:-20,tickUpper:20}};
  assert.equal((await post('/api/deployments/drafts',draft,{origin,cookie})).status,403);
  assert.equal((await post('/api/deployments/drafts',{...draft,strategyId:'adaptive_v1'},
   {origin,cookie,'x-csrf-token':csrfToken})).status,400);
  assert.equal((await post('/api/deployments/drafts',{...draft,config:{...draft.config,signer:'secret'}},
   {origin,cookie,'x-csrf-token':csrfToken})).status,400);
  const created=await post('/api/deployments/drafts',draft,{origin,cookie,'x-csrf-token':csrfToken});
  assert.equal(created.status,201);assert.equal(calls.length,1);
  const catalog=await fetch(url+'/api/strategies',{headers:{cookie}});
  assert.equal(catalog.status,200);
  const body=await catalog.json() as {strategies:{id:string;paper:boolean;live:boolean}[]};
  assert.deepEqual(body.strategies.map(s=>s.id),['static_manual_v1','rangekeeper_v1']);
  assert(body.strategies.every(s=>s.paper===false&&s.live===false));
  const logout=await fetch(url+'/api/session',{method:'DELETE',headers:{origin,cookie,'x-csrf-token':csrfToken}});
  assert.equal(logout.status,200);
  assert.equal((await fetch(url+'/api/strategies',{headers:{cookie}})).status,401);
 }finally{server.close();await once(server,'close');}
});
