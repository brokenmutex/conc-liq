// Read-only live-ledger and canonical quote audit. No signer or broadcaster.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {encodeFunctionData} from 'viem';
import {replayBoundedApprovals} from '../src/research/live-execution-cost.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.ts';
import {factoryAbi} from '../src/abi.ts';
import {PAPER_NVDA} from '../src/paper/engine.ts';
import {PAPER_ROUTER,PAPER_QUOTER,paperQuoterAbi,paperRouterAbi} from '../src/paper/execution-abi.ts';
import {pilotGasValuer} from '../src/live-pilot/valuation.ts';
import {evaluatePaperReference} from '../src/paper/reference.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {sanitizeRiskError} from '../src/risk/evaluate.ts';

const [envPath,ledgerPath,out]=process.argv.slice(2);
assert(envPath&&ledgerPath&&out,'Usage: ENV LEDGER_JSON NEW_OUTPUT_DIRECTORY');
assert(!existsSync(out),'Use a new output directory');mkdirSync(out,{recursive:true});
const env=parseEnv(readFileSync(envPath,'utf8'));delete env.WALLET_PRIVATE_KEY;
const ledgerBytes=readFileSync(ledgerPath),ledger=JSON.parse(ledgerBytes),campaign=ledger.campaigns[0];
assert.equal(ledger.campaigns.length,1);const state=campaign.state,config=campaign.config;
const rpc=env.RH_INDEXER_RPC_URL??env.RH_RPC_URL;assert(rpc&&env.DATABASE_URL);
const health=new PostgresRpcHealthGate({connectionString:env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const client=createRobinhoodClient(rpc,15000,{beforeRequest:()=>health.assertBulkAllowed().then(()=>{}),retryCount:0});
const db=new pg.Client({connectionString:env.DATABASE_URL,options:'-c default_transaction_read_only=on',statement_timeout:15000});
const gasValuer=pilotGasValuer(client,config),key=(t,s)=>`${t.toLowerCase()}:${s.toLowerCase()}`;
const allowanceMap=s=>Object.fromEntries(s.allowances.map(a=>[key(a.token,a.spender),a.amount]));
const actions=ledger.actions.filter(a=>['confirmed','reverted'].includes(a.status)).sort((a,b)=>Number(a.nonce)-Number(b.nonce));
const normalized=actions.map(a=>{
  const p=a.plan,f=a.receipt.facts,b=a.before_state;
  const available=t=>t.toLowerCase()===USDG.toLowerCase()?String(BigInt(b.usdg)-BigInt(state.reserveUsdg)):b.nvda;
  return {id:a.id,nonce:Number(a.nonce),reverted:a.status==='reverted',before:allowanceMap(b),after:allowanceMap(a.receipt.after),gasQuote:a.receipt.gasValuation?.quote??null,
    ...(p.kind==='approve'?{approval:{key:key(p.token,p.spender),amount:p.amount,managedAvailable:available(p.token),swapRouter:p.spender.toLowerCase()===PAPER_ROUTER.toLowerCase()}}:{}),
    spends:a.status==='reverted'?[]:p.kind==='swap'?[{key:key(p.token===0?USDG:PAPER_NVDA,PAPER_ROUTER),amount:p.amountIn}]:p.kind==='mint'?
      [{key:key(USDG,NONFUNGIBLE_POSITION_MANAGER),amount:String(-BigInt(f.walletDeltas.usdg))},{key:key(PAPER_NVDA,NONFUNGIBLE_POSITION_MANAGER),amount:String(-BigInt(f.walletDeltas.nvda))}]:[]};
});
for(const t of ledger.transitions.filter(t=>t.state.phase==='closed'&&t.reason==='closed')) {
  const previous=actions.findLastIndex(a=>a.created_at<=t.at);assert(previous>=0);normalized[previous].clearAtBoundary=true;
}
const approvals=replayBoundedApprovals(normalized),routes=[];
const result={at:new Date().toISOString(),campaignId:state.id,ledgerSha256:createHash('sha256').update(ledgerBytes).digest('hex'),cutoff:ledger.at,
  executionEligible:false,approvals,routes};
const save=()=>writeFileSync(`${out}/audit.json`,JSON.stringify(result,null,2)+'\n');save();
console.log(JSON.stringify({stage:'approvals',original:approvals.originalApprovals,retained:approvals.retainedApprovals,omitted:approvals.omittedApprovals,omittedRecordedGasQuote:approvals.omittedRecordedGasQuote}));
try {
  await db.connect();
  for(const a of actions.filter(a=>a.plan.kind==='swap'&&a.status==='confirmed')){
    const management=ledger.transitions.filter(t=>t.at<=a.created_at).at(-1).state;
    if(management.phase!=='recenter')continue;
    const b=a.before_state,block=await client.getBlock({blockNumber:BigInt(b.block)});assert.equal(block.hash,b.hash);
    const row={nonce:a.nonce,actionId:a.id,source:{block:b.block,hash:b.hash,timestamp:b.timestamp},range:management.range,token:a.plan.token,amount:a.plan.amountIn,quotes:[],reference:null,gasPriceQuote:null};
    try{
      const risk=(await db.query('SELECT snapshot FROM risk_snapshot_runs WHERE block_number <= $1 ORDER BY block_number DESC,id DESC LIMIT 1',[b.block])).rows[0]?.snapshot;
      assert(risk&&Number(b.timestamp)-Date.parse(risk.blockTimestamp)/1000<=180,'Historical risk source unavailable');
      row.reference=evaluatePaperReference({snapshot:risk,checkpoint:b,policy:config.strategy.referencePolicy});
      assert(row.reference.eligible,'Historical independent reference unavailable');
      row.gasPriceQuote=await gasValuer(row.source,String(10n**18n));
    }catch(e){row.valuationError=sanitizeRiskError(e);}
    for(const fee of [100,500,3000,10000]){
      const q={fee};row.quotes.push(q);
      try{
        q.pool=await client.readContract({address:UNISWAP_V3_FACTORY,abi:factoryAbi,functionName:'getPool',args:[USDG,PAPER_NVDA,fee],blockNumber:block.number});
        assert(!/^0x0+$/.test(q.pool),'Pool missing');
        const args={tokenIn:a.plan.token===0?USDG:PAPER_NVDA,tokenOut:a.plan.token===0?PAPER_NVDA:USDG,amountIn:BigInt(a.plan.amountIn),fee,sqrtPriceLimitX96:0n};
        const quote=(await client.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[args],blockNumber:block.number})).result;
        assert(quote[0]>0n);q.amountOut=String(quote[0]);q.sqrtAfter=String(quote[1]);
        if(fee===500)assert.equal(q.amountOut,a.plan.quotedOut,'Saved canonical quote mismatch');
        const swap=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{...args,recipient:state.operator,amountOutMinimum:quote[0]*9950n/10000n}]});
        const data=encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',args:[BigInt(b.timestamp)+300n,[swap]]});
        const call={account:state.operator,to:PAPER_ROUTER,data,blockNumber:block.number};await client.call(call);
        q.gas=String(await client.estimateGas(call));q.gasWei=String(BigInt(q.gas)*block.baseFeePerGas);
        q.gasQuote=row.gasPriceQuote?String(BigInt(q.gasWei)*BigInt(row.gasPriceQuote.quote)/10n**18n):null;
        q.outputReferenceQuote=row.reference?.eligible?String(a.plan.token===1?quote[0]:quote[0]*BigInt(row.reference.referencePriceX18)/10n**30n):null;
      }catch(e){q.error=sanitizeRiskError(e);}
    }
    const base=row.quotes.find(q=>q.fee===500);assert(base?.amountOut===a.plan.quotedOut,'Baseline quote did not reproduce');
    for(const q of row.quotes){q.netSwapDeltaQuote=!q.error&&!base.error&&q.outputReferenceQuote!==null&&base.outputReferenceQuote!==null&&q.gasQuote!==null&&base.gasQuote!==null?
      String(BigInt(q.outputReferenceQuote)-BigInt(base.outputReferenceQuote)-BigInt(q.gasQuote)+BigInt(base.gasQuote)):null;}
    assert.equal((await client.getBlock({blockNumber:block.number})).hash,b.hash);routes.push(row);save();
    console.log(JSON.stringify({stage:'route',nonce:a.nonce,quotes:row.quotes.map(q=>({fee:q.fee,netSwapDeltaQuote:q.netSwapDeltaQuote,unavailable:!!q.error}))}));
  }
}finally{save();await db.end();await health.close();}
