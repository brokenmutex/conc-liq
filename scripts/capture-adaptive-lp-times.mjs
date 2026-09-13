// Read-only metadata enrichment. Verifies every returned header against the
// already frozen event hash; never writes the production database.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
const [envPath,source,output]=process.argv.slice(2);assert(envPath&&source&&output&&!existsSync(output));
const hash=x=>createHash('sha256').update(x).digest('hex'),known=new Set(),history=JSON.parse(readFileSync(source+'/history-screen.json'));
for(const p of history.pages){const raw=readFileSync(source+`/history-private/${p.from}-${p.toExclusive}.json.gz`);assert.equal(hash(raw),p.sha256);for(const b of JSON.parse(gunzipSync(raw)).blocks)known.add(Number(b.number));}
const missing=new Map(),sources={};
for(const s of ['AAPL','GOOGL']){
 const path=source+`/replay-source-${s}.json.gz`,raw=readFileSync(path);assert.equal(hash(raw),readFileSync(path+'.sha256','utf8').trim());sources[s]=hash(raw);
 for(const e of JSON.parse(gunzipSync(raw)).events)if(!known.has(Number(e.block))){if(missing.has(e.block))assert.equal(missing.get(e.block),e.hash);missing.set(e.block,e.hash);}
}
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const blocks=[];
async function request(body){await gate.assertBulkAllowed();let r;try{r=await fetch(cfg.rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch{throw new Error('Header transport failed');}assert(r.ok,'Header HTTP failure');return r.json();}
try{
 const chain=await request({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});assert.equal(BigInt(chain.result),4663n);
 const entries=[...missing].sort((a,b)=>Number(a[0])-Number(b[0]));
 for(let i=0;i<entries.length;i+=25){
  const batch=entries.slice(i,i+25),response=await request(batch.map(([n],j)=>({jsonrpc:'2.0',id:j,method:'eth_getBlockByNumber',params:['0x'+BigInt(n).toString(16),false]})));
  assert(Array.isArray(response)&&response.length===batch.length,'Invalid header batch');
  const seen=new Set();for(const row of response){assert(Number.isInteger(row.id)&&row.id>=0&&row.id<batch.length&&!seen.has(row.id));seen.add(row.id);
   const [n,h]=batch[row.id],b=row.result;assert(b&&!row.error);assert.equal(BigInt(b.number),BigInt(n));assert.equal(b.hash.toLowerCase(),h.toLowerCase());
   blocks.push({number:Number(n),hash:b.hash,timestamp:String(BigInt(b.timestamp))});
  }
  if(i%250===0)console.log(JSON.stringify({captured:blocks.length,total:entries.length}));
 }
 const raw=JSON.stringify({scope:'canonical_header_timestamp_enrichment',sources,blocks,capturedAt:new Date().toISOString()})+'\n';writeFileSync(output,raw);writeFileSync(output+'.sha256',hash(raw)+'\n');console.log(JSON.stringify({completed:blocks.length,sha256:hash(raw)}));
}finally{await gate.close();}
