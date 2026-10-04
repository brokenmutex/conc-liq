import assert from 'node:assert/strict';
import {test} from 'node:test';
// @ts-expect-error untyped release helper shared with the sealed launcher
import {hash} from '../scripts/release-files.mjs';
import {RUNTIME_ENDPOINT_ENV_KEYS,runtimeEnvConfigHash,verifyRuntimeEndpointEnvChange} from '../src/deployments/store.js';

const env={DATABASE_URL:'postgresql://x/conc_liq',DEPLOYMENT_PORT:'4174',
 ROBINHOOD_READ_HTTP_URL:'https://provider.example/v2/key',PAPER_FORK_RPC_URL:'https://provider.example/v2/key'};
const launcherDigest=(e:Record<string,string>)=>hash(JSON.stringify(Object.fromEntries(
 Object.entries(e).sort(([a],[b])=>a.localeCompare(b,'en')))));

test('runtime env config hash matches the sealed launcher digest',()=>{
 assert.equal(runtimeEnvConfigHash(env),launcherDigest(env));
 assert.equal(runtimeEnvConfigHash({b:'2',a:'1'}),runtimeEnvConfigHash({a:'1',b:'2'}));
});

test('an endpoint-only change is recorded by key name only',()=>{
 const to={...env,ROBINHOOD_READ_HTTP_URL:'http://10.0.0.7:8547',PAPER_FORK_RPC_URL:'http://10.0.0.7:8547'};
 const change=verifyRuntimeEndpointEnvChange(runtimeEnvConfigHash(env),runtimeEnvConfigHash(to),{fromEnv:env,toEnv:to});
 assert.deepEqual(change,{schemaVersion:1,kind:'runtime_endpoint_env_change_v1',
  changedKeys:['PAPER_FORK_RPC_URL','ROBINHOOD_READ_HTTP_URL'],fromConfigHash:runtimeEnvConfigHash(env),
  toConfigHash:runtimeEnvConfigHash(to)});
 assert(!JSON.stringify(change).includes('10.0.0.7'));
 assert.deepEqual([...RUNTIME_ENDPOINT_ENV_KEYS].sort(),['PAPER_FORK_RPC_URL','ROBINHOOD_READ_HTTP_URL']);
});

test('every other env change, mismatched hash or non-http endpoint is refused',()=>{
 const check=(to:Record<string,string>,from:Record<string,string>=env,fromHash=runtimeEnvConfigHash(env))=>
  verifyRuntimeEndpointEnvChange(fromHash,runtimeEnvConfigHash(to),{fromEnv:from,toEnv:to});
 assert.equal(check({...env,DEPLOYMENT_PORT:'4175'}),null);
 assert.equal(check({...env,ROBINHOOD_READ_HTTP_URL:'http://a',DEPLOYMENT_PORT:'4175'}),null);
 assert.equal(check({...env,DEPLOYMENT_RPC_TIMEOUT_MS:'12000'}),null);
 const {PAPER_FORK_RPC_URL:_,...withoutFork}=env;
 assert.equal(check(env,withoutFork,runtimeEnvConfigHash(withoutFork)),null,'an added endpoint key stays bound');
 assert.equal(check({...env,PAPER_FORK_RPC_URL:'file:///etc/passwd'}),null);
 assert.equal(check({...env,PAPER_FORK_RPC_URL:'not a url'}),null);
 assert.equal(check(env),null,'no change is not an endpoint change');
 assert.equal(check({...env,PAPER_FORK_RPC_URL:'http://a'},env,'0'.repeat(64)),null,'predecessor hash must reproduce');
 assert.equal(verifyRuntimeEndpointEnvChange(runtimeEnvConfigHash(env),runtimeEnvConfigHash(env),undefined),null);
});
