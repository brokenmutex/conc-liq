// Independent-provider spot check using previously frozen HyperSync pages.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
export function verifyUniverseSources(root){
 const read=p=>JSON.parse(readFileSync(p)),hash=x=>createHash('sha256').update(x).digest('hex'),old='data/asset-expansion-2026-09-13',proof=read(old+'/cross-provider-verification.json'),meta=read(root+'/capture.json'),done=read(root+'/completed.json');
 assert.equal(hash(readFileSync(root+'/capture.json')),done.captureSha256);
 const byPool=new Map(meta.assets.map(a=>[a.pool,a.symbol])),expected=new Map(),ranges=[],sourceHashes={},counts=Object.fromEntries(meta.assets.map(a=>[a.symbol,0]));
 for(const p of proof.rows){const path=old+'/history-narrow/'+p.page,raw=readFileSync(path);assert.equal(hash(raw),p.hypersyncSha256);sourceHashes[path]=hash(raw);const d=JSON.parse(gunzipSync(raw)),[from,to]=p.page.split('.json')[0].split('-').map(Number);ranges.push({from,to});const blocks=new Map(d.blocks.map(b=>[Number(b.number),b]));
  for(const l of d.logs){if(!byPool.has(l.address.toLowerCase()))continue;const block=Number(l.block_number),b=blocks.get(block);assert(b);const key=[l.address.toLowerCase(),block,Number(l.transaction_index),Number(l.log_index)].join(':');assert(!expected.has(key));expected.set(key,{blockHash:b.hash,transactionHash:l.transaction_hash,data:l.data,topics:[l.topic0,l.topic1,l.topic2,l.topic3].filter(Boolean),at:Number(BigInt(b.timestamp))*1000});}
 }
 const matched=[];
 for(const p of done.pages){if(!ranges.some(r=>p.from<r.to&&p.toExclusive>r.from))continue;const raw=readFileSync(root+'/'+p.file);assert.equal(hash(raw),p.sha256);for(const e of JSON.parse(gunzipSync(raw)).events){if(e.name!=='Swap'||!ranges.some(r=>Number(e.block)>=r.from&&Number(e.block)<r.to))continue;const key=[e.pool,Number(e.block),e.tx,e.log].join(':'),x=expected.get(key);assert(x,'Canonical swap missing from independent provider');assert.equal(e.hash,x.blockHash);assert.equal(e.transactionHash,x.transactionHash);assert.equal(e.rawData,x.data);assert.deepEqual(e.rawTopics,x.topics);assert.equal(e.at,x.at);expected.delete(key);counts[e.symbol]++;}matched.push({file:p.file,sha256:p.sha256});}
 assert.equal(expected.size,0,'Independent provider swap absent from canonical capture');assert(Object.values(counts).every(n=>n>0),'No independent-provider swaps for some assets');
 const result={captureSha256:done.captureSha256,independentProvider:'Previously frozen HyperSync raw logs and block headers',matchedSwaps:Object.values(counts).reduce((a,b)=>a+b,0),bySymbol:counts,ranges,sourceHashes,matchedCapturePages:matched,scope:'Exact transaction/log identity, raw amounts/topics, block hash and timestamp spot check. Nine source pages, not an independent provider replay of the full period.'};writeFileSync(root+'/source-verification.json',JSON.stringify(result,null,2)+'\n');return result;
}
if(process.argv[1]?.endsWith('/verify-adaptive-lp-universe-source.mjs'))console.log(JSON.stringify(verifyUniverseSources(process.argv[2])));
