// Matched source, inventory and LP range. All execution stays on owned Anvil.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {decodeFunctionResult,encodeFunctionData} from 'viem';
import {openPaperFork} from '../src/paper/fork.ts';
import {createPaperExecutionContext} from '../src/paper/execution.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.ts';
import {poolAbi} from '../src/abi.ts';
import {PAPER_NVDA,PAPER_POOL} from '../src/paper/engine.ts';
import {PAPER_ROUTER,PAPER_QUOTER,paperRouterAbi,paperQuoterAbi} from '../src/paper/execution-abi.ts';
import {guardedCanaryPositionManagerAbi} from '../src/canary-plan/abi.ts';
import {readCanaryPosition} from '../src/canary-plan/exit.ts';
import {principalAmounts} from '../src/backtest/principal.ts';
import {replayPaperMint} from '../src/research/management-audit.ts';
import {solveRecenterSwap} from '../src/paper/execution-recenter.ts';
import {compareCostedRoutes} from '../src/research/live-execution-cost.ts';
import {sanitizeRiskError} from '../src/risk/evaluate.ts';

const [envPath,ledgerPath,auditPath,out,nonceList]=process.argv.slice(2);
assert(envPath&&ledgerPath&&auditPath&&out,'Usage: ENV LEDGER AUDIT NEW_OUTPUT_DIRECTORY [NONCES]');
assert(!existsSync(out),'Use a new output directory');mkdirSync(out,{recursive:true});
const env=parseEnv(readFileSync(envPath,'utf8'));delete env.WALLET_PRIVATE_KEY;
process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const ledger=JSON.parse(readFileSync(ledgerPath)),audit=JSON.parse(readFileSync(auditPath)),campaign=ledger.campaigns[0];
const config=campaign.config,state=campaign.state,operator=state.operator,reserve=BigInt(state.reserveUsdg);
const health=new PostgresRpcHealthGate({connectionString:env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>health.assertBulkAllowed().then(()=>{}),rpc=env.RH_INDEXER_RPC_URL??env.RH_RPC_URL;
const upstream=createRobinhoodClient(rpc,15000,{beforeRequest:beforeRead,retryCount:0});
const result={at:new Date().toISOString(),executionEligible:false,mainnetTransactions:0,scope:'paired_swap_and_mint_at_recorded_pre_swap_state',cases:[],
  limitations:['The preceding withdrawal and approvals are common sunk costs at this starting state.',
    'No intervening market flow or confirmation delay is simulated; historical throughput/fees and future exit remain outside this comparison.',
    'Gas is a pinned Nitro estimate using validated local prestate, not a mainnet receipt.']};
const save=()=>writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2)+'\n');
try {
  for(const r of audit.routes.filter(r=>nonceList?nonceList.split(',').includes(r.nonce):r.quotes.some(q=>q.netSwapDeltaQuote!==null&&BigInt(q.netSwapDeltaQuote)>0n))){
    const a=ledger.actions.find(a=>a.id===r.actionId);assert(a&&r.reference?.eligible&&r.gasPriceQuote&&r.range);
    const source=await upstream.getBlock({blockNumber:BigInt(r.source.block)});assert.equal(source.hash,r.source.hash);
    const row={nonce:r.nonce,source:r.source,range:r.range,branches:[]};result.cases.push(row);
    let fork;
    try{
      fork=await openPaperFork({source:{number:source.number,hash:source.hash,timestamp:source.timestamp},rpcUrl:rpc,beforeRead,maxRequests:1500,timeoutMs:300000});
      await fork.rpc('anvil_impersonateAccount',[operator]);
      // Both ordinary calls and full Nitro estimates must honor code overrides.
      const negative={from:operator,to:PAPER_ROUTER,data:a.intent.data};
      for(const method of ['eth_call','eth_estimateGas']){
        let reverted=false;
        try{await fork.read(method,[negative,fork.blockTag,{[PAPER_ROUTER]:{code:'0x60006000fd'}}]);}
        catch(e){assert(/revert/i.test(e.message),'Override control failed for an unrelated reason');reverted=true;}
        assert(reverted,'Upstream ignored reverting-code override');
      }
      row.overrideControlsPassed=true;
      const alternatives=r.quotes.filter(q=>q.fee===500||q.netSwapDeltaQuote!==null&&BigInt(q.netSwapDeltaQuote)>0n);
      for(const option of alternatives){
        if(row.branches.length){await fork.close();fork=await openPaperFork({source:{number:source.number,hash:source.hash,timestamp:source.timestamp},rpcUrl:rpc,beforeRead,maxRequests:1500,timeoutMs:300000});await fork.rpc('anvil_impersonateAccount',[operator]);}
        const branch={fee:option.fee,complete:false,transactions:[]};row.branches.push(branch);
        try{
          const ctx=await createPaperExecutionContext(fork,config.strategy,tx=>branch.transactions.push(tx),operator);
          const b=await ctx.balances();assert.equal(b.quote,a.before_state.usdg);assert.equal(b.rwa,a.before_state.nvda);
          const slot=await ctx.local.readContract({address:PAPER_POOL,abi:poolAbi,functionName:'slot0'});
          assert(slot[1]>=r.range.tickLower&&slot[1]<r.range.tickUpper,'Saved target range already crossed');
          const trade=await solveRecenterSwap(slot[0],r.range,BigInt(b.quote)-reserve,BigInt(b.rwa),async(amount,token)=>{
            const q=(await ctx.local.simulateContract({address:PAPER_QUOTER,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{
              tokenIn:token===0?USDG:PAPER_NVDA,tokenOut:token===0?PAPER_NVDA:USDG,amountIn:amount,fee:option.fee,sqrtPriceLimitX96:0n}]})).result;
            // Another pool's sqrt price is never used as the LP pool price.
            return {amountOut:q[0],price:option.fee===500?q[1]:slot[0]};
          });
          assert(trade.token!==null);branch.trade={token:trade.token,amount:String(trade.amount),amountOut:String(trade.amountOut)};
          if(option.fee===500){assert.equal(branch.trade.amount,a.plan.amountIn);assert.equal(branch.trade.amountOut,a.plan.quotedOut);}
          const token=trade.token===0?USDG:PAPER_NVDA;
          await ctx.approve(token,PAPER_ROUTER,trade.amount,'approve_swap');
          const call=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{tokenIn:token,tokenOut:trade.token===0?PAPER_NVDA:USDG,
            fee:option.fee,recipient:operator,amountIn:trade.amount,amountOutMinimum:trade.amountOut*9950n/10000n,sqrtPriceLimitX96:0n}]});
          await ctx.send('swap',PAPER_ROUTER,encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',args:[source.timestamp+300n,[call]]}));
          const afterSwap=await ctx.balances();
          assert.equal(BigInt(afterSwap.quote),BigInt(b.quote)+(trade.token===0?-trade.amount:trade.amountOut));
          assert.equal(BigInt(afterSwap.rwa),BigInt(b.rwa)+(trade.token===1?-trade.amount:trade.amountOut));
          const fresh=await ctx.local.readContract({address:PAPER_POOL,abi:poolAbi,functionName:'slot0'});
          if(option.fee!==500)assert.equal(fresh[0],slot[0],'Alternate swap unexpectedly changed destination pool');
          const free=BigInt(afterSwap.quote)-reserve,nvda=BigInt(afterSwap.rwa),mint=replayPaperMint(fresh[0],r.range,free,nvda,0n);
          assert(mint.liquidity>0n);await ctx.approve(USDG,NONFUNGIBLE_POSITION_MANAGER,free,'approve_mint_usdg');
          await ctx.approve(PAPER_NVDA,NONFUNGIBLE_POSITION_MANAGER,nvda,'approve_mint_nvda');
          const params={token0:USDG,token1:PAPER_NVDA,fee:500,...r.range,amount0Desired:free,amount1Desired:nvda,
            amount0Min:mint.amount0*9950n/10000n,amount1Min:mint.amount1*9950n/10000n,recipient:operator,deadline:source.timestamp+300n};
          const tx=await ctx.send('mint',NONFUNGIBLE_POSITION_MANAGER,encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[params]}));
          const [id,liquidity,amount0,amount1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,functionName:'mint',data:tx.returnData});
          assert.equal(liquidity,mint.liquidity);assert.equal(amount0,mint.amount0);assert.equal(amount1,mint.amount1);
          const nft=await readCanaryPosition(ctx.local,id,await ctx.local.getBlockNumber({cacheTime:0}));assert.equal(nft.owner.toLowerCase(),operator.toLowerCase());assert.equal(nft.liquidity,liquidity);
          const after=await ctx.balances();assert.equal(BigInt(after.quote),BigInt(afterSwap.quote)-amount0);assert.equal(BigInt(after.rwa),nvda-amount1);assert(BigInt(after.quote)>=reserve);
          const actualGas=ctx.transactions.reduce((n,t)=>n+BigInt(t.localGasUsed)*BigInt(t.localEffectiveGasPriceWei),0n);
          assert.equal(BigInt(b.native)-BigInt(after.native),actualGas);
          const principal=principalAmounts({liquidity,...r.range,sqrtPriceX96:fresh[0]});
          branch.costed={id:`fee-${option.fee}`,sourceBlock:r.source.block,sourceHash:r.source.hash,referencePriceX18:r.reference.referencePriceX18,
            amount0:String(BigInt(after.quote)-reserve+principal.amount0),amount1:String(BigInt(after.rwa)+principal.amount1),
            gasQuote:String(ctx.transactions.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei)*BigInt(r.gasPriceQuote.quote)/10n**18n,0n)),complete:true};
          branch.complete=true;branch.tokenId=String(id);branch.liquidity=String(liquidity);branch.wallet=after;
          branch.checks={reservedUsdgPreserved:true,swapReceiptDeltas:true,mintAmountsAndOwnership:true,nativeGasReconciled:true};
        }catch(e){branch.error=sanitizeRiskError(e);}
        branch.upstream=fork.budget;save();console.log(JSON.stringify({nonce:r.nonce,fee:branch.fee,complete:branch.complete,error:branch.error,gasQuote:branch.costed?.gasQuote}));
      }
      const base=row.branches.find(b=>b.fee===500);
      for(const branch of row.branches.filter(b=>b.fee!==500))if(base?.complete&&branch.complete)branch.comparison=compareCostedRoutes(base.costed,branch.costed);
      assert.equal((await upstream.getBlock({blockNumber:source.number})).hash,source.hash);row.upstream=fork.budget;
    }catch(e){row.error=sanitizeRiskError(e);}
    finally{await fork?.close();save();}
  }
}finally{save();await health.close();}
if(!result.cases.length||result.cases.some(c=>c.error||c.branches.length<2||c.branches.some(b=>!b.complete)))process.exitCode=1;
