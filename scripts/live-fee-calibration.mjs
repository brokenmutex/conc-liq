// W0: calibrate modeled fee capture and fill cost against the live pilot.
//
// The paper model credits fees at `feePpm` = 1,000,000 (100% of the diluted
// segment share) and fills swaps and mints at the quoted amounts. The only
// realized data that can price those two assumptions is the 250-USDG NVDA
// campaign `f8affe19` (2026-09-12 14:24 to 2026-09-15 05:50 UTC).
//
// Part 1 (fee share). Every confirmed mint opens a holding segment that a
// confirmed withdraw closes. The withdraw receipt carries both a
// DecreaseLiquidity and a Collect event, and their difference is the fee the
// pool actually paid that position. Against that we put the credit the paper
// model would have booked: the canonical pool book is rebuilt at the mint
// block from Mint/Burn/SetFeeProtocol history, every event to the withdraw
// block is replayed through `ExperimentMarket`, and each fee segment is
// scored with the same `virtualFeeCredit` the paper accrual uses, at the
// position's real liquidity and range.
//
// One bias has to be reported separately. The canonical book already contains
// our own liquidity, because we were a real LP; the paper model treats the
// position as liquidity added on top and divides by (segment.liquidity +
// ours). The `undiluted` column re-scores the same allocations at ours/L,
// which is the share the pool itself applied, and isolates that self-inclusion
// from everything else.
//
// Part 2 (fill cost). Realized swap output against the QuoterV2 quote frozen
// at the source block (`routes.json`), and realized mint legs against the
// planned legs, both in bps.
//
// Read-only: the database is opened read-only and nothing is written outside
// the output path.
//
// Usage: [RESEARCH_DATABASE_URL=...] <release>/bin/node scripts/live-fee-calibration.mjs OUT.json
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const R=process.env.CONC_LIQ_RELEASE??'/root/conc-liq-releases/ed9a77be0a0c15bf7e3c4fc1d79e8d3ad8a10bb70081888c989483c47f8857cf';
const require=createRequire(R+'/package.json');
const pg=require('pg');
const {ExperimentMarket}=await import(R+'/dist/src/experiment/market.js');
const {virtualFeeCredit}=await import(R+'/dist/src/research/virtual-fees.js');
const {researchDatabaseUrl}=await import('./sim-source.mjs');

const Q128=1n<<128n;
const [outPath]=process.argv.slice(2);
assert(outPath,'usage: live-fee-calibration.mjs OUT.json');

const LEDGER='/root/conc-liq/data/live-cost-analysis-2026-09-17/ledger.json';
const ROUTES='/root/conc-liq/data/live-cost-analysis-2026-09-17/routes.json';
const STREAM='robinhood-v3-rwa-usdg-v1';
const POOL='0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3';  // NVDA/USDG fee 500

const ledger=JSON.parse(readFileSync(LEDGER,'utf8'));
const routes=JSON.parse(readFileSync(ROUTES,'utf8'));
const confirmed=ledger.actions.filter(a=>a.status==='confirmed');

// ---------------------------------------------------------------- segments
const opens=new Map();
const segments=[];
for(const a of confirmed){
  const ev=a.receipt?.facts?.liquidityEvents??[];
  if(a.plan.kind==='mint'){
    const inc=ev.find(e=>e.kind==='IncreaseLiquidity');
    if(!inc)continue;
    opens.set(inc.tokenId,{tokenId:inc.tokenId,nonce:Number(a.nonce),
      block:BigInt(a.receipt.facts.block),at:a.receipt.facts.blockTimestamp??null,
      tickLower:a.plan.tickLower,tickUpper:a.plan.tickUpper,
      liquidity:BigInt(inc.liquidity),minted0:BigInt(inc.amount0),minted1:BigInt(inc.amount1),
      planned0:BigInt(a.plan.amount0),planned1:BigInt(a.plan.amount1),
      priceAfter:BigInt(a.receipt.after.sqrtPriceX96),tickAfter:a.receipt.after.tick,
      poolLiquidityAfter:BigInt(a.receipt.after.poolLiquidity)});
  }else if(a.plan.kind==='withdraw'){
    const dec=ev.find(e=>e.kind==='DecreaseLiquidity'),col=ev.find(e=>e.kind==='Collect');
    if(!dec||!col)continue;
    const open=opens.get(dec.tokenId);
    assert(open,`withdraw without open for ${dec.tokenId}`);
    opens.delete(dec.tokenId);
    assert.equal(String(dec.liquidity),String(open.liquidity),'partial withdraw unsupported');
    segments.push({...open,
      closeNonce:Number(a.nonce),closeBlock:BigInt(a.receipt.facts.block),
      principal0:BigInt(dec.amount0),principal1:BigInt(dec.amount1),
      realizedFee0:BigInt(col.amount0)-BigInt(dec.amount0),realizedFee1:BigInt(col.amount1)-BigInt(dec.amount1),
      closePrice:BigInt(a.receipt.after.sqrtPriceX96),closeTick:a.receipt.after.tick});
  }
}
assert.equal(opens.size,0,`unclosed positions: ${[...opens.keys()]}`);
segments.sort((a,b)=>Number(a.block-b.block));
console.error(`segments: ${segments.length}`);

// ---------------------------------------------------------------- pool book
const db=new pg.Client({connectionString:researchDatabaseUrl(),
  options:'-c default_transaction_read_only=on'});
await db.connect();
await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

const firstBlock=segments[0].block,lastBlock=segments.at(-1).closeBlock;
const seedRows=(await db.query(`SELECT event_name,event_args FROM v3_pool_events
  WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number<=$3
    AND event_name IN ('Mint','Burn','SetFeeProtocol')
  ORDER BY block_number,transaction_index,log_index`,[STREAM,POOL,String(firstBlock)])).rows;
const ticks=new Map();let protocol0=0,protocol1=0;
for(const e of seedRows){const a=e.event_args;
  if(e.event_name==='SetFeeProtocol'){protocol0=Number(a.feeProtocol0New);protocol1=Number(a.feeProtocol1New);continue;}
  const change=BigInt(a.amount)*(e.event_name==='Burn'?-1n:1n);
  for(const [tick,sign] of [[Number(a.tickLower),1n],[Number(a.tickUpper),-1n]]){
    const t=ticks.get(tick)??{gross:0n,net:0n};t.gross+=change;t.net+=change*sign;assert(t.gross>=0n);
    if(t.gross===0n){assert.equal(t.net,0n);ticks.delete(tick);}else ticks.set(tick,t);}
}
const seedLiquidity=[...ticks].filter(([t])=>t<=segments[0].tickAfter).reduce((n,[,t])=>n+t.net,0n);
const book=new ExperimentMarket({price:String(segments[0].priceAfter),tick:segments[0].tickAfter,
  liquidity:String(seedLiquidity),global0:'0',global1:'0',protocol0,protocol1,
  ticks:[...ticks].map(([tick,t])=>({tick,gross:String(t.gross),net:String(t.net)}))});
assert.equal(String(book.liquidity),String(segments[0].poolLiquidityAfter),
  'seeded pool liquidity disagrees with the mint receipt');

const events=(await db.query(`SELECT block_number::text AS block,block_hash AS hash,transaction_index AS tx,log_index AS log,
    event_name AS name,event_args AS args FROM v3_pool_events
  WHERE stream_key=$1 AND lower(pool_address)=$2 AND block_number>$3 AND block_number<=$4
  ORDER BY block_number,transaction_index,log_index`,[STREAM,POOL,String(firstBlock),String(lastBlock)])).rows;
console.error(`events: ${events.length} over blocks ${firstBlock}..${lastBlock}`);

// ---------------------------------------------------- replay and score
const results=[];
let ei=0;
for(const s of segments){
  // Advance the book to the segment's open block without crediting anything.
  while(ei<events.length&&BigInt(events[ei].block)<=s.block)book.apply(events[ei++]);
  let diluted0=0n,diluted1=0n,undiluted0=0n,undiluted1=0n,scored=0,partial=0,inRangeSegments=0;
  let maxSharePpm=0n;
  while(ei<events.length&&BigInt(events[ei].block)<=s.closeBlock){
    for(const {segment,protocol} of book.apply(events[ei])){
      const c=virtualFeeCredit(segment,s,s.liquidity,protocol);
      scored++;
      if(c.lower>0n||c.allocatedLower>0n){
        inRangeSegments++;
        if(c.partial)partial++;
        const share=s.liquidity*1000000n/segment.liquidity;
        if(share>maxSharePpm)maxSharePpm=share;
        // Undiluted: the share the pool itself applied, ours/L, on the same
        // allocation. Diluted: ours/(L+ours), as the paper model books it.
        const undil=c.allocatedLower*Q128/segment.liquidity*s.liquidity;
        if(segment.token===0){diluted0+=c.lower;undiluted0+=undil;}
        else{diluted1+=c.lower;undiluted1+=undil;}
      }
    }
    ei++;
  }
  assert.equal(String(book.price),String(s.closePrice),`book price mismatch at close of ${s.tokenId}`);
  results.push({tokenId:s.tokenId,openNonce:s.nonce,closeNonce:s.closeNonce,
    openBlock:String(s.block),closeBlock:String(s.closeBlock),
    tickLower:s.tickLower,tickUpper:s.tickUpper,liquidity:String(s.liquidity),
    openTick:s.tickAfter,closeTick:s.closeTick,
    poolLiquidityAtOpen:String(s.poolLiquidityAfter),maxLiquiditySharePpm:String(maxSharePpm),
    realizedFee0:String(s.realizedFee0),realizedFee1:String(s.realizedFee1),
    modeledFee0:String(diluted0/Q128),modeledFee1:String(diluted1/Q128),
    undilutedFee0:String(undiluted0/Q128),undilutedFee1:String(undiluted1/Q128),
    feeSegments:scored,inRangeSegments,partialSegments:partial,
    principal0:String(s.principal0),principal1:String(s.principal1),
    minted0:String(s.minted0),minted1:String(s.minted1),
    planned0:String(s.planned0),planned1:String(s.planned1)});
}
await db.query('COMMIT');await db.end();

// -------------------------------------------------------------- fill model
const swapRows=[];
for(const a of confirmed.filter(a=>a.plan.kind==='swap')){
  const d=a.receipt.facts.walletDeltas;
  const outToken=a.plan.token===0?'nvda':'usdg';
  const realized=BigInt(d[outToken]);
  assert(realized>0n,'swap output must be positive');
  const quoted=BigInt(a.plan.quotedOut);
  swapRows.push({nonce:Number(a.nonce),token:a.plan.token,amountIn:String(a.plan.amountIn),
    quotedOut:String(quoted),realizedOut:String(realized),
    shortfallBps:Number((quoted-realized)*10000n*1000n/quoted)/1000,
    quoteBlock:String(a.before_state.block),fillBlock:String(a.receipt.facts.block),
    blocksLate:Number(BigInt(a.receipt.facts.block)-BigInt(a.before_state.block))});
}
const mintRows=results.map(r=>{
  const leg=(planned,minted)=>planned==='0'?null:Number((BigInt(planned)-BigInt(minted))*10000n*1000n/BigInt(planned))/1000;
  return {tokenId:r.tokenId,nonce:r.openNonce,planned0:r.planned0,minted0:r.minted0,planned1:r.planned1,minted1:r.minted1,
    leg0ShortfallBps:leg(r.planned0,r.minted0),leg1ShortfallBps:leg(r.planned1,r.minted1)};
});

// Route re-quote gains keyed by nonce, for the W4.4 cross-check.
const routeByNonce=new Map(routes.rows.map(r=>[r.nonce,r]));
for(const s of swapRows){const r=routeByNonce.get(s.nonce);s.bestTierGainBps=r?.best?.bps??null;s.bestTier=r?.best?.fee??null;}

const sum=(rows,key)=>rows.reduce((n,r)=>n+BigInt(r[key]),0n);
const pooled={
  segments:results.length,
  realizedFee0:String(sum(results,'realizedFee0')),realizedFee1:String(sum(results,'realizedFee1')),
  modeledFee0:String(sum(results,'modeledFee0')),modeledFee1:String(sum(results,'modeledFee1')),
  undilutedFee0:String(sum(results,'undilutedFee0')),undilutedFee1:String(sum(results,'undilutedFee1'))};
writeFileSync(outPath,JSON.stringify({generatedAt:new Date().toISOString(),release:R,
  campaign:ledger.campaigns[0].id,pool:POOL,stream:STREAM,
  ledgerAt:ledger.at,segments:results,pooled,swaps:swapRows,mints:mintRows},null,1));
console.error('wrote',outPath);
