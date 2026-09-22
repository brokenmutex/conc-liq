import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sqrtRatioAtTick} from '../src/backtest/principal.js';
import {ExperimentMarket,type MarketSeed} from '../src/experiment/market.js';
import {historicalSwapQuote} from '../src/research/portfolio-math.js';
import {replayPaperFeeInterval,type PaperFeeFrame} from '../src/deployments/paper-fee-replay.js';

const hashA='0x'+'a'.repeat(64),hashB='0x'+'b'.repeat(64),Q128=1n<<128n;
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
