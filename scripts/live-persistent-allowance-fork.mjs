// Matched source, inventory and LP range. All execution stays on owned Anvil.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {decodeFunctionResult,encodeFunctionData,maxUint256,keccak256} from 'viem';
import {openPaperFork} from '../src/paper/fork.ts';
import {createPaperExecutionContext} from '../src/paper/execution.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.ts';
import {poolAbi} from '../src/abi.ts';
import {PAPER_NVDA,PAPER_POOL} from '../src/paper/engine.ts';
import {PAPER_ROUTER,PAPER_QUOTER,paperRouterAbi,paperQuoterAbi,paperTokenAbi} from '../src/paper/execution-abi.ts';
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
const result={at:new Date().toISOString(),executionEligible:false,mainnetTransactions:0,scope:'persistent_allowance_swap_mint_cleanup_at_pinned_source',cases:[],
  limitations:['All branches start with zero allowances after a separately recorded normalization; setup, operation and cleanup costs are reported separately.',
    'No intervening market flow or confirmation delay is simulated; historical throughput/fees and future exit remain outside this comparison.',
    'Gas is a pinned Nitro estimate using validated local prestate, not a mainnet receipt.']};
const save=()=>writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2)+'\n');
try {
  for(const r of audit.routes.filter(r=>(nonceList??'84,134').split(',').includes(r.nonce))){
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
      const alternatives=['exact','finite','maximum'].map(mode=>({mode,fee:500}));
      for(const option of alternatives){
        if(row.branches.length){await fork.close();fork=await openPaperFork({source:{number:source.number,hash:source.hash,timestamp:source.timestamp},rpcUrl:rpc,beforeRead,maxRequests:1500,timeoutMs:300000});await fork.rpc('anvil_impersonateAccount',[operator]);}
        const branch={mode:option.mode,fee:option.fee,complete:false,transactions:[]};row.branches.push(branch);
        try{
          const ctx=await createPaperExecutionContext(fork,config.strategy,tx=>branch.transactions.push(tx),operator);
          const pairs=[USDG,PAPER_NVDA].flatMap(token=>[PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].map(spender=>({token,spender})));
          const allowances=async()=>Object.fromEntries(await Promise.all(pairs.map(async({token,spender})=>[`${token.toLowerCase()}:${spender.toLowerCase()}`,String(await ctx.local.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[operator,spender]}))])));
          branch.codeHashes=Object.fromEntries(await Promise.all([USDG,PAPER_NVDA,PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].map(async address=>[address,keccak256(await ctx.local.getBytecode({address}))])));
          for(const {token,spender} of pairs)if(BigInt((await allowances())[`${token.toLowerCase()}:${spender.toLowerCase()}`])>0n)
            await ctx.send('normalize_allowance',token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[spender,0n]}));
          const measuredStart=ctx.transactions.length;
          const b=await ctx.balances();assert.equal(b.quote,a.before_state.usdg);assert.equal(b.rwa,a.before_state.nvda);
          if(option.mode!=='exact')for(const {token,spender} of pairs){
            const amount=option.mode==='maximum'?maxUint256:token===USDG?2500n*10n**6n:10n*10n**18n;
            await ctx.send('setup_persistent',token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[spender,amount]}));
          }
          branch.afterSetup=await allowances();
          const operationStart=ctx.transactions.length;
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
          const afterSwap=await ctx.balances();branch.afterSwap=await allowances();
          assert.equal(BigInt(afterSwap.quote),BigInt(b.quote)+(trade.token===0?-trade.amount:trade.amountOut));
          assert.equal(BigInt(afterSwap.rwa),BigInt(b.rwa)+(trade.token===1?-trade.amount:trade.amountOut));
          const fresh=await ctx.local.readContract({address:PAPER_POOL,abi:poolAbi,functionName:'slot0'});
          if(option.fee!==500)assert.equal(fresh[0],slot[0],'Alternate swap unexpectedly changed destination pool');
          const free=BigInt(afterSwap.quote)-reserve,nvda=BigInt(afterSwap.rwa),mint=replayPaperMint(fresh[0],r.range,free,nvda,0n);
          assert(mint.liquidity>0n);await ctx.approve(USDG,NONFUNGIBLE_POSITION_MANAGER,free,'approve_mint_usdg');
          await ctx.approve(PAPER_NVDA,NONFUNGIBLE_POSITION_MANAGER,nvda,'approve_mint_nvda');
          const params={token0:USDG,token1:PAPER_NVDA,fee:500,...r.range,amount0Desired:free,amount1Desired:nvda,
            amount0Min:mint.amount0*9950n/10000n,amount1Min:mint.amount1*9950n/10000n,recipient:operator,deadline:source.timestamp+300n};
          branch.beforeMint=await allowances();const beforeFailedCall=await ctx.balances();
          // A failed mint must leave persistent permissions and custody unchanged.
          let failed=false;try{await ctx.local.call({account:operator,to:NONFUNGIBLE_POSITION_MANAGER,data:encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[{...params,amount0Min:maxUint256,amount1Min:maxUint256}]})});}catch(e){assert(/revert/i.test(e.message));failed=true;}
          assert(failed);assert.deepEqual(await allowances(),branch.beforeMint);assert.deepEqual(await ctx.balances(),beforeFailedCall);
          const tx=await ctx.send('mint',NONFUNGIBLE_POSITION_MANAGER,encodeFunctionData({abi:guardedCanaryPositionManagerAbi,functionName:'mint',args:[params]}));
          const [id,liquidity,amount0,amount1]=decodeFunctionResult({abi:guardedCanaryPositionManagerAbi,functionName:'mint',data:tx.returnData});
          assert.equal(liquidity,mint.liquidity);assert.equal(amount0,mint.amount0);assert.equal(amount1,mint.amount1);
          const nft=await readCanaryPosition(ctx.local,id,await ctx.local.getBlockNumber({cacheTime:0}));assert.equal(nft.owner.toLowerCase(),operator.toLowerCase());assert.equal(nft.liquidity,liquidity);
          const after=await ctx.balances();assert.equal(BigInt(after.quote),BigInt(afterSwap.quote)-amount0);assert.equal(BigInt(after.rwa),nvda-amount1);assert(BigInt(after.quote)>=reserve);
          branch.afterMint=await allowances();
          branch.spends=[{token,spender:PAPER_ROUTER,amount:String(trade.amount),before:option.mode==='exact'?String(trade.amount):branch.afterSetup[`${token.toLowerCase()}:${PAPER_ROUTER.toLowerCase()}`],after:branch.afterSwap[`${token.toLowerCase()}:${PAPER_ROUTER.toLowerCase()}`]},
            ...[USDG,PAPER_NVDA].map((token,i)=>({token,spender:NONFUNGIBLE_POSITION_MANAGER,amount:String(i===0?amount0:amount1),before:branch.beforeMint[`${token.toLowerCase()}:${NONFUNGIBLE_POSITION_MANAGER.toLowerCase()}`],after:branch.afterMint[`${token.toLowerCase()}:${NONFUNGIBLE_POSITION_MANAGER.toLowerCase()}`]}))];
          for(const spend of branch.spends){assert(BigInt(spend.amount)>0n);spend.behavior=BigInt(spend.after)===BigInt(spend.before)-BigInt(spend.amount)?'decrements':BigInt(spend.before)===maxUint256&&BigInt(spend.after)===maxUint256?'maximum_unchanged':'unexpected';assert.notEqual(spend.behavior,'unexpected');}
          const operationEnd=ctx.transactions.length;
          for(const {token,spender} of pairs)if(BigInt((await allowances())[`${token.toLowerCase()}:${spender.toLowerCase()}`])>0n)
            await ctx.send('cleanup_revoke',token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[spender,0n]}));
          branch.endingAllowances=await allowances();assert(Object.values(branch.endingAllowances).every(x=>x==='0'));
          const final=await ctx.balances();assert.equal(final.quote,after.quote);assert.equal(final.rwa,after.rwa);
          const gasValue=txs=>String(txs.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei)*BigInt(r.gasPriceQuote.quote)/10n**18n,0n));
          branch.costs={normalization:gasValue(ctx.transactions.slice(0,measuredStart)),setup:gasValue(ctx.transactions.slice(measuredStart,operationStart)),operation:gasValue(ctx.transactions.slice(operationStart,operationEnd)),cleanup:gasValue(ctx.transactions.slice(operationEnd)),total:gasValue(ctx.transactions.slice(measuredStart))};
          branch.operationApprovalCount=ctx.transactions.slice(operationStart,operationEnd).filter(t=>t.action.startsWith('approve')).length;
          const actualGas=ctx.transactions.slice(measuredStart).reduce((n,t)=>n+BigInt(t.localGasUsed)*BigInt(t.localEffectiveGasPriceWei),0n);
          assert.equal(BigInt(b.native)-BigInt(final.native),actualGas);
          const principal=principalAmounts({liquidity,...r.range,sqrtPriceX96:fresh[0]});
          branch.costed={id:option.mode,sourceBlock:r.source.block,sourceHash:r.source.hash,referencePriceX18:r.reference.referencePriceX18,
            amount0:String(BigInt(after.quote)-reserve+principal.amount0),amount1:String(BigInt(after.rwa)+principal.amount1),
            gasQuote:branch.costs.total,complete:true};
          branch.complete=true;branch.tokenId=String(id);branch.liquidity=String(liquidity);branch.wallet=after;
          branch.checks={reservedUsdgPreserved:true,swapReceiptDeltas:true,mintAmountsAndOwnership:true,nativeGasReconciled:true,revertedMintCallUnchanged:true,endingAllowancesZero:true};
        }catch(e){branch.error=sanitizeRiskError(e);}
        branch.upstream=fork.budget;save();console.log(JSON.stringify({nonce:r.nonce,mode:branch.mode,complete:branch.complete,error:branch.error,gasQuote:branch.costed?.gasQuote}));
      }
      const base=row.branches.find(b=>b.mode==='exact');
      for(const branch of row.branches.filter(b=>b.mode!=='exact'))if(base?.complete&&branch.complete)branch.comparison=compareCostedRoutes(base.costed,branch.costed);
      assert.equal((await upstream.getBlock({blockNumber:source.number})).hash,source.hash);row.upstream=fork.budget;
    }catch(e){row.error=sanitizeRiskError(e);}
    finally{await fork?.close();save();}
  }
}finally{save();await health.close();}
if(!result.cases.length||result.cases.some(c=>c.error||c.branches.length!==3||c.branches.some(b=>!b.complete)))process.exitCode=1;
