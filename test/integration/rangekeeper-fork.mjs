import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createPublicClient,http,zeroAddress} from 'viem';
import {robinhoodChain} from '../../src/constants.js';
import {initialRangeKeeperState,parseRangeKeeperConfig} from '../../src/strategy/rangekeeper/config.js';
import {RangeKeeperChain} from '../../src/strategy/rangekeeper/chain.js';
import {encodeRangeKeeperTx,authorizeRangeKeeperTx} from '../../src/strategy/rangekeeper/calldata.js';
import {planRangeKeeper,rawValue} from '../../src/strategy/rangekeeper/planner.js';
import {rangeKeeperReceiptFacts,proveRangeKeeperCollection} from '../../src/strategy/rangekeeper/receipt.js';
import {mintedRangeKeeperTokenId,reconcileRangeKeeperAction} from '../../src/strategy/rangekeeper/live-reconcile.js';
import {simulateRangeKeeperCandidate} from '../../src/strategy/rangekeeper/fork-simulator.js';
import {replayPaperMint} from '../../src/research/management-audit.js';
import {principalAmounts} from '../../src/backtest/principal.js';
import {applyRangeKeeperStageReceipt} from '../../src/strategy/rangekeeper/stages.js';
import {readRangeKeeperReferences} from '../../src/strategy/rangekeeper/reference.js';
import {nextRangeKeeperStage} from '../../src/strategy/rangekeeper/live-stage.js';

// Run only on a fork. No mainnet transaction or signer API appears in this file.
const [envPath,configPath='config/rangekeeper-v1-aapl-disabled.json',blockArg,mode]=process.argv.slice(2);
assert(envPath&&blockArg,'Usage: node --import tsx test/integration/rangekeeper-fork.mjs RUNTIME_ENV CONFIG BLOCK');
const config=parseRangeKeeperConfig(JSON.parse(readFileSync(configPath,'utf8')));
assert(!config.broadcastEnabled&&config.pool.reference1==='AAPL/USD');
const operator='0xdCC9348Ade9cA0A13249a44a63Db5411A8e72D52';
const archive=parseEnv(readFileSync(envPath,'utf8')).RH_ARCHIVE_RPC_URL;
assert(archive);
const port=18547,url=`http://127.0.0.1:${port}`;
const anvil=spawn('/root/.foundry/bin/anvil',['--fork-url',archive,'--fork-block-number',blockArg,
 '--chain-id','4663','--port',String(port),'--silent'],{stdio:'ignore'});
let killed=false;
const stop=()=>{if(!killed){killed=true;anvil.kill('SIGTERM');}};
process.on('exit',stop);
try{
 const client=createPublicClient({chain:robinhoodChain,transport:http(url,{retryCount:0,timeout:15_000})});
 let ready=false;
 for(let i=0;i<80;i++){
  try{if(await client.getChainId()===4663){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert(ready,'Anvil fork did not start');
 await client.request({method:'anvil_impersonateAccount',params:[operator]});
 await client.request({method:'anvil_setBalance',params:[operator,'0x8ac7230489e80000']});
 const chain=new RangeKeeperChain(client,config.pool);
 const first=await client.getBlock();
 const source={block:first.number,hash:first.hash,timestamp:Number(first.timestamp)};
 await chain.verify(source);
 const prior=await chain.snapshot(source,operator,null);
 assert(prior.wallet0>=200_000_000n&&prior.wallet1===0n,'Fork wallet does not match proposed funding custody');
 const transactions=[];
 const refs=await readRangeKeeperReferences(client,source,config);
 assert(refs.eligible&&refs.price0&&refs.price1&&refs.nativePrice,'Fork independent references unavailable');
 const strategy0=prior.wallet0,price0=refs.price0,price1=refs.price1,nativePrice=refs.nativePrice;
 const initialObservation={block:source.block,hash:source.hash,timestamp:source.timestamp,tick:prior.tick,
  sqrtPriceX96:prior.sqrtPriceX96,continuity:'canonical',wallet0:strategy0,wallet1:0n,released0:0n,released1:0n,
  nativeWei:3n*10n**15n,requiredExitReserveWei:config.limits.exitReserveWei,price0,price1,nativePrice,
  position:null,pending:false,entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:1000,
  actionCost:28n*10n**17n,actionGasWei:10n**15n,reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,
  campaignStartValue:rawValue(strategy0,price0,config.pool.decimals0),
  highWaterValue:rawValue(strategy0,price0,config.pool.decimals0),recenters:0};
 const proposal=await planRangeKeeper({state:initialRangeKeeperState(config,'fork-rehearsal'),observation:initialObservation,
  limits:config.limits,spacing:config.pool.tickSpacing,decimals0:config.pool.decimals0,decimals1:config.pool.decimals1,
  quoteToken:config.pool.quoteToken,maxPoolDeviationPpm:config.referencePolicy.maxPoolDeviationPpm,
  quote:(token,amount)=>chain.quote(source,token,amount,price0,price1),simulate:async()=>true});
 assert.equal(proposal.action,'confirm',proposal.reason);assert(proposal.candidate?.swap?.token===0,'Expected a minimum USDG input swap');
 await client.request({method:'evm_increaseTime',params:[30]});
 await client.request({method:'evm_mine',params:[]});
 const secondBlock=await client.getBlock();
 const secondSource={block:secondBlock.number,hash:secondBlock.hash,timestamp:Number(secondBlock.timestamp)};
 const secondSnapshot=await chain.snapshot(secondSource,operator,null);
 const confirmed=await planRangeKeeper({state:proposal.state,
  observation:{...initialObservation,block:secondSource.block,hash:secondSource.hash,timestamp:secondSource.timestamp,
   tick:secondSnapshot.tick,sqrtPriceX96:secondSnapshot.sqrtPriceX96},
  limits:config.limits,spacing:config.pool.tickSpacing,decimals0:config.pool.decimals0,decimals1:config.pool.decimals1,
  quoteToken:config.pool.quoteToken,maxPoolDeviationPpm:config.referencePolicy.maxPoolDeviationPpm,
  quote:(token,amount)=>chain.quote(secondSource,token,amount,price0,price1),simulate:async()=>true});
 assert.equal(confirmed.action,'execute',confirmed.reason);
 const frozen=confirmed.candidate;
 if(mode==='verify-live-simulator'){
  const proof=await simulateRangeKeeperCandidate({rpcUrl:archive,anvilBinary:'/root/.foundry/bin/anvil',
   source,pool:config.pool,limits:config.limits,operator,candidate:proposal.candidate,activeTokenId:null,
   prices:{price0,price1}});
  assert(proof.createdTokenId>0n&&proof.gasByStage.some(stage=>stage.kind==='mint'));
 }
 const send=async(plan,before,futureApprovalCap=0n)=>{
  authorizeRangeKeeperTx(config.pool,wallet(before),plan,config.limits.maxSlippageBps,
   config.limits.fullWidthSpacings,futureApprovalCap);
  const call=encodeRangeKeeperTx(config.pool,operator,plan);
  await client.call({account:operator,to:call.to,data:call.data});
  const hash=await client.request({method:'eth_sendTransaction',params:[{from:operator,to:call.to,data:call.data,gas:'0x7a1200'}]});
  const receipt=await client.waitForTransactionReceipt({hash});
  assert.equal(receipt.status,'success',`${plan.kind} reverted`);
  const block=await client.getBlock({blockNumber:receipt.blockNumber});
  const id=plan.kind==='mint'?mintedRangeKeeperTokenId(config.pool,operator,receipt):before.position?.tokenId??null;
  const after=await chain.snapshot({block:block.number,hash:block.hash,timestamp:Number(block.timestamp)},operator,id);
  const reconciled=reconcileRangeKeeperAction(config.pool,{hash,plan,before,
   intent:{operator,gas:'8000000',maxFeePerGas:'100000000000'}},receipt,after);
  assert.equal(reconciled.status,'success');
  transactions.push({kind:plan.kind,gasUsed:String(receipt.gasUsed),effectiveGasPrice:String(receipt.effectiveGasPrice),
   gasWei:String(receipt.gasUsed*receipt.effectiveGasPrice),hash});
  return receipt;
 };
 const wallet=(s)=>({operator,wallet0:s.wallet0,wallet1:s.wallet1,tick:s.tick,sqrtPriceX96:s.sqrtPriceX96,
  timestamp:s.source.timestamp,position:s.position});
 const snap=async(id=null)=>{const b=await client.getBlock();return chain.snapshot({block:b.number,hash:b.hash,timestamp:Number(b.timestamp)},operator,id);};
 let s=secondSnapshot;
 await send({kind:'approve',token:0,spender:'positionManager',amount:s.wallet0},s);s=await snap();
 const futureStockCap=config.limits.maxDeploymentValue*10n**18n/price1;
 await send({kind:'approve',token:1,spender:'positionManager',amount:futureStockCap},s,futureStockCap);s=await snap();
 await send({kind:'approve',token:0,spender:'router',amount:s.wallet0},s);s=await snap();
 const swap={kind:'swap',token:0,amountIn:frozen.swap.amountIn,minOut:frozen.swap.minOut,deadline:BigInt(s.source.timestamp+300)};
 const swapReceipt=await send(swap,s);
 const swapFacts=rangeKeeperReceiptFacts(config.pool,operator,swapReceipt);
 assert.equal(swapFacts.wallet0,-swap.amountIn);assert(swapFacts.wallet1>=swap.minOut);
 s=await snap();assert(s.wallet1>0n);
 const stageState={phase:'entry',candidate:frozen,swapDone:true,activeTokenId:null,
  reserve0:0n,reserve1:0n,reserveNativeWei:0n};
 const mintPlan=await nextRangeKeeperStage(stageState,s,config,chain,{price0,price1});
 assert(mintPlan?.kind==='mint','Post-swap fork mint missed its cap or floor');
 const candidate=mintPlan.candidate,desired0=candidate.amount0Desired,desired1=candidate.amount1Desired;
 const m=replayPaperMint(s.sqrtPriceX96,frozen.range,desired0,desired1,0n);
 assert(m.liquidity>=candidate.liquidity);
 let forcedRevertGasWei=null;
 if(mode==='force-mint-revert'){
  const invalid={...candidate,amount0Min:desired0+1n};
  const call=encodeRangeKeeperTx(config.pool,operator,{kind:'mint',candidate:invalid,deadline:BigInt(s.source.timestamp+300)});
  const before=s;
  const badHash=await client.request({method:'eth_sendTransaction',params:[{from:operator,to:call.to,data:call.data,gas:'0x7a1200'}]});
  const reverted=await client.waitForTransactionReceipt({hash:badHash});assert.equal(reverted.status,'reverted');
  const facts=rangeKeeperReceiptFacts(config.pool,operator,reverted);
  assert.equal(facts.wallet0,0n);assert.equal(facts.wallet1,0n);
  const ledger={stage:'mint',completedHashes:[],gasSpentWei:0n,costSpentValue:0n,wallet0:s.wallet0,wallet1:s.wallet1,activeTokenId:null,haltedReason:null};
  const e={stage:'mint',hash:badHash,canonical:true,status:'reverted',gasWei:facts.gasWei,costValue:0n,nextStage:'mint'};
  assert.equal(applyRangeKeeperStageReceipt(ledger,e),true);
  assert.equal(applyRangeKeeperStageReceipt(ledger,e),false);assert.equal(ledger.gasSpentWei,facts.gasWei);
  forcedRevertGasWei=String(facts.gasWei);
  s=await snap();assert.equal(s.wallet0,before.wallet0);assert.equal(s.wallet1,before.wallet1);
  assert.equal(s.nftCount,before.nftCount);assert.equal(s.nonce,before.nonce+1);
 }
 const mintReceipt=await send({kind:'mint',candidate,deadline:BigInt(s.source.timestamp+300)},s);
 const mintFacts=rangeKeeperReceiptFacts(config.pool,operator,mintReceipt);
 const created=mintFacts.nfts.filter(x=>x.from.toLowerCase()===zeroAddress&&x.to.toLowerCase()===operator.toLowerCase());
 assert.equal(created.length,1);const tokenId=created[0].tokenId;
 s=await snap(tokenId);assert(s.position?.liquidity>0n);
 const position=s.position,principal=principalAmounts({...position,sqrtPriceX96:s.sqrtPriceX96});
 const withdrawal={kind:'withdraw',tokenId,liquidity:position.liquidity,min0:principal.amount0*9950n/10000n,
  min1:principal.amount1*9950n/10000n,deadline:BigInt(s.source.timestamp+300)};
 const exitReceipt=await send(withdrawal,s);
 const exitFacts=rangeKeeperReceiptFacts(config.pool,operator,exitReceipt);
 const collection=proveRangeKeeperCollection({pool:config.pool,operator,tokenId,tickLower:position.tickLower,tickUpper:position.tickUpper,facts:exitFacts});
 s=await snap(tokenId);assert(s.position?.liquidity===0n&&s.position.tokensOwed0===0n&&s.position.tokensOwed1===0n);
 await send({kind:'approve',token:1,spender:'router',amount:s.wallet1},s);s=await snap(tokenId);
 const saleQuote=await chain.quote(s.source,1,s.wallet1,price0,price1);
 const sale={kind:'swap',token:1,amountIn:s.wallet1,minOut:saleQuote.amountOut*9950n/10000n,deadline:BigInt(s.source.timestamp+300)};
 const saleReceipt=await send(sale,s);s=await snap(tokenId);assert.equal(s.wallet1,0n);
 // Revoke all four grants made during this fork rehearsal.
 for(const [token,spender] of [[0,'router'],[0,'positionManager'],[1,'positionManager'],[1,'router']]){
  await send({kind:'approve',token,spender,amount:0n},s);s=await snap(tokenId);
 }
 assert.equal(s.allowances.filter(a=>a.amount>0n).length,0);
 assert.equal(s.nftCount,prior.nftCount+1n);
 console.log(JSON.stringify({forkBlock:blockArg,sourceHash:first.hash,operator,pool:config.pool.pool,
  initialNftCount:String(prior.nftCount),createdTokenId:String(tokenId),finalNftCount:String(s.nftCount),
  finalLiquidity:String(s.position.liquidity),finalOwed0:String(s.position.tokensOwed0),finalOwed1:String(s.position.tokensOwed1),
  strategyAllocation0Raw:String(strategy0),minimumSwapInputRaw:String(swap.amountIn),swapOutputRaw:String(swapFacts.wallet1),
  swapInputRaw:String(swap.amountIn),fee0Raw:String(collection.fee0),fee1Raw:String(collection.fee1),
  finalAaplRaw:String(s.wallet1),allowanceCountNonzero:0,
  totalForkGasWei:String(transactions.reduce((n,t)=>n+BigInt(t.gasWei),0n)),forcedRevertGasWei,transactions}));
}catch(error){
 const detail=error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,240):'unknown';
 console.error(`RangeKeeper fork rehearsal failed: ${error instanceof Error?error.name:'unknown'}: ${detail}`);
 process.exitCode=1;
}finally{stop();}
