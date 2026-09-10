import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {ExperimentSource} from '../src/experiment/source.ts';
import {NitroPaperExecutor} from '../src/paper/executor.ts';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
import {sanitizeRiskError} from '../src/risk/evaluate.ts';

const [envPath,allocation,output]=process.argv.slice(2);
assert(envPath&&output&&Number(allocation)>0&&Number(allocation)<=1000000);
assert(!fs.existsSync(output));
Object.assign(process.env,parseEnv(fs.readFileSync(envPath,'utf8')));
const source=new ExperimentSource(process.env.DATABASE_URL),executor=new NitroPaperExecutor(process.env.DATABASE_URL);
const checkpoint=row=>({id:row.id,block:row.block,hash:row.hash,blockTimestamp:new Date(row.source_at).toISOString(),
 capturedAt:new Date(row.observed_at).toISOString(),tick:row.tick,sqrtPriceX96:row.price,liquidity:row.liquidity,
 feeGrowth0:row.global0,feeGrowth1:row.global1,targetSetHash:row.target_set_hash});
let intent,policy,cp;
try {
 await source.connect();
 const session=(await source.db.query('SELECT id::text,policy FROM paper_sessions ORDER BY id DESC LIMIT 1')).rows[0];
 policy={...session.policy,lpAllocationPpm:Number(allocation)};
 const latest=async()=>checkpoint((await source.checkpoints(new Date(Date.now()-300000).toISOString(),new Date().toISOString())).at(-1));
 cp=await latest();intent=await executor.quote(cp,policy);
 fs.writeFileSync(output+'.intent.json',JSON.stringify({sessionId:session.id,policy,cp,intent},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'quoted',allocation,block:cp.block,quotedAt:intent.quotedAt}));
 const deadline=Date.now()+150000;
 while(Date.now()<deadline){
  cp=await latest();
  if(Date.parse(cp.blockTimestamp)>Date.parse(intent.quotedAt))break;
  await setTimeout(5000);
 }
 assert(Date.parse(cp.blockTimestamp)>Date.parse(intent.quotedAt),'No later source for entry');
 const proof=await executor.enter(cp,policy,intent);
 const out={capturedAt:new Date().toISOString(),scope:'Independent local fork; no paper store mutation',sessionId:session.id,
  intent,cp,policy,...proof,entryGasQuote:String(paperGasQuote(proof.result.entryGasWei,proof.valuation)),
  exitGasQuote:String(paperGasQuote(proof.result.exitGasWei,proof.valuation))};
 const raw=JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(output,raw,{flag:'wx'});
 fs.writeFileSync(output+'.sha256',createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'succeeded',block:cp.block,allocation,entryGasQuote:out.entryGasQuote,
  exitGasQuote:out.exitGasQuote,range:proof.result.range,liquidity:proof.result.liquidity,afterMint:proof.result.balances.afterMint}));
} catch(e){fs.writeFileSync(output+'.failed.json',JSON.stringify({at:new Date().toISOString(),error:sanitizeRiskError(e),cp,policy,intent},null,2)+'\n',{flag:'wx'});throw e;
} finally{await executor.close();await source.close();}
