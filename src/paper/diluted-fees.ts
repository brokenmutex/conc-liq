import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {ExperimentMarket,type ExperimentEvent,type MarketSeed} from '../experiment/market.js';
import {modeledFeeGrowth} from '../research/portfolio-math.js';
import {paperSegmentCredit} from '../research/management-audit.js';
import {boundaryInside,boundaryContinuity,type BoundaryFeeProof} from './boundary-fees.js';
import {subtractUint256} from '../accounting/math.js';
import {PAPER_POOL,type PaperCheckpoint,type PaperPosition,type PaperState} from './engine.js';
export interface DilutedFeeProof {
 fromBlock:string;toBlock:string;fromHash:string;toHash:string;liquidity:string;tickLower:number;tickUpper:number;
 raw0:string;raw1:string;undilutedRaw0:string;undilutedRaw1:string;events:number;segments:number;maxRatioPpm:string|null;
}
export function dilutedFeeReplay(seed:MarketSeed,events:readonly ExperimentEvent[],before:PaperCheckpoint,after:PaperCheckpoint,
 position:PaperPosition,endBoundary:BoundaryFeeProof):DilutedFeeProof {
 assert(position.boundaryFees);assert.equal(endBoundary.tickLower,position.tickLower);assert.equal(endBoundary.tickUpper,position.tickUpper);
 assert(boundaryContinuity(position.boundaryFees,endBoundary,events.filter(e=>e.name==='Mint'||e.name==='Burn').map(e=>({eventName:e.name,args:{tickLower:Number(e.args.tickLower),tickUpper:Number(e.args.tickUpper),amount:String(e.args.amount)}}))),'Fee boundary continuity unavailable');
 const market=new ExperimentMarket(seed),ours=BigInt(position.liquidity);
 market.verify({price:before.sqrtPriceX96,tick:before.tick,liquidity:before.liquidity,global0:before.feeGrowth0,global1:before.feeGrowth1});
 const raw:[bigint,bigint]=[0n,0n],undiluted:[bigint,bigint]=[0n,0n];let segments=0,maxRatio=0n;
 let previous:{block:bigint;tx:number;log:number}|null=null;
 for(const e of events){
  const block=BigInt(e.block);assert(block>BigInt(before.block)&&block<=BigInt(after.block));
  if(previous)assert(block>previous.block||(block===previous.block&&(e.tx>previous.tx||(e.tx===previous.tx&&e.log>previous.log))),'Fee events must be strictly ordered');
  if(block===BigInt(after.block))assert.equal(e.hash.toLowerCase(),after.hash.toLowerCase());
  previous={block,tx:e.tx,log:e.log};
  for(const {segment,protocol} of market.apply(e)){
   // This rejects partial overlap: existing initialized range boundaries must
   // split the canonical swap into complete fee segments.
   const credit=paperSegmentCredit(segment,position,ours,protocol);
   undiluted[segment.token]+=credit;
   raw[segment.token]+=modeledFeeGrowth(segment,position,ours,protocol)*ours;
   if(credit>0n&&segment.liquidity>0n){const r=ours*1000000n/segment.liquidity;if(r>maxRatio)maxRatio=r;}
   segments++;
  }
 }
 market.verify({price:after.sqrtPriceX96,tick:after.tick,liquidity:after.liquidity,global0:after.feeGrowth0,global1:after.feeGrowth1});
 const from=boundaryInside(before,position.boundaryFees),to=boundaryInside(after,endBoundary);
 for(const token of [0,1] as const){assert.equal(undiluted[token],subtractUint256(to[token]!,from[token]!)*ours,'Replayed inside fees do not match observed growth');assert(raw[token]<=undiluted[token]);}
 return {fromBlock:before.block,toBlock:after.block,fromHash:before.hash,toHash:after.hash,liquidity:position.liquidity,tickLower:position.tickLower,tickUpper:position.tickUpper,
  raw0:String(raw[0]),raw1:String(raw[1]),undilutedRaw0:String(undiluted[0]),undilutedRaw1:String(undiluted[1]),events:events.length,segments,maxRatioPpm:String(maxRatio)};
}
/** Read in the caller's repeatable-read transaction. Rewind the current tick
 * book to the prior mark, then replay all fees to the new canonical checkpoint. */
export async function readDilutedFees(db:Pick<PoolClient,'query'>,stream:string,before:PaperCheckpoint,after:PaperCheckpoint,position:PaperPosition,endBoundary:BoundaryFeeProof) {
 const pool=(await db.query(`SELECT p.pool_address,p.fee_protocol0,p.fee_protocol1,r.complete_through_block::text AS through,r.target_set_hash
  FROM v3_replay_pools p JOIN v3_replay_cursors r USING(stream_key) WHERE p.stream_key=$1 AND lower(p.pool_address)=$2`,[stream,PAPER_POOL])).rows[0];
 assert(pool&&BigInt(pool.through)>=BigInt(after.block)&&pool.target_set_hash===after.targetSetHash,'Dilution replay coverage unavailable');
 const ticks=new Map<number,{gross:bigint;net:bigint}>((await db.query('SELECT tick,liquidity_gross::text AS gross,liquidity_net::text AS net FROM v3_replay_ticks WHERE stream_key=$1 AND pool_address=$2',[stream,pool.pool_address])).rows.map(t=>[t.tick,{gross:BigInt(t.gross),net:BigInt(t.net)}]));
 const rewind=(await db.query(`SELECT event_name,event_args FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4
  AND event_name IN ('Mint','Burn','SetFeeProtocol') ORDER BY block_number DESC,transaction_index DESC,log_index DESC LIMIT 20001`,[stream,pool.pool_address,before.block,pool.through])).rows;
 assert(rewind.length<=20000,'Dilution rewind exceeds event budget');let protocol0=pool.fee_protocol0,protocol1=pool.fee_protocol1;
 for(const e of rewind){const a=e.event_args;
  if(e.event_name==='SetFeeProtocol'){assert.equal(protocol0,Number(a.feeProtocol0New));assert.equal(protocol1,Number(a.feeProtocol1New));protocol0=Number(a.feeProtocol0Old);protocol1=Number(a.feeProtocol1Old);continue;}
  const change=BigInt(a.amount)*(e.event_name==='Mint'?-1n:1n);
  for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]] as const){const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}
 }
 const seed:MarketSeed={price:before.sqrtPriceX96,tick:before.tick,liquidity:before.liquidity,global0:before.feeGrowth0,global1:before.feeGrowth1,protocol0,protocol1,
  ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
 const events=(await db.query<ExperimentEvent>(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,event_name AS name,event_args AS args
  FROM v3_pool_events WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4 ORDER BY block_number,transaction_index,log_index LIMIT 20001`,[stream,pool.pool_address,before.block,after.block])).rows;
 assert(events.length<=20000,'Dilution interval exceeds event budget');
 return dilutedFeeReplay(seed,events,before,after,position,endBoundary);
}

/** Credit only the new interval; historical balances retain their original basis. */
export function creditDilutedFees(state:PaperState,before:PaperCheckpoint,after:PaperCheckpoint,endBoundary:BoundaryFeeProof,proof:DilutedFeeProof|undefined) {
 const p=state.position!,q=1n<<128n;
 assert(proof,'Diluted fee proof missing');assert(p.boundaryFees);
 assert.equal(proof.fromBlock,before.block);assert.equal(proof.toBlock,after.block);
 assert.equal(proof.fromHash.toLowerCase(),before.hash.toLowerCase());assert.equal(proof.toHash.toLowerCase(),after.hash.toLowerCase());
 assert.equal(proof.liquidity,p.liquidity);assert.equal(proof.tickLower,p.tickLower);assert.equal(proof.tickUpper,p.tickUpper);
 assert.equal(endBoundary.tickLower,p.tickLower);assert.equal(endBoundary.tickUpper,p.tickUpper);
 const a=boundaryInside(before,p.boundaryFees),b=boundaryInside(after,endBoundary);
 const model=initializeDilutedFees(state,before);
 for(const t of [0,1] as const){
  const raw=BigInt(proof[`raw${t}`]),old=BigInt(proof[`undilutedRaw${t}`]);
  assert.equal(old,subtractUint256(b[t]!,a[t]!)*BigInt(p.liquidity),'Dilution proof differs from observed inside growth');assert(raw>=0n&&raw<=old);
  const adjusted=raw+BigInt(p[`feeRemainder${t}`]??'0'),undiluted=old+BigInt(model[`remainder${t}`]);
  p[`fee${t}`]=String(BigInt(p[`fee${t}`])+adjusted/q);p[`feeRemainder${t}`]=String(adjusted%q);
  model[`adjusted${t}`]=String(BigInt(model[`adjusted${t}`])+adjusted/q);
  model[`undiluted${t}`]=String(BigInt(model[`undiluted${t}`])+undiluted/q);model[`remainder${t}`]=String(undiluted%q);
 }
 p.boundaryFees=endBoundary;model.lastProof=proof;
}
export function initializeDilutedFees(state:PaperState,before:PaperCheckpoint) {
 const p=state.position!,ledger=state.execution!;
 return state.feeModel??={kind:'diluted_segments_v1',fromBlock:before.block,fromSourceAt:before.blockTimestamp,
  legacyEarned0:ledger.earnedFee0,legacyEarned1:ledger.earnedFee1,undiluted0:'0',undiluted1:'0',adjusted0:'0',adjusted1:'0',
  remainder0:p.feeRemainder0??'0',remainder1:p.feeRemainder1??'0',lastProof:null};
}
