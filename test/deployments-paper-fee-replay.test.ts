import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {ExperimentMarket,type MarketSeed} from '../src/experiment/market.js';
import {historicalSwapQuote} from '../src/research/portfolio-math.js';
import type {RobinhoodClient} from '../src/client.js';
import type {MarketProfile} from '../src/deployments/market-profile.js';
import {advancePaperFeeCarry,readAnchoredPaperFeeFrame,replayPaperFeeInterval,
 type CanonicalPaperFeeInterval,type PaperFeeFrame} from '../src/deployments/paper-fee-replay.js';

const hashA='0x'+'a'.repeat(64),hashB='0x'+'b'.repeat(64),hashC='0x'+'f'.repeat(64),Q128=1n<<128n;
const pool={address:'0x'+'c'.repeat(40),token0:'0x'+'d'.repeat(40),
 token1:'0x'+'e'.repeat(40),fee:3000,tickSpacing:60};
const seed=(tick=0):MarketSeed=>({price:String(sqrtRatioAtTick(tick)),tick,
 liquidity:'1000000000000',global0:'0',global1:'0',protocol0:0,protocol1:0,
 fee:3000,spacing:60,ticks:[{tick:-60,gross:'1000000000000',net:'1000000000000'},
  {tick:60,gross:'1000000000000',net:'-1000000000000'}]});
const frame=(block:string,hash:string,m:ExperimentMarket):PaperFeeFrame=>({
 source:{block,hash},poolState:{tick:m.tick,sqrtPriceX96:String(m.price),
  poolLiquidity:String(m.liquidity),feeGrowthGlobal0X128:String(m.global0),
  feeGrowthGlobal1X128:String(m.global1)}});

test('hypothetical fee replay dilutes an observed flash without pretending it was paid gas',()=>{
 const initial=seed(),m=new ExperimentMarket(initial),before=frame('100',hashA,m);
 const event={block:'101',hash:hashB,tx:0,log:0,name:'Flash',
  args:{paid0:'0',paid1:'10000'}};
 m.apply(event);const after=frame('101',hashB,m);
 const result=replayPaperFeeInterval(initial,[event],before,after,
  {tickLower:-60,tickUpper:60},1000000000000n,pool);
 assert.equal(result.token0.lowerAmountRaw,'0');
 assert.equal(result.token1.lowerAmountRaw,'4999');
 assert.equal(result.token1.upperAmountRaw,'4999');
 assert(BigInt(result.token1.lowerRawQ128)<5000n*Q128);
 assert(BigInt(result.token1.lowerRawQ128)>4999n*Q128);
 assert.equal(result.partialSegments,0);
 assert.equal(result.accounting,'modeled_hypothetical_fee_share');
 assert.equal(result.token0Address,pool.token0);
 const outside=replayPaperFeeInterval(initial,[event],before,after,
  {tickLower:60,tickUpper:120},1000000000000n,pool);
 assert.equal(outside.token1.upperAmountRaw,'0');
 assert.throws(()=>replayPaperFeeInterval(initial,[],before,after,
  {tickLower:-60,tickUpper:60},1000000000000n,pool),/Checkpoint fee1 mismatch/);
 assert.throws(()=>replayPaperFeeInterval(initial,[{...event,hash:hashA}],before,after,
  {tickLower:-60,tickUpper:60},1000000000000n,pool),/ending block hash mismatch/);
});

test('a fee-3000 spacing-60 swap produces bounded credit across a virtual boundary',()=>{
 const initial=seed(-30),m=new ExperimentMarket(initial),before=frame('100',hashA,m);
 const quote=historicalSwapQuote(m.source(),2000000000n,1,9999);
 assert(quote.fullyFilled&&quote.tickAfter>0&&quote.tickAfter<60);
 const event={block:'101',hash:hashB,tx:0,log:0,name:'Swap',args:{
  sqrtPriceX96:String(quote.sqrtPriceAfter),tick:quote.tickAfter,
  liquidity:String(quote.liquidityAfter),amount0:String(-quote.amountOut),
  amount1:String(quote.amountIn)}};
 m.apply(event);const after=frame('101',hashB,m);
 const result=replayPaperFeeInterval(initial,[event],before,after,
  {tickLower:0,tickUpper:60},1000000000000n,pool);
 assert.equal(result.partialSegments,1);
 assert(BigInt(result.token1.lowerRawQ128)>0n);
 assert(BigInt(result.token1.upperRawQ128)>=BigInt(result.token1.lowerRawQ128));
 assert.throws(()=>replayPaperFeeInterval({...initial,fee:500},[event],before,after,
  {tickLower:0,tickUpper:60},1000000000000n,pool),/explicit pool fee/);
 assert.throws(()=>replayPaperFeeInterval(initial,[event,event],before,after,
  {tickLower:0,tickUpper:60},1000000000000n,pool),/strictly ordered/);
});

test('anchored fee frame pins every read and fails if the source changes',async()=>{
 const calls:{functionName:string;blockNumber:bigint}[]= [];
 let hash=hashA,checks=0;
 const client={
  getBlock:async()=>{checks++;return {hash,timestamp:123n};},
  readContract:async(request:{functionName:string;blockNumber:bigint})=>{
   calls.push(request);
   switch(request.functionName){
    case 'slot0':return [sqrtRatioAtTick(0),0,0,0,0,0,true];
    case 'liquidity':return 1000n;
    case 'feeGrowthGlobal0X128':return 123n;
    case 'feeGrowthGlobal1X128':return 456n;
    default:throw Error('unexpected read');
   }
  },
 } as unknown as RobinhoodClient;
 const profile={pool:{pool:pool.address}} as MarketProfile;
 const source={block:'100',hash:hashA,timestamp:123};
 const frame=await readAnchoredPaperFeeFrame(client,profile,source);
 assert.equal(checks,2);
 assert.deepEqual(calls.map(call=>call.functionName),
  ['slot0','liquidity','feeGrowthGlobal0X128','feeGrowthGlobal1X128']);
 assert(calls.every(call=>call.blockNumber===100n));
 assert.equal(frame.poolState.feeGrowthGlobal1X128,'456');
 hash=hashB;
 await assert.rejects(readAnchoredPaperFeeFrame(client,profile,source),/source reorged/);
 hash=hashA;checks=0;
 const changing={
  getBlock:client.getBlock,
  readContract:async(request:{functionName:string;blockNumber:bigint})=>{
   const value=await client.readContract(request as never);
   if(request.functionName==='feeGrowthGlobal1X128')hash=hashB;
   return value;
  },
 } as unknown as RobinhoodClient;
 await assert.rejects(readAnchoredPaperFeeFrame(changing,profile,source),/source reorged/);
 assert.equal(checks,2);
});

test('verified fee carry preserves Q128 dust and rejects gaps and repeated intervals',()=>{
 const initial=seed(),m=new ExperimentMarket(initial),before=frame('100',hashA,m);
 const range={tickLower:-60,tickUpper:60};
 const event1={block:'101',hash:hashB,tx:0,log:0,name:'Flash',
  args:{paid0:'0',paid1:'10000'}};
 m.apply(event1);const middle=frame('101',hashB,m);
 const nextSeed:MarketSeed={...initial,global0:String(m.global0),global1:String(m.global1)};
 const event2={block:'102',hash:hashC,tx:0,log:0,name:'Flash',
  args:{paid0:'0',paid1:'10000'}};
 m.apply(event2);const after=frame('102',hashC,m);
 const verified=(proof:ReturnType<typeof replayPaperFeeInterval>):CanonicalPaperFeeInterval=>({
  ...proof,coverage:{stream:'test',targetSetHash:'set',completeThroughBlock:proof.to.block,
   completeThroughHash:proof.to.hash,chainAnchorRecheckRequired:false}});
 const first=verified(replayPaperFeeInterval(initial,[event1],before,middle,range,
  1000000000000n,pool));
 const second=verified(replayPaperFeeInterval(nextSeed,[event2],middle,after,range,
  1000000000000n,pool));
 const carry1=advancePaperFeeCarry(null,first,before.source);
 const carry2=advancePaperFeeCarry(carry1,second,before.source);
 assert.equal(carry2.intervals,2);
 assert.equal(carry2.token1.lowerRawQ128,
  String(BigInt(first.token1.lowerRawQ128)+BigInt(second.token1.lowerRawQ128)));
 assert.equal(carry2.token1.lowerAmountRaw,'9999');
 assert.equal(BigInt(first.token1.lowerAmountRaw)+BigInt(second.token1.lowerAmountRaw),9998n);
 assert.throws(()=>advancePaperFeeCarry(carry2,second,before.source),/gap or replay/);
 assert.throws(()=>advancePaperFeeCarry(null,second,before.source),/gap or replay/);
 assert.throws(()=>advancePaperFeeCarry(carry1,{...second,fee:500},before.source),/fee changed/);
 assert.throws(()=>advancePaperFeeCarry(carry1,{...second,coverage:{
  ...second.coverage,chainAnchorRecheckRequired:true as false}},before.source),/not rechecked/);
});
