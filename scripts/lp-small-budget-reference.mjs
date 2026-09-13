import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {loadRiskConfig} from '../src/risk/config.ts';
import {ViemRiskChainReader} from '../src/risk/reader.ts';
import {collectRiskSnapshot} from '../src/risk/runner.ts';
import {evaluatePaperReference} from '../src/paper/reference.ts';
const [envPath,root]=process.argv.slice(2);assert(envPath&&root);
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),screen=JSON.parse(readFileSync(root+'/screen.json'));
const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const client=createRobinhoodClient(cfg.rpcUrl,20000,{beforeRequest:()=>gate.assertBulkAllowed().then(()=>{}),retryCount:0});
try{
 const symbols=[...new Set(screen.rows.filter(r=>r.capacityPass).map(r=>r.symbol))];
 const snapshot=await collectRiskSnapshot({blockNumber:BigInt(screen.anchor.block),config:loadRiskConfig({...e,RWA_SYMBOLS:symbols.join(',')}),reader:new ViemRiskChainReader(client)});
 const policy=JSON.parse(readFileSync('config/live-pilot-nvda-250.json')).strategy.referencePolicy;
 const tokens=JSON.parse(readFileSync('data/asset-expansion-2026-09-13/tokens.json')).tokens;
 const rows=screen.rows.filter(r=>r.capacityPass).map(r=>({symbol:r.symbol,pool:r.pool,fee:r.fee,reference:evaluatePaperReference({snapshot,policy,checkpoint:{block:screen.anchor.block,sqrtPriceX96:r.price,market:{symbol:r.symbol,pool:r.pool,rwa:r.rwa,fee:r.fee,tickSpacing:r.spacing,rwaDecimals:tokens.find(t=>t.address.toLowerCase()===r.rwa.toLowerCase()).decimals}}})}));
 assert.equal((await client.getBlock({blockNumber:BigInt(screen.anchor.block)})).hash,screen.anchor.hash);
 const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
 writeFileSync(root+'/risk-snapshot.json',json(snapshot),{flag:'wx'});writeFileSync(root+'/references.json',json({at:new Date().toISOString(),anchor:screen.anchor,policy,rows,executionEligible:false}),{flag:'wx'});
 console.log(JSON.stringify({rows:rows.length,passing:rows.filter(r=>r.reference.eligible).map(r=>r.symbol+'/'+r.fee)}));
}finally{await gate.close();}
