import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {parseAbi,type Hex} from 'viem';
import {poolAbi} from '../abi.js';
import type {RobinhoodClient} from '../client.js';
import {ExperimentMarket,type ExperimentEvent,type MarketSeed} from '../experiment/market.js';
import {virtualFeeCredit} from '../research/virtual-fees.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import type {MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';

const Q128=1n<<128n,MAX_EVENTS=20000,MAX_TICKS=50000;
const hash=/^0x[0-9a-fA-F]{64}$/;
const address=/^0x[0-9a-fA-F]{40}$/;
const allowedEvents=new Set(['Swap','Flash','Mint','Burn','SetFeeProtocol','Collect',
 'CollectProtocol','IncreaseObservationCardinalityNext']);
const feeGrowthAbi=parseAbi(['function feeGrowthGlobal0X128() view returns (uint256)',
 'function feeGrowthGlobal1X128() view returns (uint256)']);

export interface PaperFeeFrame {
 source:{block:string;hash:string};
 poolState:{tick:number;sqrtPriceX96:string;poolLiquidity:string;
  feeGrowthGlobal0X128:string;feeGrowthGlobal1X128:string};
}

type PaperFeeSource=PaperOpenFrame['source'];
type PaperFeeSnapshot=Pick<PaperOpenFrame,'source'|'tick'|'sqrtPriceX96'|'poolLiquidity'>;

/** The block hash brackets all pool reads; every contract call is pinned to
 * the source block. Profile identity is verified by the canonical wrapper. */
export async function readAnchoredPaperFeeFrame(client:RobinhoodClient,profile:MarketProfile,
 source:PaperFeeSource):Promise<PaperFeeFrame>{
 assert(hash.test(source.hash)&&BigInt(source.block)>=0n,'Paper fee source anchor invalid');
 const blockNumber=BigInt(source.block),pool=profile.pool.pool;
 const check=async()=>{
  const block=await client.getBlock({blockNumber});
  assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase(),'Paper fee source reorged');
  assert.equal(Number(block.timestamp),source.timestamp,'Paper fee source timestamp changed');
 };
 await check();
 const [slot,liquidity,fee0,fee1]=await Promise.all([
  client.readContract({address:pool,abi:poolAbi,functionName:'slot0',blockNumber}),
  client.readContract({address:pool,abi:poolAbi,functionName:'liquidity',blockNumber}),
  client.readContract({address:pool,abi:feeGrowthAbi,functionName:'feeGrowthGlobal0X128',blockNumber}),
  client.readContract({address:pool,abi:feeGrowthAbi,functionName:'feeGrowthGlobal1X128',blockNumber}),
 ]);
 await check();
 assert(slot[6]&&slot[0]>0n&&liquidity>=0n,'Paper fee pool state unavailable');
 return {source:{block:source.block,hash:source.hash},poolState:{
  tick:slot[1],sqrtPriceX96:String(slot[0]),poolLiquidity:String(liquidity),
  feeGrowthGlobal0X128:String(fee0),feeGrowthGlobal1X128:String(fee1)}};
}

/** Replays an observed pool path with a hypothetical position included in fee
 * sharing. It does not establish that the supplied path is complete/canonical,
 * and it does not book fees or net economics. A clipped segment returns
 * integer allocation bounds on the fixed observed path, not a bound on
 * market impact or a counterfactual on-chain receipt. */
export function replayPaperFeeInterval(seed:MarketSeed,events:readonly ExperimentEvent[],
 before:PaperFeeFrame,after:PaperFeeFrame,range:{tickLower:number;tickUpper:number},
 liquidity:bigint,pool:{address:string;token0:string;token1:string;fee:number;tickSpacing:number}){
 assert(address.test(pool.address)&&address.test(pool.token0)&&address.test(pool.token1)&&
  pool.token0.toLowerCase()!==pool.token1.toLowerCase(),'Paper fee token identity unavailable');
 assert(seed.fee===pool.fee&&seed.spacing===pool.tickSpacing,
  'Paper fee replay requires explicit pool fee and tick spacing');
 assert(Number.isInteger(pool.fee)&&pool.fee>0&&pool.fee<1_000_000&&
  Number.isInteger(pool.tickSpacing)&&pool.tickSpacing>0,'Invalid pool fee configuration');
 assert(range.tickLower<range.tickUpper&&range.tickLower%pool.tickSpacing===0&&
  range.tickUpper%pool.tickSpacing===0,'Paper fee range is not aligned');
 assert(liquidity>0n&&liquidity<(1n<<128n),'Paper fee liquidity unavailable');
 assert(hash.test(before.source.hash)&&hash.test(after.source.hash)&&
  BigInt(before.source.block)>=0n&&
  BigInt(after.source.block)>BigInt(before.source.block),'Paper fee source anchors invalid');
 assert([seed.protocol0,seed.protocol1].every(v=>v===0||
  Number.isInteger(v)&&v>=4&&v<=10),'Paper fee protocol unavailable');
 assert(events.length<=MAX_EVENTS,'Paper fee interval exceeds event budget');
 const market=new ExperimentMarket(seed);
 const state=(f:PaperFeeFrame)=>({price:f.poolState.sqrtPriceX96,tick:f.poolState.tick,
  liquidity:f.poolState.poolLiquidity,global0:f.poolState.feeGrowthGlobal0X128,
  global1:f.poolState.feeGrowthGlobal1X128});
 market.verify(state(before));
 const low=[0n,0n],high=[0n,0n];let partialSegments=0,segments=0;
 let prior:{block:bigint;tx:number;log:number;hash:string}|null=null;
 for(const event of events){
  const block=BigInt(event.block);
  assert(block>BigInt(before.source.block)&&block<=BigInt(after.source.block)&&
   hash.test(event.hash),'Paper fee event source outside interval');
  assert(Number.isSafeInteger(event.tx)&&event.tx>=0&&
   Number.isSafeInteger(event.log)&&event.log>=0,'Paper fee event ordering unavailable');
  assert(allowedEvents.has(event.name),'Unsupported paper fee event');
  if(prior){
   assert(block>prior.block||block===prior.block&&
    (event.tx>prior.tx||event.tx===prior.tx&&event.log>prior.log),
    'Paper fee events are not strictly ordered');
   if(block===prior.block)assert.equal(event.hash.toLowerCase(),prior.hash.toLowerCase(),
    'Paper fee block hash changed within interval');
  }
  if(block===BigInt(after.source.block))assert.equal(event.hash.toLowerCase(),
   after.source.hash.toLowerCase(),'Paper fee ending block hash mismatch');
  prior={block,tx:event.tx,log:event.log,hash:event.hash};
  for(const {segment,protocol} of market.apply(event)){
   const credit=virtualFeeCredit(segment,range,liquidity,protocol);
   low[segment.token]!+=credit.lower;high[segment.token]!+=credit.upper;
   if(credit.partial)partialSegments++;
   segments++;
  }
 }
 market.verify(state(after));
 const token=(i:0|1)=>({lowerRawQ128:String(low[i]),upperRawQ128:String(high[i]),
  lowerAmountRaw:String(low[i]!/Q128),upperAmountRaw:String(high[i]!/Q128)});
 return {kind:'paper_observed_flow_fee_interval_v1' as const,pool:pool.address.toLowerCase(),
  token0Address:pool.token0.toLowerCase(),token1Address:pool.token1.toLowerCase(),
  fee:pool.fee,tickSpacing:pool.tickSpacing,from:before.source,to:after.source,
  range,liquidity:String(liquidity),token0:token(0),token1:token(1),
  events:events.length,segments,partialSegments,
  accounting:'modeled_hypothetical_fee_share' as const};
}

/** Bounded read-only indexer replay. The caller must separately confirm the
 * two frame hashes against the canonical chain before relying on this result.
 * This function intentionally does not append deployment marks or fee ledger. */
export async function readIndexedPaperFeeInterval(pool:Pool,stream:string,targetSetHash:string,
 profile:MarketProfile,before:PaperFeeFrame,after:PaperFeeFrame,
 range:{tickLower:number;tickUpper:number},liquidity:bigint){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
   await db.query("SET LOCAL statement_timeout='15s'");
   const p=profile.pool;
   const row=(await db.query<{pool_address:string;chain_id:string;fee:number;initialized:boolean;
    fee_protocol0:number;fee_protocol1:number;last_block_number:string|null;
    complete_through_block:string|null;
    complete_through_hash:string|null;target_set_hash:string}>(`
    SELECT p.pool_address,p.chain_id::text,p.fee,p.initialized,p.fee_protocol0,p.fee_protocol1,
     c.last_block_number::text,c.complete_through_block::text,
     c.complete_through_hash,c.target_set_hash
    FROM v3_replay_pools p JOIN v3_replay_cursors c USING(stream_key)
    WHERE p.stream_key=$1 AND lower(p.pool_address)=lower($2)`,[stream,p.pool])).rows[0];
   assert(row&&row.initialized&&Number(row.chain_id)===p.chainId&&row.fee===p.fee&&
    row.target_set_hash===targetSetHash&&row.complete_through_block!==null&&
    BigInt(row.complete_through_block)>=BigInt(after.source.block),
    'Paper fee replay coverage unavailable');
   assert(row.last_block_number===null||
    BigInt(row.last_block_number)<=BigInt(row.complete_through_block),
    'Paper fee replay cursor has an incomplete later block');
   if(BigInt(row.complete_through_block)===BigInt(after.source.block))
    assert.equal(row.complete_through_hash?.toLowerCase(),after.source.hash.toLowerCase(),
     'Paper fee replay cursor hash mismatch');
   const ticks=(await db.query<{tick:number;gross:string;net:string}>(`
    SELECT tick,liquidity_gross::text AS gross,liquidity_net::text AS net
    FROM v3_replay_ticks WHERE stream_key=$1 AND pool_address=$2 ORDER BY tick LIMIT 50001`,
    [stream,row.pool_address])).rows;
   assert(ticks.length<=MAX_TICKS,'Paper fee tick book exceeds budget');
   const book=new Map(ticks.map(t=>[t.tick,{gross:BigInt(t.gross),net:BigInt(t.net)}]));
   const rewind=(await db.query<{event_name:string;event_args:Record<string,unknown>}>(`
    SELECT event_name,event_args FROM v3_pool_events
    WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4
     AND event_name IN ('Mint','Burn','SetFeeProtocol')
    ORDER BY block_number DESC,transaction_index DESC,log_index DESC LIMIT 20001`,
    [stream,row.pool_address,before.source.block,row.complete_through_block])).rows;
   assert(rewind.length<=MAX_EVENTS,'Paper fee rewind exceeds event budget');
   let protocol0=row.fee_protocol0,protocol1=row.fee_protocol1;
   for(const event of rewind){
    const a=event.event_args;
    if(event.event_name==='SetFeeProtocol'){
     assert.equal(protocol0,Number(a.feeProtocol0New));
     assert.equal(protocol1,Number(a.feeProtocol1New));
     protocol0=Number(a.feeProtocol0Old);protocol1=Number(a.feeProtocol1Old);
     continue;
    }
    const change=BigInt(String(a.amount))*(event.event_name==='Mint'?-1n:1n);
    for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]] as const){
     const t=book.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;
     assert(t.gross>=0n,'Paper fee rewind liquidity underflow');
     if(t.gross===0n){assert.equal(t.net,0n);book.delete(tick);}else book.set(tick,t);
    }
   }
   const seed:MarketSeed={price:before.poolState.sqrtPriceX96,tick:before.poolState.tick,
    liquidity:before.poolState.poolLiquidity,global0:before.poolState.feeGrowthGlobal0X128,
    global1:before.poolState.feeGrowthGlobal1X128,protocol0,protocol1,fee:p.fee,
    spacing:p.tickSpacing,ticks:[...book].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))};
   const events=(await db.query<ExperimentEvent>(`
    SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,
     log_index AS log,event_name AS name,event_args AS args FROM v3_pool_events
    WHERE stream_key=$1 AND pool_address=$2 AND block_number>$3 AND block_number<=$4
    ORDER BY block_number,transaction_index,log_index LIMIT 20001`,
    [stream,row.pool_address,before.source.block,after.source.block])).rows;
   assert(events.length<=MAX_EVENTS,'Paper fee interval exceeds event budget');
   const proof=replayPaperFeeInterval(seed,events,before,after,range,liquidity,
    {address:p.pool,token0:p.token0,token1:p.token1,fee:p.fee,tickSpacing:p.tickSpacing});
   await db.query('COMMIT');
   return {...proof,coverage:{stream,targetSetHash,
    completeThroughBlock:row.complete_through_block,completeThroughHash:row.complete_through_hash,
    chainAnchorRecheckRequired:true as const}};
  }catch(error){await db.query('ROLLBACK');throw error;}
 }finally{db.release();}
}

/** Rechecks profile identity and both chain anchors around the indexed replay.
 * The returned proof is read-only and is still hypothetical fee evidence. */
export async function readCanonicalPaperFeeInterval(client:RobinhoodClient,db:Pool,
 stream:string,targetSetHash:string,profile:MarketProfile,before:PaperFeeSnapshot,
 after:PaperFeeSnapshot,range:{tickLower:number;tickUpper:number},liquidity:bigint){
 assert(BigInt(after.source.block)>BigInt(before.source.block),'Paper fee interval is not later');
 const chain=new RangeKeeperChain(client,profile.pool);
 for(const source of [before.source,after.source])
  await chain.verify({block:BigInt(source.block),hash:source.hash as Hex,timestamp:source.timestamp});
 const [start,end]=await Promise.all([
  readAnchoredPaperFeeFrame(client,profile,before.source),
  readAnchoredPaperFeeFrame(client,profile,after.source),
 ]);
 for(const [observed,saved] of [[start,before],[end,after]] as const){
  assert.equal(observed.poolState.tick,saved.tick,'Paper fee snapshot tick mismatch');
  assert.equal(observed.poolState.sqrtPriceX96,String(saved.sqrtPriceX96),
   'Paper fee snapshot price mismatch');
  assert.equal(observed.poolState.poolLiquidity,String(saved.poolLiquidity),
   'Paper fee snapshot liquidity mismatch');
 }
 const proof=await readIndexedPaperFeeInterval(db,stream,targetSetHash,profile,start,end,range,liquidity);
 for(const source of [before.source,after.source]){
  const block=await client.getBlock({blockNumber:BigInt(source.block)});
  assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase(),'Paper fee source reorged');
  assert.equal(Number(block.timestamp),source.timestamp,'Paper fee source timestamp changed');
 }
 return {...proof,coverage:{...proof.coverage,chainAnchorRecheckRequired:false as const}};
}

export type CanonicalPaperFeeInterval=Awaited<ReturnType<typeof readCanonicalPaperFeeInterval>>;
export interface PaperFeeCarry {
 kind:'paper_fee_carry_v1';pool:string;token0Address:string;token1Address:string;
 fee:number;tickSpacing:number;range:{tickLower:number;tickUpper:number};liquidity:string;
 stream:string;targetSetHash:string;from:{block:string;hash:string};through:{block:string;hash:string};
 token0:{lowerRawQ128:string;upperRawQ128:string;lowerAmountRaw:string;upperAmountRaw:string};
 token1:{lowerRawQ128:string;upperRawQ128:string;lowerAmountRaw:string;upperAmountRaw:string};
 intervals:number;events:number;segments:number;partialSegments:number;
 accounting:'modeled_hypothetical_fee_share';
}

/** Carries Q128 fractions across adjacent verified intervals without booking
 * an earned fee or using the result as net NAV. */
export function advancePaperFeeCarry(previous:PaperFeeCarry|null,
 interval:CanonicalPaperFeeInterval,opening:{block:string;hash:string}):PaperFeeCarry{
 assert.equal(interval.kind,'paper_observed_flow_fee_interval_v1','Paper fee proof kind changed');
 assert.equal(interval.accounting,'modeled_hypothetical_fee_share',
  'Paper fee accounting basis changed');
 assert.equal(interval.coverage.chainAnchorRecheckRequired,false,
  'Paper fee chain anchors were not rechecked');
 assert(hash.test(opening.hash)&&hash.test(interval.from.hash)&&hash.test(interval.to.hash)&&
  BigInt(interval.to.block)>BigInt(interval.from.block),'Paper fee interval anchors invalid');
 assert(BigInt(interval.coverage.completeThroughBlock)>=BigInt(interval.to.block)&&
  (BigInt(interval.coverage.completeThroughBlock)!==BigInt(interval.to.block)||
   interval.coverage.completeThroughHash?.toLowerCase()===interval.to.hash.toLowerCase()),
  'Paper fee interval coverage invalid');
 assert(Number.isSafeInteger(interval.events)&&interval.events>=0&&
  Number.isSafeInteger(interval.segments)&&interval.segments>=0&&
  Number.isSafeInteger(interval.partialSegments)&&interval.partialSegments>=0&&
  interval.partialSegments<=interval.segments,'Paper fee interval counts invalid');
 const same=(a:{block:string;hash:string},b:{block:string;hash:string})=>
  a.block===b.block&&a.hash.toLowerCase()===b.hash.toLowerCase();
 assert(same(previous?.through??opening,interval.from),'Paper fee interval gap or replay');
 if(previous){
  assert(same(previous.from,opening),'Paper fee opening anchor changed');
  for(const key of ['pool','token0Address','token1Address','fee','tickSpacing',
   'liquidity','stream','targetSetHash'] as const)
   assert.equal(previous[key],key==='stream'||key==='targetSetHash'?interval.coverage[key]:interval[key],
    `Paper fee ${key} changed`);
  assert.deepEqual(previous.range,interval.range,'Paper fee range changed');
 }
 const sum=(i:0|1)=>{
  const now=i===0?interval.token0:interval.token1;
  const old=previous?(i===0?previous.token0:previous.token1):null;
  const currentLower=BigInt(now.lowerRawQ128),currentUpper=BigInt(now.upperRawQ128);
  assert(currentLower>=0n&&currentUpper>=currentLower&&
   now.lowerAmountRaw===String(currentLower/Q128)&&
   now.upperAmountRaw===String(currentUpper/Q128),'Paper fee interval credit invalid');
  const lower=currentLower+(old?BigInt(old.lowerRawQ128):0n);
  const upper=currentUpper+(old?BigInt(old.upperRawQ128):0n);
  assert(lower>=0n&&upper>=lower,'Paper fee credit bounds invalid');
  return {lowerRawQ128:String(lower),upperRawQ128:String(upper),
   lowerAmountRaw:String(lower/Q128),upperAmountRaw:String(upper/Q128)};
 };
 return {kind:'paper_fee_carry_v1',pool:interval.pool,
  token0Address:interval.token0Address,token1Address:interval.token1Address,
  fee:interval.fee,tickSpacing:interval.tickSpacing,range:interval.range,
  liquidity:interval.liquidity,stream:interval.coverage.stream,
  targetSetHash:interval.coverage.targetSetHash,from:previous?.from??interval.from,
  through:interval.to,token0:sum(0),token1:sum(1),
  intervals:(previous?.intervals??0)+1,events:(previous?.events??0)+interval.events,
  segments:(previous?.segments??0)+interval.segments,
  partialSegments:(previous?.partialSegments??0)+interval.partialSegments,
  accounting:'modeled_hypothetical_fee_share'};
}
