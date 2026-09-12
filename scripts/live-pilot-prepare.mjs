// Read-only mainnet/DB preparation. Transactions run only on the owned fork.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {keccak256,parseAbi} from 'viem';
import {livePilotConfig} from '../src/live-pilot/config.ts';
import {pilotReceiptFacts} from '../src/live-pilot/receipt.ts';
import {createRobinhoodClient} from '../src/client.ts';
import {USDG,NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.ts';
import {loadIndexerConfig} from '../src/indexer/config.ts';
import {sourceSql} from '../src/paper/store.ts';
import {readPaperReferenceGate} from '../src/paper/reference.ts';
import {evaluateCanaryEntryReadiness} from '../src/canary-plan/entry-readiness.ts';
import {PostgresRpcHealthGate} from '../src/rpc-health/store.ts';
import {PAPER_NVDA,PAPER_POOL,paperEntryRange} from '../src/paper/engine.ts';
import {PAPER_ACCOUNT,PAPER_ROUTER,PAPER_QUOTER,paperTokenAbi} from '../src/paper/execution-abi.ts';
import {openPaperFork} from '../src/paper/fork.ts';
import {createPaperExecutionContext,simulatePaperRoundTrip} from '../src/paper/execution.ts';
import {solveRecenterSwap,assertRecenterPrice} from '../src/paper/execution-recenter.ts';
import {loadRiskConfig} from '../src/risk/config.ts';
import {fetchFeedDirectory,selectOracleFeed} from '../src/risk/source.ts';
import {ViemRiskChainReader} from '../src/risk/reader.ts';
import {evaluateOracleRisk} from '../src/risk/evaluate.ts';
import {evaluatePaperUsdgOracle} from '../src/paper/usdg-oracle.ts';

const [envPath,outputDir,policyPath='config/live-pilot-nvda-250.json']=process.argv.slice(2);
assert(envPath&&outputDir,'Usage: node --import tsx scripts/live-pilot-prepare.mjs ENV OUTPUT_DIR [CONFIG]');
Object.assign(process.env,parseEnv(readFileSync(envPath,'utf8')));
process.env.ANVIL_BIN??='/root/.foundry/bin/anvil';
const configText=readFileSync(policyPath,'utf8'),pilot=livePilotConfig(JSON.parse(configText)),policy=pilot.strategy;
const indexer=loadIndexerConfig(),pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const gate=new PostgresRpcHealthGate({connectionString:process.env.DATABASE_URL,enabled:true,cacheMs:2000,maxSampleAgeSeconds:30});
const beforeRead=()=>gate.assertBulkAllowed().then(()=>{});
const client=createRobinhoodClient(indexer.rpcUrl,indexer.rpcTimeoutMs,{beforeRequest:beforeRead,retryCount:0});
const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
mkdirSync(outputDir,{recursive:true});
writeFileSync(`${outputDir}/config.json`,configText,{flag:'wx'});
const save=(name,value)=>{const raw=stringify(value);writeFileSync(`${outputDir}/${name}.json`,raw,{flag:'wx'});writeFileSync(`${outputDir}/${name}.sha256`,createHash('sha256').update(raw).digest('hex')+'\n',{flag:'wx'});};
let fork,db;
try{
 db=await pool.connect();
 await db.query('BEGIN READ ONLY');
 const candidates=(await db.query(`${sourceSql} ORDER BY c.block_number DESC,c.id DESC LIMIT 10`,[indexer.streamKey,PAPER_NVDA,PAPER_POOL])).rows;
 const source=candidates.find(s=>s.canonical&&s.covered&&s.coverage_identity_valid);
 assert(source,'No checkpoint');const cp=source.checkpoint,now=new Date().toISOString();
 const samples=(await db.query("SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at >= NOW()-INTERVAL '6 minutes' ORDER BY observed_at DESC,id DESC LIMIT 128")).rows;
 const chain=evaluateCanaryEntryReadiness({now,sourceBlock:BigInt(cp.block),samples});
 const reference=await readPaperReferenceGate(db,cp,policy.referencePolicy,now);
 await db.query('COMMIT');db.release();db=null;
 assert(source.canonical&&source.covered&&source.coverage_identity_valid,'Checkpoint coverage/canonicality unavailable');
 assert.equal(await client.getChainId(),4663);
 const block=await client.getBlock({blockNumber:BigInt(cp.block)});assert.equal(block.hash.toLowerCase(),cp.hash.toLowerCase());
 const deployments={};
 for(const [name,address] of Object.entries({factory:UNISWAP_V3_FACTORY,manager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,pool:PAPER_POOL,usdg:USDG,nvda:PAPER_NVDA})){
  const code=await client.getBytecode({address,blockNumber:block.number});assert(code&&code!=='0x',`${name} has no code`);deployments[name]={address,codeHash:keccak256(code)};
 }
 let wallet=null;
 if(pilot.operator){
  const address=pilot.operator,at={blockNumber:block.number};
  const [native,usdg,nvda,nfts,confirmedNonce,pendingNonce,code]=await Promise.all([
   client.getBalance({address,...at}),...([USDG,PAPER_NVDA].map(token=>client.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[address],...at}))),
   client.readContract({address:NONFUNGIBLE_POSITION_MANAGER,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[address],...at}),
   client.getTransactionCount({address,blockTag:'latest'}),client.getTransactionCount({address,blockTag:'pending'}),client.getBytecode({address,...at}),
  ]);
  const allowances=[];for(const token of [USDG,PAPER_NVDA])for(const spender of [PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER])allowances.push({token,spender,amount:String(await client.readContract({address:token,abi:paperTokenAbi,functionName:'allowance',args:[address,spender],...at}))});
  wallet={address,sourceBlock:cp.block,native,usdg,nvda,nfts,confirmedNonce,pendingNonce,isEoa:!code||code==='0x',allowances};
 }
 const ageSeconds=(Date.parse(now)-Date.parse(cp.blockTimestamp))/1000;
 const readiness={computedAt:now,scope:'deployment_preparation_only',broadcastEnabled:false,executionEligible:false,
  configSha256:createHash('sha256').update(configText).digest('hex'),checkpoint:cp,newestCheckpointBlock:candidates[0]?.checkpoint.block,chain,reference,deployments,wallet,
  freshSource:ageSeconds>=0&&ageSeconds<=policy.maxSourceAgeSeconds,
  remainingLaunchWork:['persistent_live_position_reconciliation','signer_and_broadcast_adapter','restart_and_partial_recenter_recovery','wallet_specific_rehearsal','live_service_and_dashboard_integration'],
  setupRequired:[...(!pilot.operator?['operator_unset']:[]),...(!pilot.signer?['signer_unset']:[])]};
 save('readiness',readiness);
 console.log(stringify({phase:'readiness',source:cp.block,chainEligible:chain.chainEligible,referenceEligible:reference.eligible,freshSource:readiness.freshSource,setupRequired:readiness.setupRequired}));
 // Mechanical rehearsal can be informative even when entry is temporarily gated.
 fork=await openPaperFork({source:{number:block.number,hash:block.hash,timestamp:block.timestamp},rpcUrl:indexer.rpcUrl,beforeRead,maxRequests:650,timeoutMs:240000});
 const context=await createPaperExecutionContext(fork,policy),range=paperEntryRange(cp,policy);
 assert.equal(String(context.sourceSlot[0]),cp.sqrtPriceX96);assert.equal(context.sourceSlot[1],cp.tick);
 const net=await solveRecenterSwap(context.sourceSlot[0],range,BigInt(policy.budgetQuote),0n,async(amount,token)=>{
  const q=await context.quoteSwap(token===0?USDG:PAPER_NVDA,token===0?PAPER_NVDA:USDG,amount);
  return {amountOut:BigInt(q.amountOut),price:BigInt(q.sqrtPriceAfter)};
 });
 assert.equal(net.token,0);assertRecenterPrice(net.price,context.sourceSlot[0],policy.maxSlippageBps);
 const intent={...range,swapAmountQuote:String(net.amount),minRwaOut:String(net.amountOut*9950n/10000n)};
 const result=await simulatePaperRoundTrip(fork,policy,tx=>console.log(stringify({phase:'fork_transaction',action:tx.action,estimatedFeeWei:tx.estimate.totalFeeWei})),intent);
 const receipts=[],rawReceipts=[];
 for(const tx of result.transactions){
  const receipt=await context.local.getTransactionReceipt({hash:tx.localHash});
  rawReceipts.push(receipt);
  receipts.push(pilotReceiptFacts(receipt,PAPER_ACCOUNT));
 }
 assert.equal(receipts.reduce((n,r)=>n+BigInt(r.walletDeltas.usdg),0n),BigInt(result.cashDeltaQuote));
 assert.equal(receipts.reduce((n,r)=>n+BigInt(r.walletDeltas.nvda),0n),0n);
 assert.equal(receipts.reduce((n,r)=>n+BigInt(r.gasWei),0n),BigInt(result.localGasWei));
 save('roundtrip',{intent,result,receipts,rawReceipts,receiptChecks:{walletTokenDeltas:true,localGas:true,scope:'owned_fork_only'}});
 await fork.close();fork=null;
 const risk=loadRiskConfig(),directory=await fetchFeedDirectory(risk.feedDirectoryUrl,risk.httpTimeoutMs),reader=new ViemRiskChainReader(client);
 const valuation={};
 for(const symbol of ['ETH','USDG']){
  const feed=selectOracleFeed(directory.payload,symbol);assert(feed,`${symbol} feed missing`);
  const state=await reader.readOracle(feed.address,block.number);
  const input={feed,state,blockTimestamp:block.timestamp,maxPriceAgeSeconds:policy.referencePolicy.maxGasPriceAgeSeconds};
  const evaluated=symbol==='USDG'?evaluatePaperUsdgOracle(input,policy.referencePolicy.usdgHeartbeatGraceSeconds):evaluateOracleRisk(input);
  assert(evaluated.executionEligible&&evaluated.state,`${symbol} valuation unavailable`);valuation[symbol]=evaluated;
 }
 const eth=valuation.ETH.state,usd=valuation.USDG.state;
 const gasQuote=wei=>String((BigInt(wei)*BigInt(eth.answer)*10n**BigInt(usd.decimals)*1000000n)/(10n**18n*BigInt(usd.answer)*10n**BigInt(eth.decimals)));
 save('summary',{computedAt:new Date().toISOString(),source:result.source,initialCapitalQuote:policy.budgetQuote,range,
  before:result.balances.before.quote,after:result.balances.afterExit.quote,cashDeltaQuote:result.cashDeltaQuote,
  entryGasWei:result.entryGasWei,exitGasWei:result.exitGasWei,totalGasWei:result.totalGasWei,
  estimatedEntryGasQuote:gasQuote(result.entryGasWei),estimatedExitGasQuote:gasQuote(result.exitGasWei),estimatedTotalGasQuote:gasQuote(result.totalGasWei),
  estimatedRoundtripNetQuote:String(BigInt(result.cashDeltaQuote)-BigInt(gasQuote(result.totalGasWei))),
  transactions:result.transactions.length,valuation,executionEligible:false,broadcastEnabled:false,
  limitations:result.limitations,liveWalletVerified:false});
 console.log(stringify({phase:'complete',outputDir,cashDeltaQuote:result.cashDeltaQuote,estimatedTotalGasQuote:gasQuote(result.totalGasWei)}));
}finally{
 if(db){await db.query('ROLLBACK').catch(()=>{});db.release();}
 await fork?.close();await pool.end();await gate.close();
}
