import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,type Address,type Hash} from 'viem';
import {poolAbi} from '../abi.js';
import {createRobinhoodClient,type RobinhoodClient} from '../client.js';
import {ROBINHOOD_CHAIN_ID} from '../constants.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {readRangeKeeperReferences} from '../strategy/rangekeeper/reference.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import {buildIndicativePaperOpenPreview} from './paper-preview.js';
import {verifyPaperGasEvidence} from './paper-gas-evidence.js';
import {verifyPaperCloseConvertGasEvidence} from './paper-gas-evidence.js';
import {paperQuoterAbi,paperTokenAbi} from '../paper/execution-abi.js';
import {PAPER_ACCOUNT} from '../paper/execution-abi.js';
import {canaryExitAbi,readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {openPaperFork} from '../paper/fork.js';
import {restorePaperPosition,type PaperExitInventory} from '../paper/execution-exit.js';
import {simulatePaperTransaction} from '../paper/execution-gas.js';
import {paperCloseConvertGasScopeHashV2,paperCloseConvertGasSizeBandV2,
 paperCloseConvertGasScopeV2Schema,type PaperCloseConvertGasScopeV2} from './paper-close-convert-model.js';
import type {PaperCloseConvertRoute,PaperCloseConvertQuote} from './paper-close-convert-model.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {MarketProfile} from './market-profile.js';
import {contentHash} from './contracts.js';
import {loadRuntimeIdentity,type RuntimeIdentity} from '../runtime/identity.js';

/** Replays the report's candidate from its canonical block and independent
 * references before an isolated database may ingest the fork gas sample. */
export async function verifyPaperGasSource(client:RobinhoodClient,raw:unknown){
 const report=verifyPaperGasEvidence(raw),profile=marketProfileSchema.parse(report.profile);
 const source=report.source as {block:string;hash:`0x${string}`;timestamp:number};
 const sampledAt=Date.parse(report.sampledAt as string),age=Date.now()-sampledAt;
 assert(Number.isFinite(sampledAt)&&age>=0&&age<=86_400_000,'Paper gas sample is stale or future');
 assert.equal(await client.getChainId(),ROBINHOOD_CHAIN_ID);
 const latest=await client.getBlock(),blockNumber=BigInt(source.block);
 assert(latest.number>=blockNumber+64n,'Paper gas source is not confirmed');
 const block=await client.getBlock({blockNumber});
 assert.equal(block.hash.toLowerCase(),source.hash.toLowerCase());
 assert.equal(Number(block.timestamp),source.timestamp);
 const chainSource={block:blockNumber,hash:block.hash,timestamp:source.timestamp};
 await new RangeKeeperChain(client,profile.pool).verify(chainSource);
 const [slot,liquidity,references]=await Promise.all([
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'slot0',blockNumber}),
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'liquidity',blockNumber}),
  readRangeKeeperReferences(client,chainSource,profile),
 ]);
 assert(references.eligible&&references.price0&&references.price1&&references.nativePrice,
  'Paper gas independent references unavailable');
 const proof=JSON.parse(JSON.stringify(references.proof,(_,value)=>
  typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 const recordedReference=report.reference as {price0:string;price1:string;nativePrice:string;proofHash:string};
 const frame={source,tick:slot[1],sqrtPriceX96:slot[0],poolLiquidity:liquidity,
  price0:references.price0,price1:references.price1,nativePrice:references.nativePrice,
  referenceEligible:references.eligible,referenceReasons:references.reasons,
  referenceProofHash:recordedReference.proofHash};
 const draft={id:report.campaignId as string,revision:report.revision as number,
  allocation:report.allocation as {token0Raw:string;token1Raw:string;nativeWei:string},
  profile,profileHash:report.profileHash as string,
  strategyId:'static_manual_v1' as const,parameters:report.parameters as Record<string,unknown>,
  configHash:report.configHash as string};
 const preview=buildIndicativePaperOpenPreview(draft,frame,sampledAt);
 assert.equal(preview.status,'indicative');
 assert.equal(preview.candidateHash,report.candidateHash,'Paper gas candidate source replay changed');
 const reference=recordedReference;
 assert.equal(reference.price0,String(references.price0));
 assert.equal(reference.price1,String(references.price1));
 assert.equal(reference.nativePrice,String(references.nativePrice));
 const recordedProof=report.referenceProof as Record<string,unknown>;
 for(const key of ['token0','token1','native'] as const)
  assert.equal(referenceProofHash(recordedProof[key]),referenceProofHash(proof[key]),
   `Paper gas ${key} oracle proof changed`);
 const finalBlock=await client.getBlock({blockNumber});
 assert.equal(finalBlock.hash.toLowerCase(),source.hash.toLowerCase(),'Paper gas source reorged');
 return {verificationClass:'canonical_candidate_replay_v1' as const,
  reportHash:report.reportHash as string,sourceHash:source.hash,profileHash:report.profileHash as string,
  verifiedAt:new Date().toISOString()};
}

export interface PaperCloseConvertGasPersistedEvidence {
 campaignId:string;revision:number;terminalMarkId:string;previousMarkId:string;
 runtimeIdentity:RuntimeIdentity;
 profile:MarketProfile;profileHash:string;openModel:PaperOpenModel;openModelHash:string;
 openSource:{block:string;hash:string;timestamp:number};
 closeSource:{block:string;hash:string;timestamp:number};
 frame:{tick:number;sqrtPriceX96:string;poolLiquidity:string;price0:string;price1:string;
  nativePrice:string;referenceProof:Record<string,unknown>;referenceProofHash:string};
 route:PaperCloseConvertRoute;quote:PaperCloseConvertQuote;scope:PaperCloseConvertGasScopeV2;
 scopeHash:string;sequenceHash:string;
 reportHash:string;postWithdrawReplayHash:string;sourceReplayHash:string;
 feeEvidence:{id:string;proofHash:string;carryHash:string};feeCarry:PaperFeeCarry;
}
/** Store callback must load the saved open model, terminal fee proof and carry
 * by identity and reject any mismatch. It must compare registered profile and
 * open-model bytes/hashes, campaign revision, exact terminal/previous mark IDs
 * and source anchors, plus the fee row's proof_hash/carry_hash and a replayed
 * cumulative carry through the terminal mark. It should persist the separate
 * owned-fork post-withdraw replay attestation with the gas report. A self-hashed
 * report alone is not accepted as evidence of those persisted accounting inputs. */
export type VerifyPaperCloseConvertGasPersistedEvidence=(input:PaperCloseConvertGasPersistedEvidence)=>Promise<void>;

export interface PaperCloseConvertGasReplayOptions {
 rpcUrl:string;beforeRead:()=>Promise<void>;maxRequests:number;timeoutMs:number;
}

/** Reconstructs the same local position, idle balances and saved lower fee
 * carry at the canonical close block, then executes withdraw+collect and calls
 * Quoter against the resulting pool. All writes stay on the owned Anvil fork. */
async function replayPaperCloseConvertPostWithdrawal(report:ReturnType<typeof verifyPaperCloseConvertGasEvidence>,
 profile:MarketProfile,options:PaperCloseConvertGasReplayOptions){
 assert(options.rpcUrl.length>0&&Number.isSafeInteger(options.maxRequests)&&
  options.maxRequests>0&&options.maxRequests<=2000&&Number.isSafeInteger(options.timeoutMs)&&
  options.timeoutMs>0&&options.timeoutMs<=300_000,
  'Post-withdraw owned-fork replay budget is invalid');
 const p=profile.pool,open=report.openModel as PaperOpenModel,
  route=report.route as PaperCloseConvertRoute,carry=report.feeCarry as PaperFeeCarry,
  source=report.source as {block:string;hash:`0x${string}`;timestamp:number},
  riskIndex=route.inputAsset==='token0'?0:1,
  riskToken=(riskIndex===0?p.token0:p.token1) as Address,
  market={symbol:'STATIC',rwa:riskToken,pool:p.pool as Address,fee:p.fee,
   tickSpacing:p.tickSpacing,rwaDecimals:riskIndex===0?p.decimals0:p.decimals1},
  policy={market,budgetQuote:'10000000000',halfWidthSpacings:1,
   maxLiquiditySharePpm:10_000,maxSlippageBps:route.slippageBps,transactionTtlSeconds:300} as const,
  principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   sqrtPriceX96:BigInt(report.frame.sqrtPriceX96)}),
  idle0=BigInt(open.candidate.idle0),idle1=BigInt(open.candidate.idle1),
  fee0=BigInt(carry.token0.lowerAmountRaw),fee1=BigInt(carry.token1.lowerAmountRaw),
  inventory:PaperExitInventory={liquidity:open.candidate.liquidity,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   idle0:String(idle0),idle1:String(idle1),fee0:String(fee0),fee1:String(fee1),
   nativeBalanceWei:'1000000000000000000',allowances:[
    {token:p.token0 as Address,spender:p.positionManager as Address,amount:String(idle0)},
    {token:p.token1 as Address,spender:p.positionManager as Address,amount:String(idle1)},
    {token:p.token0 as Address,spender:p.router as Address,amount:'0'},
    {token:p.token1 as Address,spender:p.router as Address,amount:'0'}]};
 const fork=await openPaperFork({source:{number:BigInt(source.block),hash:source.hash as Hash,
  timestamp:BigInt(source.timestamp)},rpcUrl:options.rpcUrl,beforeRead:options.beforeRead,
  maxRequests:options.maxRequests,timeoutMs:options.timeoutMs});
 try{
  const local=createRobinhoodClient(fork.localUrl,60_000,{retryCount:0});
  await new RangeKeeperChain(local,p).verify({block:BigInt(source.block),hash:source.hash,
   timestamp:source.timestamp});
  const restored=await restorePaperPosition(fork,policy,inventory),{context,tokenId,position}=restored;
  assert.equal(position.liquidity,BigInt(open.candidate.liquidity));
  assert.equal(position.tickLower,open.candidate.range.tickLower);
  assert.equal(position.tickUpper,open.candidate.range.tickUpper);
  assert.equal(String(tokenId),report.restoredPosition.tokenId,
   'Close-convert replay restored a different token ID');
  assert.equal(String(principal.amount0),report.inventory.principal0Raw);
  assert.equal(String(principal.amount1),report.inventory.principal1Raw);
  const deadline=BigInt(source.timestamp)+300n,bps=BigInt(route.slippageBps),
   calls=[encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{
    tokenId,liquidity:position.liquidity,
    amount0Min:principal.amount0*(10_000n-bps)/10_000n,
    amount1Min:principal.amount1*(10_000n-bps)/10_000n,deadline}]}),
    encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId,
     recipient:PAPER_ACCOUNT,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})],
   withdrawCalldata=encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',args:[calls]}),
   withdrawCallHash=keccak256(withdrawCalldata),withdrawStage=report.stageProfiles[0]!;
  assert.equal(withdrawCalldata,withdrawStage.evidence.calldata,
   'Post-withdraw replay calldata differs from gas report');
  assert.equal(withdrawCallHash,withdrawStage.model.source.callHash,
   'Post-withdraw replay call hash differs from gas report');
  const withdrawTx=await simulatePaperTransaction(fork,{action:'withdraw_collect',
   to:p.positionManager as Address,calldata:withdrawCalldata},PAPER_ACCOUNT);
  assert.equal(withdrawTx.returnData.toLowerCase(),withdrawStage.evidence.returnData.toLowerCase(),
   'Post-withdraw replay collect result differs from gas report');
  assert.equal(withdrawTx.sourceBlock,source.block);assert.equal(withdrawTx.sourceHash.toLowerCase(),source.hash.toLowerCase());
  const [poolSlot,poolLiquidity,token0Balance,token1Balance]=await Promise.all([
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'}),
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'}),
   context.local.readContract({address:p.token0 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]}),
   context.local.readContract({address:p.token1 as Address,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]})]),
   balances={token0:String(token0Balance),token1:String(token1Balance)};
  assert.deepEqual(balances,{token0:report.inventory.preSwap0Raw,token1:report.inventory.preSwap1Raw},
   'Post-withdraw replay inventory differs from the terminal close model');
  const quoteCalldata=encodeFunctionData({abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{
   tokenIn:route.path[0] as Address,tokenOut:route.path[1] as Address,
   amountIn:BigInt(report.inventory.inputAmountRaw),fee:route.fee,sqrtPriceLimitX96:0n}]}),
   quoterCallHash=keccak256(quoteCalldata),quote=await context.local.simulateContract({
    address:route.quoter as Address,abi:paperQuoterAbi,functionName:'quoteExactInputSingle',
    args:[{tokenIn:route.path[0] as Address,tokenOut:route.path[1] as Address,
     amountIn:BigInt(report.inventory.inputAmountRaw),fee:route.fee,sqrtPriceLimitX96:0n}]}),
   expectedOutput=String(quote.result[0]),post=report.postWithdrawReplay;
  assert.equal(quoterCallHash,post.quoterCallHash,'Post-withdraw Quoter call hash differs from gas report');
  assert.equal(expectedOutput,report.quote.expectedOutputRaw,
   'Owned-fork post-withdraw quote differs from the sampled conversion quote');
  assert.deepEqual({tick:poolSlot[1],sqrtPriceX96:String(poolSlot[0]),liquidity:String(poolLiquidity)},
   post.poolState,'Post-withdraw pool state differs from the gas report');
  assert.deepEqual(balances,post.balances,'Post-withdraw balances differ from the gas report');
  assert.equal(withdrawCallHash,post.withdrawCallHash);
  assert.equal(expectedOutput,post.quotedOutputRaw);
  const {replayHash,...replayBody}=post;
  assert.equal(replayHash,contentHash(replayBody));
  const finalPosition=await readCanaryPosition(context.local,tokenId,
   await context.local.getBlockNumber({cacheTime:0}));
  assert.equal(finalPosition.liquidity,0n);assert.equal(finalPosition.tokensOwed0,0n);
  assert.equal(finalPosition.tokensOwed1,0n);
  const sourceReplayHash=contentHash({kind:'paper_close_convert_post_withdraw_source_replay_v2',
   reportHash:report.reportHash,source,scopeHash:report.scopeHash,sequenceHash:report.sequenceHash,
   postWithdrawReplayHash:replayHash,withdrawCallHash,quoterCallHash,expectedOutputRaw:expectedOutput});
  return {sourceReplayHash,postWithdrawReplayHash:replayHash,requests:fork.budget.requests,
   rejected:fork.budget.rejected,maxRequests:fork.budget.maxRequests};
 }finally{await fork.close();}
}

/** Rechecks the canonical close source, then independently
 * replays restore+withdraw+Quoter on an owned fork at that source. Gas remains
 * fork-estimated and registration still requires the store-backed verifier. */
export async function verifyPaperCloseConvertGasSource(client:RobinhoodClient,raw:unknown,
 verifyPersistedEvidence:VerifyPaperCloseConvertGasPersistedEvidence,
 replayOptions:PaperCloseConvertGasReplayOptions){
 const report=verifyPaperCloseConvertGasEvidence(raw),profile=marketProfileSchema.parse(report.profile),
  open=report.openModel as {source:{block:string;hash:`0x${string}`;timestamp:number}},
  source=report.source as {block:string;hash:`0x${string}`;timestamp:number},
  sampledAt=Date.parse(report.sampledAt),age=Date.now()-sampledAt,blockNumber=BigInt(source.block);
 const runtimeIdentity=loadRuntimeIdentity();
 assert(runtimeIdentity,'Paper close-convert gas verification requires a sealed runtime identity');
 assert.deepEqual(report.runtimeIdentity,runtimeIdentity,
  'Paper close-convert gas report belongs to a different sealed runtime');
 assert(Number.isFinite(sampledAt)&&age>=0&&age<=86_400_000,
  'Paper close-convert gas sample is stale or future');
 assert.equal(await client.getChainId(),ROBINHOOD_CHAIN_ID);
 const latest=await client.getBlock();
 assert(latest.number>=blockNumber+64n,'Paper close-convert gas source is not confirmed');
 const chain=new RangeKeeperChain(client,profile.pool),openBlock=BigInt(open.source.block);
 assert(openBlock<blockNumber,'Paper close-convert gas close is not after open');
 await chain.verify({block:openBlock,hash:open.source.hash,timestamp:open.source.timestamp});
 await chain.verify({block:blockNumber,hash:source.hash,timestamp:source.timestamp});
 const [slot,liquidity,references]=await Promise.all([
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'slot0',blockNumber}),
  client.readContract({address:profile.pool.pool,abi:poolAbi,functionName:'liquidity',blockNumber}),
  readRangeKeeperReferences(client,{block:blockNumber,hash:source.hash,timestamp:source.timestamp},profile),
 ]);
 assert(references.eligible&&references.price0&&references.price1&&references.nativePrice,
  'Paper close-convert gas source reference unavailable');
 const poolPrice1=((1n<<192n)*10n**BigInt(profile.pool.decimals1)*references.price0)/
  (slot[0]*slot[0]*10n**BigInt(profile.pool.decimals0));
 const deviation=poolPrice1>references.price1?poolPrice1-references.price1:references.price1-poolPrice1;
 assert(deviation*1_000_000n<=references.price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm),
  'Paper close-convert gas pool price is outside the independent reference band');
 const proof=JSON.parse(JSON.stringify(references.proof,(_,value)=>
  typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 assert.equal(report.frame.tick,slot[1]);assert.equal(report.frame.sqrtPriceX96,String(slot[0]));
 assert.equal(report.frame.poolLiquidity,String(liquidity));
 assert.equal(report.frame.price0,String(references.price0));
 assert.equal(report.frame.price1,String(references.price1));
 assert.equal(report.frame.nativePrice,String(references.nativePrice));
 assert.equal(report.frame.referenceProofHash,referenceProofHash(proof));
 for(const key of ['token0','token1','native'] as const)
  assert.equal(referenceProofHash((report.frame.referenceProof as Record<string,unknown>)[key]),
   referenceProofHash(proof[key]),`Paper close-convert ${key} source proof changed`);
 const p=profile.pool;
 const scope=paperCloseConvertGasScopeV2Schema.parse(report.scope);
 assert.equal(scope.poolAddress.toLowerCase(),p.pool.toLowerCase());
 assert.equal(scope.openModelHash,report.openModelHash);
 assert.equal(scope.profileHash,report.profileHash);
 assert.equal(report.scopeHash,paperCloseConvertGasScopeHashV2(scope));
 assert.equal(report.sizeBand,paperCloseConvertGasSizeBandV2(scope));
 const ownedReplay=await replayPaperCloseConvertPostWithdrawal(report,profile,replayOptions);
 const end=await client.getBlock({blockNumber});
 assert.equal(end.hash.toLowerCase(),source.hash.toLowerCase(),
  'Paper close-convert gas source reorged during owned-fork replay');
 await verifyPersistedEvidence({campaignId:report.campaignId as string,
  revision:report.revision as number,terminalMarkId:report.terminalMarkId as string,
  previousMarkId:report.previousMarkId as string,runtimeIdentity,profile,
  profileHash:report.profileHash as string,openModel:report.openModel as PaperOpenModel,
  openModelHash:report.openModelHash as string,
  openSource:open.source,closeSource:source,
  frame:report.frame as PaperCloseConvertGasPersistedEvidence['frame'],
  route:report.route as PaperCloseConvertRoute,quote:report.quote as PaperCloseConvertQuote,
  scope:report.scope as PaperCloseConvertGasScopeV2,
  scopeHash:report.scopeHash as string,sequenceHash:report.sequenceHash as string,
  reportHash:report.reportHash as string,postWithdrawReplayHash:ownedReplay.postWithdrawReplayHash,
  sourceReplayHash:ownedReplay.sourceReplayHash,
  feeEvidence:report.feeEvidence as PaperCloseConvertGasPersistedEvidence['feeEvidence'],
  feeCarry:report.feeCarry as PaperFeeCarry});
 await chain.verify({block:openBlock,hash:open.source.hash,timestamp:open.source.timestamp});
 await chain.verify({block:blockNumber,hash:source.hash,timestamp:source.timestamp});
 return {verificationClass:'canonical_close_convert_gas_replay_v2' as const,
  evidenceClass:'fork_estimated' as const,status:'provisional' as const,
  reportHash:report.reportHash as string,sourceHash:source.hash,profileHash:report.profileHash as string,
  runtimeIdentity,
  scopeHash:report.scopeHash as string,sequenceHash:report.sequenceHash as string,
  postWithdrawReplayHash:ownedReplay.postWithdrawReplayHash,
  sourceReplayHash:ownedReplay.sourceReplayHash,ownedForkReplayBudget:{requests:ownedReplay.requests,
   rejected:ownedReplay.rejected,maxRequests:ownedReplay.maxRequests},
  verifiedAt:new Date().toISOString()};
}
