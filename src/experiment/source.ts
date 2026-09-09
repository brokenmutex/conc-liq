import assert from 'node:assert/strict';
import pg from 'pg';
import { evaluatePaperReference, readPaperReferenceGate } from '../paper/reference.js';
import { evaluateCanaryEntryReadiness } from '../canary-plan/entry-readiness.js';
import { PAPER_POOL, type PaperCheckpoint } from '../paper/engine.js';
import type { RiskSnapshot } from '../risk/domain.js';
import type { RpcHealthEvaluation } from '../rpc-health/domain.js';
import type { ExperimentFrame, ExperimentEvent, MarketSeed } from './market.js';
import { paperGasQuote } from '../paper/transaction-engine.js';
import type { ExperimentCosts } from './portfolio.js';
export const STREAM='robinhood-v3-rwa-usdg-v1';
const REFERENCE={kind:'continuous_bounded_v1' as const,maxHeldAgeSeconds:345600,maxDeviationPpm:50000,maxGasPriceAgeSeconds:86400};
export class ExperimentSource {
 readonly db:pg.Client;poolAddress='';
 constructor(connectionString:string){this.db=new pg.Client({connectionString,application_name:'lp_experiment_readonly',options:'-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000'});}
 async connect(){await this.db.connect();this.poolAddress=(await this.db.query('SELECT pool_address FROM indexer_pools WHERE stream_key=$1 AND lower(pool_address)=$2 AND enabled AND chain_id=4663 AND fee=500',[STREAM,PAPER_POOL])).rows[0]?.pool_address;assert(this.poolAddress);}
 async close(){await this.db.end();}
 async checkpoints(from:string,to:string){return (await this.db.query(`SELECT c.id::text,c.block_number::text AS block,c.block_hash AS hash,c.block_timestamp AS source_at,c.captured_at AS observed_at,c.target_set_hash,
 p.sqrt_price_x96::text AS price,p.tick,p.liquidity::text,p.fee_growth_global0_x128::text AS global0,p.fee_growth_global1_x128::text AS global1,p.pool_unlocked,p.token0,p.token1,p.token_decimals,p.reasons,
 r.snapshot,(v.canonical IS TRUE AND v.block_number=c.block_number AND LOWER(v.expected_hash)=LOWER(c.block_hash) AND LOWER(v.observed_hash)=LOWER(c.block_hash) AND r.block_number=c.block_number AND LOWER(r.block_hash)=LOWER(c.block_hash)) AS canonical
 FROM v3_strategy_checkpoint_runs c JOIN v3_strategy_pool_checkpoints p ON p.checkpoint_run_id=c.id
 JOIN risk_snapshot_runs r ON r.id=c.risk_run_id LEFT JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id
 WHERE c.stream_key=$1 AND lower(p.pool_address)=$2 AND c.block_timestamp >= $3 AND c.block_timestamp <= $4 ORDER BY c.block_number,c.id`,[STREAM,PAPER_POOL,from,to])).rows;}
 async seed(row:Record<string,any>):Promise<MarketSeed>{
  const events=(await this.db.query(`SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number<=$3 AND event_name IN ('Mint','Burn','SetFeeProtocol') ORDER BY block_number,transaction_index,log_index`,[STREAM,this.poolAddress,row.block])).rows;
  const ticks=new Map<number,{gross:bigint;net:bigint}>();let protocol0=0,protocol1=0;
  for(const e of events){const a=e.event_args;if(e.event_name==='SetFeeProtocol'){protocol0=Number(a.feeProtocol0New);protocol1=Number(a.feeProtocol1New);continue;}
   const change=BigInt(a.amount)*(e.event_name==='Burn'?-1n:1n);for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]] as const){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);if(t.gross===0n){assert(t.net===0n);ticks.delete(tick);}else ticks.set(tick,t);}}
  return {price:row.price,tick:row.tick,liquidity:row.liquidity,global0:row.global0,global1:row.global1,protocol0,protocol1,ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
 }
 async health(from:string,to:string){return (await this.db.query<{id:string;snapshot:RpcHealthEvaluation}>('SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at>=$1::timestamptz-interval \'6 minutes\' AND observed_at<=$2 ORDER BY observed_at,id',[from,to])).rows;}
 frame(row:Record<string,any>,health:readonly {id:string;snapshot:RpcHealthEvaluation}[],events:ExperimentEvent[],decisionAt?:string):ExperimentFrame{
  const sourceAt=new Date(row.source_at).toISOString(),observedAt=decisionAt??new Date(new Date(row.observed_at).getTime()+30000).toISOString();
  const cp:PaperCheckpoint={id:row.id,block:row.block,hash:row.hash,blockTimestamp:sourceAt,capturedAt:observedAt,tick:row.tick,sqrtPriceX96:row.price,liquidity:row.liquidity,feeGrowth0:row.global0,feeGrowth1:row.global1,targetSetHash:row.target_set_hash};
  const ref=evaluatePaperReference({snapshot:row.snapshot as RiskSnapshot,checkpoint:cp,policy:REFERENCE});
  const now=Date.parse(observedAt);const samples=health.filter(s=>Date.parse(s.snapshot.observedAt)<=now&&Date.parse(s.snapshot.observedAt)>=now-360000);
  const readiness=evaluateCanaryEntryReadiness({now:observedAt,sourceBlock:BigInt(row.block),samples});
  const reasons=[...ref.reasons,...readiness.reasons.filter(r=>!r.startsWith('equity_session_')),...(row.reasons as string[]).filter(r=>!['rwa_oracle_price_stale','quote_oracle_price_stale'].includes(r))];
  if(!row.pool_unlocked)reasons.push('pool_locked');
  return {id:row.id,block:row.block,hash:row.hash,sourceAt,observedAt,capturedAt:new Date(row.observed_at).toISOString(),healthSampleIds:readiness.sampleIds,
   decisionMode:'historical_checkpoint_only',targetSetHash:row.target_set_hash,price:row.price,tick:row.tick,liquidity:row.liquidity,global0:row.global0,global1:row.global1,
   referencePrice:ref.referencePriceX18,referenceEligible:ref.eligible&&row.pool_unlocked&&reasons.every(r=>r.startsWith('chain_')||r==='source_ahead_of_confirmed_quorum'),referenceBasis:ref.basis,
   chainHealthy:readiness.chainEligible,reasons:[...new Set(reasons)],dataValid:row.canonical===true&&row.token0.toLowerCase()==='0x5fc5360d0400a0fd4f2af552add042d716f1d168'&&row.token1.toLowerCase()==='0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'&&row.token_decimals===18,events};
 }
 async liveFrame(row:Record<string,any>,events:ExperimentEvent[]):Promise<ExperimentFrame>{
  const cp:PaperCheckpoint={id:row.id,block:row.block,hash:row.hash,blockTimestamp:new Date(row.source_at).toISOString(),
   capturedAt:new Date(row.observed_at).toISOString(),tick:row.tick,sqrtPriceX96:row.price,liquidity:row.liquidity,
   feeGrowth0:row.global0,feeGrowth1:row.global1,targetSetHash:row.target_set_hash};
  const gate=await readPaperReferenceGate(this.db,cp,REFERENCE,new Date().toISOString());
  const at=new Date(gate.evidence.current.evaluatedAt).toISOString(),health=await this.health(at,at);
  const frame=this.frame(row,health,events,at);
  return {...frame,decisionMode:'prospective',referenceEvidence:gate.evidence,
   referenceEligible:frame.referenceEligible&&gate.eligible,dataValid:frame.dataValid&&gate.evidence.sourceProven,
   reasons:[...new Set([...frame.reasons,...gate.reasons])]};
 }
 async events(from:string,to:string):Promise<ExperimentEvent[]>{return (await this.db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index`,[STREAM,this.poolAddress,from,to])).rows;}
 async coverage(block:string,target:string){const r=(await this.db.query(`SELECT i.last_scanned_block::text,r.complete_through_block::text,i.target_set_hash,r.target_set_hash AS replay_target FROM indexer_cursors i JOIN v3_replay_cursors r USING(stream_key) WHERE i.stream_key=$1 AND i.chain_id=4663 AND r.chain_id=4663`,[STREAM])).rows[0];assert(r&&BigInt(r.last_scanned_block)>=BigInt(block)&&BigInt(r.complete_through_block)>=BigInt(block)&&r.target_set_hash===target&&r.replay_target===target,'Event coverage unavailable');}
 async costs(){
  const rows=(await this.db.query("SELECT x.id::text,x.action,x.source_block::text,x.source_hash,x.snapshot,(v.canonical IS TRUE AND v.block_number=x.source_block AND LOWER(v.expected_hash)=LOWER(x.source_hash) AND LOWER(v.observed_hash)=LOWER(x.source_hash) AND x.policy_hash=s.policy_hash AND x.runtime_identity=s.runtime_identity) AS valid FROM paper_execution_runs x JOIN paper_sessions s ON s.id=x.session_id JOIN v3_strategy_checkpoint_runs c ON c.id=x.checkpoint_id JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id WHERE x.session_id=6 AND x.action IN ('entry','exit') AND x.status='succeeded' ORDER BY x.id")).rows;
  assert.equal(rows.length,2);assert(rows.every(r=>r.valid===true),'Cost source evidence revoked');const costs:ExperimentCosts={buy:'0',sell:'0',mint:'0',remove:'0',revoke:'0'};const transactions=[];
  for(const row of rows)for(const t of row.snapshot.result.transactions){
   const a=t.action;let key:keyof ExperimentCosts|null=null;
   if(row.action==='entry'){if(['approve_entry_swap','buy_nvda'].includes(a))key='buy';if(['approve_mint_usdg','approve_mint_nvda','mint'].includes(a))key='mint';}
   else{if(a==='decrease_and_collect')key='remove';if(['approve_exit_swap','sell_nvda'].includes(a))key='sell';if(a.startsWith('revoke'))key='revoke';}
   if(key){const quote=paperGasQuote(t.estimate.totalFeeWei,row.snapshot.valuation);costs[key]=String(BigInt(costs[key])+quote);transactions.push({runId:row.id,sourceBlock:row.source_block,sourceHash:row.source_hash,action:a,group:key,quote:String(quote)});}
  }
  assert(Object.values(costs).every(v=>BigInt(v)>0n));return {costs,transactions,evidenceClass:'frozen_fork_estimates_from_session_6',limitations:['Not historical gas quotes or measured mainnet costs','Recenter cost is composed from remove, optional swap, mint and approval estimates','Approval estimates are conservatively repeated at each placement']};
 }
 async historyValid(ids:string[],references:readonly {id:string;block:string;hash:string}[]=[]){
  const r=await this.db.query(`SELECT count(*)::int AS n FROM v3_strategy_checkpoint_runs c JOIN risk_snapshot_canonicality v ON v.risk_run_id=c.risk_run_id WHERE c.id=ANY($1::bigint[]) AND v.canonical IS TRUE AND v.block_number=c.block_number AND LOWER(v.expected_hash)=LOWER(c.block_hash) AND LOWER(v.observed_hash)=LOWER(c.block_hash)`,[ids]);
  if(r.rows[0].n!==ids.length)return false;
  if(!references.length)return true;
  const proof=await this.db.query(`SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) AS e(id bigint,block bigint,hash text)
   JOIN risk_snapshot_runs r ON r.id=e.id AND r.block_number=e.block AND LOWER(r.block_hash)=LOWER(e.hash)
   JOIN risk_snapshot_canonicality v ON v.risk_run_id=r.id AND v.canonical IS TRUE AND v.block_number=e.block
   AND LOWER(v.expected_hash)=LOWER(e.hash) AND LOWER(v.observed_hash)=LOWER(e.hash)`,[JSON.stringify(references)]);
  return proof.rows[0].n===references.length;
 }
}
