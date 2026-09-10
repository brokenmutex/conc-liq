import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseEnv} from 'node:util';
import pg from 'pg';
const [envPath,output,seconds='1800']=process.argv.slice(2);
assert(envPath&&output&&Number(seconds)>0&&Number(seconds)<=7200);
const db=new pg.Client({connectionString:parseEnv(fs.readFileSync(envPath,'utf8')).DATABASE_URL,
 options:'-c default_transaction_read_only=on -c statement_timeout=10000'});
fs.writeFileSync(output,'',{flag:'wx'});
let stop=false,previous=null;process.on('SIGINT',()=>{stop=true;});process.on('SIGTERM',()=>{stop=true;});
await db.connect();
const accounting=s=>JSON.stringify([s.position,s.navQuote,s.holdQuote,s.costsPaidQuote,s.exitReserveQuote,s.execution]);
try{
 const end=Date.now()+Number(seconds)*1000;
 while(!stop&&Date.now()<end){
  const row=(await db.query('SELECT id,status,policy_hash,runtime_identity,state,heartbeat_at,monitor_reasons,clock_timestamp() AS checked_at FROM paper_sessions ORDER BY id DESC LIMIT 1')).rows[0];
  const health=(await db.query('SELECT id::text,snapshot FROM rpc_health_samples ORDER BY observed_at DESC LIMIT 1')).rows[0];
  const checks=[];
  if(previous?.id===row.id){
   if(row.state.holding?.paused&&previous.state.last?.block===row.state.last?.block){assert.equal(accounting(row.state),accounting(previous.state),'Paused accounting changed without a new checkpoint');checks.push('unchanged_paused_accounting');}
   for(const reason of previous.state.holding?.exitReasons??[])assert(row.state.holding.exitReasons.includes(reason),'Latched exit was cleared');
  }
  const record={checkedAt:row.checked_at,sessionId:row.id,status:row.status,action:row.state.action,heartbeatAt:row.heartbeat_at,
   policyHash:row.policy_hash,runtimeIdentity:row.runtime_identity,source:row.state.last,holding:row.state.holding??null,
   reasons:row.state.reasons,monitorReasons:row.monitor_reasons,nav:row.state.navQuote,costs:row.state.costsPaidQuote,
   health:{id:health.id,observedAt:health.snapshot.observedAt,state:health.snapshot.state,lagBlocks:health.snapshot.lagBlocks,reasons:health.snapshot.reasons},checks};
  fs.appendFileSync(output,JSON.stringify(record)+'\n');
  if(!previous||previous.id!==row.id||previous.status!==row.status||JSON.stringify(previous.state.holding?.reasons)!==JSON.stringify(row.state.holding?.reasons))
   console.log(JSON.stringify({at:record.checkedAt,id:row.id,status:row.status,holding:row.state.holding?.reasons??[],checks}));
  previous=row;
  for(let i=0;i<30&&!stop;i++)await new Promise(resolve=>setTimeout(resolve,1000));
 }
}finally{await db.end();}
