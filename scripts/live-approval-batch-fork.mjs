// Replay actual consecutive approval requests on owned forks; no live writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {encodeFunctionData} from 'viem';
import {openPaperFork} from '../src/paper/fork.ts';
import {createPaperExecutionContext} from '../src/paper/execution.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {pilotGasValuer} from '../src/live-pilot/valuation.ts';
import {USDG} from '../src/constants.ts';
import {PAPER_ROUTER,paperTokenAbi} from '../src/paper/execution-abi.ts';
import {boundedSwapApproval} from '../src/research/live-execution-cost.ts';
import {sanitizeRiskError} from '../src/risk/evaluate.ts';

const [envPath,ledgerPath,out]=process.argv.slice(2);assert(envPath&&ledgerPath&&out,'Usage: ENV LEDGER NEW_OUTPUT_DIRECTORY');
assert(!existsSync(out));mkdirSync(out,{recursive:true});process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const env=parseEnv(readFileSync(envPath,'utf8'));delete env.WALLET_PRIVATE_KEY;
const d=JSON.parse(readFileSync(ledgerPath)),{state,config}=d.campaigns[0],operator=state.operator;
const health=new PostgresRpcHealthGate({connectionString:env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>health.assertBulkAllowed().then(()=>{}),rpc=env.RH_INDEXER_RPC_URL??env.RH_RPC_URL;
const client=createRobinhoodClient(rpc,15000,{beforeRequest:beforeRead,retryCount:0}),valueGas=pilotGasValuer(client,config);
const groups=[];let group=[];
const flush=()=>{if(group.length>1)groups.push(group);group=[];};
for(const a of d.actions.filter(a=>a.receipt).sort((a,b)=>Number(a.nonce)-Number(b.nonce))){
  if(a.status==='confirmed'&&a.plan.kind==='approve'&&a.plan.spender.toLowerCase()===PAPER_ROUTER.toLowerCase()&&BigInt(a.plan.amount)>0n){
    if(group.length&&group[0].plan.token.toLowerCase()!==a.plan.token.toLowerCase())flush();group.push(a);
  }else flush();
}flush();
const selected=groups.sort((a,b)=>b.length-a.length||Number(a[0].nonce)-Number(b[0].nonce)).slice(0,4);
const result={at:new Date().toISOString(),executionEligible:false,mainnetTransactions:0,cases:[],limitations:[
  'Only the recorded approval requests are replayed, with constant token inventory; no market movement is simulated.',
  'Both alternatives include a measured final revoke, so larger unused allowance is not free.',
  'These local/Nitro paired estimates are not a replacement for whole-campaign gas accounting.']};
const save=()=>writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2)+'\n');
try{for(const aa of selected){
  const first=aa[0],snap=first.before_state,token=first.plan.token;
  const source=await client.getBlock({blockNumber:BigInt(snap.block)});assert.equal(source.hash,snap.hash);
  const gasPrice=await valueGas({block:snap.block,hash:snap.hash,timestamp:snap.timestamp},String(10n**18n));
  const row={nonces:aa.map(a=>a.nonce),source:{block:snap.block,hash:snap.hash},token,branches:[]};result.cases.push(row);
  for(const mode of ['exact','managed_balance']){let fork;
    const branch={mode,complete:false,transactions:[]};row.branches.push(branch);
    try{
      fork=await openPaperFork({source:{number:source.number,hash:source.hash,timestamp:source.timestamp},rpcUrl:rpc,beforeRead,maxRequests:1000,timeoutMs:240000});
      await fork.rpc('anvil_impersonateAccount',[operator]);
      const ctx=await createPaperExecutionContext(fork,config.strategy,tx=>branch.transactions.push(tx),operator),initial=await ctx.balances();
      assert.equal(initial.quote,snap.usdg);assert.equal(initial.rwa,snap.nvda);
      const available=token.toLowerCase()===USDG.toLowerCase()?BigInt(initial.quote)-BigInt(state.reserveUsdg):BigInt(initial.rwa);
      const allowance=()=>ctx.local.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[operator,PAPER_ROUTER]});
      for(const a of aa){const required=BigInt(a.plan.amount);assert(required<=available);
        const amount=mode==='exact'?required:boundedSwapApproval(required,available,await allowance());
        if(amount!==null)await ctx.send('approve',token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[PAPER_ROUTER,amount]}));
        assert(await allowance()>=required,'Next recorded request could not execute');
      }
      branch.beforeRevoke=String(await allowance());
      await ctx.send('revoke',token,encodeFunctionData({abi:paperTokenAbi,functionName:'approve',args:[PAPER_ROUTER,0n]}));assert.equal(await allowance(),0n);
      const final=await ctx.balances();assert.equal(final.quote,initial.quote);assert.equal(final.rwa,initial.rwa);
      assert.equal(BigInt(initial.native)-BigInt(final.native),ctx.transactions.reduce((n,t)=>n+BigInt(t.localGasUsed)*BigInt(t.localEffectiveGasPriceWei),0n));
      branch.gasQuote=String(ctx.transactions.reduce((n,t)=>n+BigInt(t.estimate.totalFeeWei)*BigInt(gasPrice.quote)/10n**18n,0n));
      branch.complete=true;branch.checks={requestsFunded:true,reserveUntouched:true,endingAllowanceZero:true,nativeGasReconciled:true};
    }catch(e){branch.error=sanitizeRiskError(e);}
    finally{await fork?.close();save();console.log(JSON.stringify({nonces:row.nonces,mode,complete:branch.complete,gasQuote:branch.gasQuote,error:branch.error}));}
  }
  if(row.branches.every(b=>b.complete))row.savingQuote=String(BigInt(row.branches[0].gasQuote)-BigInt(row.branches[1].gasQuote));
  assert.equal((await client.getBlock({blockNumber:source.number})).hash,source.hash);save();
}}finally{save();await health.close();}
if(!result.cases.length||result.cases.some(c=>c.branches.length!==2||c.branches.some(b=>!b.complete)))process.exitCode=1;
