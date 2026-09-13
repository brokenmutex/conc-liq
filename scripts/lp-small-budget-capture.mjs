// Read-only snapshot: no controller, signer, migrations or broadcast client.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {createRobinhoodClient} from '../src/client.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {factoryAbi,poolAbi} from '../src/abi.ts';
import {USDG,UNISWAP_V3_FACTORY} from '../src/constants.ts';
import {PAPER_QUOTER,paperQuoterAbi} from '../src/paper/execution-abi.ts';
import {marketRange} from '../src/paper/market.ts';
import {sizeLiquidityForQuoteBudget} from '../src/simulator/math.ts';
const [envPath,root]=process.argv.slice(2);assert(envPath&&root);
mkdirSync(root,{recursive:true});
const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const save=(name,v)=>writeFileSync(root+'/'+name,JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x,2)+'\n',{flag:'wx'});
const e=parseEnv(readFileSync(envPath,'utf8')),cfg=loadIndexerConfig(e),db=new pg.Client({connectionString:e.DATABASE_URL});
const gate=new PostgresRpcHealthGate({connectionString:e.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const client=createRobinhoodClient(cfg.rpcUrl,20000,{beforeRequest:()=>gate.assertBulkAllowed().then(()=>{}),retryCount:0});
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 if(!existsSync(root+'/live-ledger.json')){
  const campaign=(await db.query('SELECT id,state,config->\'strategy\' AS strategy,heartbeat_at FROM live_pilot_v1.campaigns ORDER BY heartbeat_at DESC LIMIT 1')).rows[0];assert(campaign);
  const actions=(await db.query(`SELECT id,nonce::text,intent->>'action' AS action,plan,before_state,status,hash,receipt,created_at,broadcast_at,error FROM live_pilot_v1.actions WHERE campaign_id=$1 ORDER BY created_at,id`,[campaign.id])).rows;
  const transitions=(await db.query('SELECT id::text,at,reason,state FROM live_pilot_v1.transitions WHERE campaign_id=$1 ORDER BY id',[campaign.id])).rows;
  save('live-ledger.json',{at:new Date().toISOString(),campaign,actions,transitions,readOnly:true});
  console.log(JSON.stringify({stage:'ledger_saved',actions:actions.length,transitions:transitions.length}));
 }
 await db.query('COMMIT');
 if(existsSync(root+'/screen.json'))process.exitCode=0;
 else{
  const base='data/asset-expansion-2026-09-13',catalog=read(base+'/catalog.json'),tokens=read(base+'/tokens.json');
  const assets=new Map(tokens.tokens.filter(t=>t.identity_verified&&t.status==='ASSET_STATUS_ACTIVE').map(t=>[t.address.toLowerCase(),t]));
  const quote=USDG.toLowerCase(),pools=catalog.pools.filter(p=>p.kind==='v3'&&(p.token0===quote||p.token1===quote)&&assets.has(p.token0===quote?p.token1:p.token0));
  assert.equal(await client.getChainId(),4663);const blockNumber=await client.getBlockNumber()-128n,anchor=await client.getBlock({blockNumber});
  const rows=[];
  for(let offset=0;offset<pools.length;offset+=3){
   const batch=await Promise.allSettled(pools.slice(offset,offset+3).map(async p=>{
    const asset=assets.get(p.token0===quote?p.token1:p.token0),address=p.id;
    const r=await Promise.all(['token0','token1','fee','tickSpacing','liquidity','slot0'].map(functionName=>client.readContract({address,abi:poolAbi,functionName,blockNumber})));
    const canonical=await client.readContract({address:UNISWAP_V3_FACTORY,abi:factoryAbi,functionName:'getPool',args:[USDG,asset.address,p.fee_raw],blockNumber});
    assert.equal(canonical.toLowerCase(),address);assert.equal(r[0].toLowerCase(),p.token0);assert.equal(r[1].toLowerCase(),p.token1);assert.equal(r[2],p.fee_raw);assert.equal(r[3],p.tick_spacing);
    const row={symbol:asset.symbol,pool:address,rwa:asset.address,fee:r[2],spacing:r[3],liquidity:String(r[4]),price:String(r[5][0]),tick:r[5][1],reasons:[],probes:[],widths:[]};
    if(r[4]===0n)row.reasons.push('zero_active_liquidity');if(!r[5][6])row.reasons.push('pool_locked');
    if(!row.reasons.length){
     for(const budget of [240000000n,250000000n]){
      const input=budget/2n,price=r[5][0],ideal=p.token0===quote?input*price**2n/(1n<<192n):input*(1n<<192n)/price**2n;
      try{
       const buy=(await client.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber,args:[{tokenIn:USDG,tokenOut:asset.address,fee:r[2],amountIn:input,sqrtPriceLimitX96:0n}]})).result;
       // Independent same-state sell probe. It is not a sequential round trip.
       const sell=(await client.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber,args:[{tokenIn:asset.address,tokenOut:USDG,fee:r[2],amountIn:ideal,sqrtPriceLimitX96:0n}]})).result;
       row.probes.push({budgetQuote:String(budget),buyInputQuote:String(input),buyOutput:String(buy[0]),buyIdealOutput:String(ideal),sellInputRwa:String(ideal),sellOutputQuote:String(sell[0]),sellIdealOutputQuote:String(input),buyPass:buy[0]*10000n>=ideal*9950n,sellPass:sell[0]*10000n>=input*9950n,buyShortfallPpm:ideal?String((ideal-buy[0])*1000000n/ideal):null,sellShortfallPpm:String((input-sell[0])*1000000n/input)});
      }catch{row.probes.push({budgetQuote:String(budget),error:'quote_unavailable',buyPass:false,sellPass:false});}
     }
     for(const target of [80,160]){const width=Math.ceil(target/r[3])*r[3];try{const range=marketRange(r[5][0],r[5][1],width,r[3]),sized=sizeLiquidityForQuoteBudget({budgetQuote:240000000n,quoteToken:quote,token0:p.token0,token1:p.token1,sqrtPriceX96:r[5][0],...range});row.widths.push({target,width,...range,sharePpm:String(sized.liquidity*1000000n/(r[4]+sized.liquidity))});}catch{row.reasons.push('width_unavailable');}}
    }
    row.capacityPass=!row.reasons.length&&row.probes.some(p=>p.budgetQuote==='240000000'&&p.buyPass&&p.sellPass);
    row.originalReplayCompatible=r[2]===500&&r[3]===10;
    return row;
   }));
   for(let i=0;i<batch.length;i++){const r=batch[i];if(r.status==='fulfilled')rows.push(r.value);else throw new Error('Screen read failed for '+pools[offset+i].id+': '+String(r.reason?.shortMessage??r.reason?.message).replace(/https?:\/\/\S+/g,'[endpoint]'));}
   console.log(JSON.stringify({stage:'screen',processed:rows.length,total:pools.length}));
  }
  assert.equal((await client.getBlock({blockNumber})).hash,anchor.hash);
  save('screen.json',{at:new Date().toISOString(),anchor:{block:String(blockNumber),hash:anchor.hash,timestamp:String(anchor.timestamp)},catalogAnchor:catalog.anchor,catalogSha256:hash(base+'/catalog.json'),tokensSha256:hash(base+'/tokens.json'),rows,executionEligible:false,limitations:['Frozen September 13 catalogue and asset identities; current pinned pool state. Newly created pools after that catalogue are not discovered.','Independent half-budget buy and sell probes, not exact inventory funding or terminal guarantees.','No narrow-width exclusion; grid-rounded widths and other fee tiers need distinct replay validation.','Current issuer and reference eligibility is separate.']});
 }
 if(!existsSync(root+'/universe.json')){
  const screen=read(root+'/screen.json'),old=read('data/asset-expansion-2026-09-13/universe.json');
  const rows=screen.rows.map(r=>{const p=old.rows.find(p=>p.pool===r.pool);assert(p);return {...p,sqrtPriceX96:r.price,tick:r.tick,liquidity:r.liquidity};});
  save('universe.json',{anchor:{number:Number(screen.anchor.block),hash:screen.anchor.hash,timestamp:Number(screen.anchor.timestamp)},rows});
 }
}finally{await db.end();await gate.close();}
