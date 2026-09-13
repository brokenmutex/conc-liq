import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {factoryAbi,poolAbi} from '../src/abi.ts';
import {USDG,UNISWAP_V3_FACTORY} from '../src/constants.ts';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.ts';
import {marketRange} from '../src/paper/market.ts';
import {PAPER_QUOTER,paperQuoterAbi} from '../src/paper/execution-abi.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
const dir=process.argv[2];assert(dir,'Usage: node --import tsx scripts/lp-asset-universe.mjs ARTIFACT_DIRECTORY [READ_ONLY_ENV]');
const env=parseEnv(readFileSync(process.argv[3]??'data/live-pilot-runtime.env','utf8')),cfg=loadIndexerConfig(env);
const gate=new PostgresRpcHealthGate({connectionString:env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const client=createRobinhoodClient(cfg.rpcUrl,20000,{beforeRequest:()=>gate.assertBulkAllowed().then(()=>{}),retryCount:0});
const text=readFileSync(dir+'/catalog.json','utf8'),catalog=JSON.parse(text),tokens=JSON.parse(readFileSync(dir+'/tokens.json','utf8'));
const assets=new Map(tokens.tokens.filter(t=>t.identity_verified&&t.status==='ASSET_STATUS_ACTIVE').map(t=>[t.address.toLowerCase(),t]));
const blockNumber=BigInt(catalog.anchor.number),quote=USDG.toLowerCase();
const candidates=catalog.pools.filter(p=>p.kind==='v3'&&(p.token0===quote||p.token1===quote)&&assets.has(p.token0===quote?p.token1:p.token0));
const rows=[];const json=v=>JSON.stringify(v,(_,n)=>typeof n==='bigint'?String(n):n,2)+'\n';
try{
 assert.equal(await client.getChainId(),4663);assert.equal((await client.getBlock({blockNumber})).hash,catalog.anchor.hash);
 for(let offset=0;offset<candidates.length;offset+=4){
  const batch=await Promise.all(candidates.slice(offset,offset+4).map(async p=>{
   const asset=assets.get(p.token0===quote?p.token1:p.token0),address=p.id;
   const [canonical,t0,t1,fee,spacing,liquidity,slot]=await Promise.all([
    client.readContract({address:UNISWAP_V3_FACTORY,abi:factoryAbi,functionName:'getPool',args:[USDG,asset.address,p.fee_raw],blockNumber}),
    ...['token0','token1','fee','tickSpacing','liquidity','slot0'].map(functionName=>client.readContract({address,abi:poolAbi,functionName,blockNumber}))]);
   assert(canonical.toLowerCase()===address&&t0.toLowerCase()===p.token0&&t1.toLowerCase()===p.token1&&fee===p.fee_raw&&spacing===p.tick_spacing,'Pool identity mismatch');
   const reasons=[];if(liquidity===0n)reasons.push('zero_active_liquidity');if(40%spacing!==0)reasons.push('20_tick_half_width_unavailable_on_grid');
   const row={symbol:asset.symbol,address:asset.address,decimals:asset.decimals,pool:address,token0:p.token0,token1:p.token1,fee,spacing,createdBlock:p.created_block,
    liquidity:String(liquidity),sqrtPriceX96:String(slot[0]),tick:slot[1],unlocked:slot[6],reasons,range:null,positionLiquidity:null,sharePpm:null,entryQuote:null};
   if(!slot[6])reasons.push('pool_locked');
   if(!reasons.length){
    row.range=marketRange(slot[0],slot[1],20,spacing);
    const sized=sizeLiquidityForQuoteBudget({budgetQuote:5000000000n,quoteToken:quote,token0:p.token0,token1:p.token1,sqrtPriceX96:slot[0],...row.range});
    row.positionLiquidity=String(sized.liquidity);row.sharePpm=String(sized.liquidity*1000000n/(liquidity+sized.liquidity));
    try{const q=await client.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber,args:[{tokenIn:USDG,tokenOut:asset.address,fee,amountIn:2500000000n,sqrtPriceLimitX96:0n}]});
     const fair=p.token0===quote?2500000000n*slot[0]*slot[0]/(1n<<192n):2500000000n*(1n<<192n)/(slot[0]*slot[0]);
     row.entryQuote={amountInQuote:'2500000000',amountOut:String(q.result[0]),shortfallPpm:fair>0n?String((fair-q.result[0])*1000000n/fair):null,priceAfter:String(q.result[1]),basis:'current_2500_USDG_buy_probe_not_exact_entry_size'};
    }catch(e){row.entryQuote={error:'current_buy_probe_failed'};}
   }
   return row;
  }));rows.push(...batch);if(offset%20===0)console.log(json({processed:rows.length,total:candidates.length}).trim());
 }
 assert.equal((await client.getBlock({blockNumber})).hash,catalog.anchor.hash);
 const out={version:1,checkedAt:new Date().toISOString(),anchor:catalog.anchor,assetSnapshotBlock:tokens.snapshot_block,sourceSha256:createHash('sha256').update(text).digest('hex'),budgetQuote:'5000000000',halfWidthTicks:20,
  assets:assets.size,catalogPools:catalog.pools.length,v3Pools:catalog.pools.filter(p=>p.kind==='v3').length,rows,executionEligible:false,
  limitations:['Current capacity and quote probes are a screen, not historical LP profitability.','Reference and issuer trading gates are not yet promoted for new assets.','Historical replay must use each pool token order.','No 2 percent liquidity-share exclusion; share and price-impact evidence are reported.']};
 writeFileSync(dir+'/universe.json',json(out));console.log(json({assets:out.assets,v3Pools:out.v3Pools,usdgPools:rows.length,compatible:rows.filter(r=>!r.reasons.length).length}));
}finally{await gate.close();}
