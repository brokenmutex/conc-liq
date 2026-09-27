import assert from 'node:assert/strict';
import {z} from 'zod';
import {decodeFunctionData,decodeFunctionResult,encodeFunctionData,keccak256,type Address,type Hash} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {poolAbi} from '../abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {readCanaryPosition} from '../canary-plan/exit.js';
import {principalAmounts} from '../backtest/principal.js';
import {RangeKeeperChain} from '../strategy/rangekeeper/chain.js';
import {PAPER_ACCOUNT,PAPER_ROUTER,paperQuoterAbi,paperRouterAbi,paperTokenAbi} from '../paper/execution-abi.js';
import {restorePaperPosition,type PaperExitInventory} from '../paper/execution-exit.js';
import {openPaperFork,type ForkReadHint} from '../paper/fork.js';
import {simulatePaperTransaction} from '../paper/execution-gas.js';
import {USDG} from '../constants.js';
import {contentHash} from './contracts.js';
import {PAPER_STATIC_CONVERT_GAS_STAGES_V2} from './paper-close-convert-model.js';
import {paperCloseConvertQuoteSchema,paperCloseConvertRouteSchema,
 PAPER_STATIC_CONVERT_GAS_PATH,type PaperCloseConvertRoute,type PaperCloseConvertQuote} from
 './paper-close-convert-model.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {PaperOpenModel} from './paper-open-model.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import type {PaperCloseConvertPostWithdrawEvidence} from './paper-close-convert-preflight.js';
import type {EphemeralStaticPaperCloseConvertFeeReplay} from './paper-close-convert-ephemeral-fees.js';

export type PaperCloseConvertPrestatePhase='owned_fork_open'|'restore'|'final_anchor'|
 typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number];
export type PaperCloseConvertPrestatePhaseTiming={stage:PaperCloseConvertPrestatePhase;
 state:'completed'|'failed';durationMs:number};

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 address=z.string().regex(/^0x[0-9a-fA-F]{40}$/),hex=z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
const inventorySchema=z.object({principal0Raw:raw,principal1Raw:raw,idle0Raw:raw,idle1Raw:raw,
 fee0Raw:raw,fee1Raw:raw,token0Raw:raw,token1Raw:raw,inputAsset:z.enum(['token0','token1']),
 inputAmountRaw:z.string().regex(/^[1-9][0-9]*$/)}).strict();
const stateSchema=z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict();
const serializedFrameSchema=z.object({source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw,price0:raw,price1:raw,nativePrice:raw,
 referenceEligible:z.boolean(),referenceReasons:z.array(z.string()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 referenceProof:z.record(z.string(),z.unknown())}).strict();
const evidenceSchema=z.object({verificationClass:z.literal('owned_fork_close_convert_post_withdraw_v2'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),source:z.object({block:raw,hash,
  timestamp:z.number().int().nonnegative()}).strict(),
 postWithdrawReplayHash:z.string().regex(/^[0-9a-f]{64}$/),withdrawCallHash:hash,quoterCallHash:hash,
 poolState:stateSchema,balances:z.object({token0:raw,token1:raw}).strict(),quotedOutputRaw:raw,
  position:z.object({liquidity:raw,tokensOwed0:raw,tokensOwed1:raw}).strict()}).strict();
const allowanceSchema=z.object({manager0:raw,manager1:raw,router0:raw,router1:raw}).strict();
const gasStageSchema=z.object({stage:z.enum(PAPER_STATIC_CONVERT_GAS_STAGES_V2),
 source:z.object({block:raw,hash,estimatedAt:z.iso.datetime({offset:true}),callHash:hash,
  method:z.literal('owned_fork_nitro_exact_call_v1')}).strict(),
 sourceHash:z.string().regex(/^[0-9a-f]{64}$/),
 callHash:hash,to:address,calldata:hex,returnData:z.string(),localHash:hash,localGasUsed:raw,
 localEffectiveGasPriceWei:raw,estimate:z.object({gas:raw,parentGas:raw,baseFeeWei:raw,
  parentBaseFeeWei:raw,totalFeeWei:raw,parentFeeWei:raw,executionFeeWei:raw,
  basis:z.literal('node_estimateGas_with_paper_prestate_and_parent_component')}).strict(),
 allowancesBefore:allowanceSchema,allowancesAfter:allowanceSchema,
 balancesBefore:z.object({token0:raw,token1:raw}).strict(),
 balancesAfter:z.object({token0:raw,token1:raw}).strict(),gasUnitsExpected:raw,gasUnitsBound:raw,
 scopeHash:z.string().regex(/^[0-9a-f]{64}$/),sequenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 stageIndex:z.number().int().nonnegative()}).strict();

export interface PaperCloseConvertPrestateReport {
 schemaVersion:1;kind:'paper_close_convert_prestate_report_v1';campaignId:string;revision:number;
 profile:MarketProfile;profileHash:string;openModel:PaperOpenModel;openModelHash:string;
 openMarkId:string;previousMarkId:string;previousSource:PaperOpenFrame['source'];
 frame:z.infer<typeof serializedFrameSchema>;
 route:PaperCloseConvertRoute;feeCarryHash:string;feeReplay:{kind:'paper_close_convert_ephemeral_fee_replay_v1';
  classification:'fork_estimated';previousFeeEvidenceId:string;from:{block:string;hash:string};
  to:{block:string;hash:string};stream:string;targetSetHash:string;intervalHash:string;
  previousFeeCarryHash:string;feeCarryHash:string;replayHash:string};
 gasScopeHash:string;gasSequenceHash:string;gasStages:z.infer<typeof gasStageSchema>[];
 inventory:z.infer<typeof inventorySchema>;
 simulationPrestate:{nativeBalanceWei:string;allowances:readonly {token:string;spender:string;amount:string}[]};
 quote:PaperCloseConvertQuote;withdrawCalldata:string;quoteCalldata:string;
 postWithdrawReplay:{poolState:z.infer<typeof stateSchema>;balances:{token0:string;token1:string};
  withdrawCallHash:string;quoterCallHash:string;quotedOutputRaw:string;position:{liquidity:string;
   tokensOwed0:string;tokensOwed1:string};replayHash:string};
 reportHash:string;postWithdraw:PaperCloseConvertPostWithdrawEvidence;sourceReplayHash:string;
 limitations:readonly ['owned_fork_restore_is_not_a_paper_fill','inventory_is_simulated_not_canonical_custody',
  'fee_carry_requires_persisted_replay','v2_worker_acceptance_replay_unavailable',
  'sampler_share_cap_is_one_percent','native_fork_funding_is_simulation_only'];
}

const reportBodySchema=z.object({schemaVersion:z.literal(1),kind:z.literal('paper_close_convert_prestate_report_v1'),
 campaignId:z.uuid(),revision:z.number().int().positive(),profile:marketProfileSchema,
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),openModel:z.custom<PaperOpenModel>(),
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),openMarkId:raw,previousMarkId:raw,
 previousSource:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 frame:serializedFrameSchema,route:paperCloseConvertRouteSchema,
 feeCarryHash:z.string().regex(/^[0-9a-f]{64}$/),inventory:inventorySchema,
 feeReplay:z.object({kind:z.literal('paper_close_convert_ephemeral_fee_replay_v1'),
  classification:z.literal('fork_estimated'),previousFeeEvidenceId:raw,
  from:z.object({block:raw,hash}).strict(),to:z.object({block:raw,hash}).strict(),
  stream:z.string().min(1),targetSetHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  intervalHash:z.string().regex(/^[0-9a-f]{64}$/),
  previousFeeCarryHash:z.string().regex(/^[0-9a-f]{64}$/),
  feeCarryHash:z.string().regex(/^[0-9a-f]{64}$/),replayHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
 gasScopeHash:z.string().regex(/^[0-9a-f]{64}$/),gasSequenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 gasStages:z.array(gasStageSchema).length(PAPER_STATIC_CONVERT_GAS_STAGES_V2.length),
 simulationPrestate:z.object({nativeBalanceWei:raw,allowances:z.array(z.object({token:address,
  spender:address,amount:raw}).strict())}).strict(),
 quote:paperCloseConvertQuoteSchema,withdrawCalldata:hex,quoteCalldata:hex,
 postWithdrawReplay:z.object({poolState:stateSchema,balances:z.object({token0:raw,token1:raw}).strict(),
  withdrawCallHash:hash,quoterCallHash:hash,quotedOutputRaw:raw,
  position:z.object({liquidity:raw,tokensOwed0:raw,tokensOwed1:raw}).strict(),
  replayHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
 limitations:z.tuple([z.literal('owned_fork_restore_is_not_a_paper_fill'),
  z.literal('inventory_is_simulated_not_canonical_custody'),
  z.literal('fee_carry_requires_persisted_replay'),z.literal('v2_worker_acceptance_replay_unavailable'),
  z.literal('sampler_share_cap_is_one_percent'),z.literal('native_fork_funding_is_simulation_only')])}).strict();
export const paperCloseConvertPrestateReportSchema=reportBodySchema.extend({reportHash:z.string().regex(/^[0-9a-f]{64}$/),
 postWithdraw:evidenceSchema,sourceReplayHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

function reportDigestBody(report:PaperCloseConvertPrestateReport){
 const {reportHash:_reportHash,postWithdraw:_postWithdraw,sourceReplayHash:_sourceReplayHash,...body}=report;
 return body;
}

function lowerFee(token:PaperFeeCarry['token0']){
 const q128=1n<<128n,lower=BigInt(token.lowerRawQ128),upper=BigInt(token.upperRawQ128);
 assert(lower>=0n&&upper>=lower&&token.lowerAmountRaw===String(lower/q128)&&
  token.upperAmountRaw===String(upper/q128),'Paper conversion fee carry is malformed');
 return BigInt(token.lowerAmountRaw);
}

function serializeFrame(frame:PaperOpenFrame):z.infer<typeof serializedFrameSchema>{
 return serializedFrameSchema.parse({source:frame.source,tick:frame.tick,
  sqrtPriceX96:String(frame.sqrtPriceX96),poolLiquidity:String(frame.poolLiquidity),
  price0:String(frame.price0),price1:String(frame.price1),nativePrice:String(frame.nativePrice),
  referenceEligible:frame.referenceEligible,referenceReasons:frame.referenceReasons,
  referenceProofHash:frame.referenceProofHash,referenceProof:frame.referenceProof});
}

function deriveInventory(open:PaperOpenModel,frame:PaperOpenFrame,carry:PaperFeeCarry,
 route:PaperCloseConvertRoute){
 const p=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96}),idle0=BigInt(open.candidate.idle0),idle1=BigInt(open.candidate.idle1),
  fee0=lowerFee(carry.token0),fee1=lowerFee(carry.token1),token0=p.amount0+idle0+fee0,
  token1=p.amount1+idle1+fee1,inputAmount=route.inputAsset==='token0'?token0:token1;
 assert.equal(BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted),idle0,
  'Paper conversion token0 allowance remainder differs from idle balance');
 assert.equal(BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted),idle1,
  'Paper conversion token1 allowance remainder differs from idle balance');
 assert(inputAmount>0n,'Paper conversion input amount is zero');
 return {principal0Raw:String(p.amount0),principal1Raw:String(p.amount1),idle0Raw:String(idle0),
  idle1Raw:String(idle1),fee0Raw:String(fee0),fee1Raw:String(fee1),token0Raw:String(token0),
  token1Raw:String(token1),inputAsset:route.inputAsset,inputAmountRaw:String(inputAmount)};
}

function assertTrustedSource(input:{openModel:PaperOpenModel;profile:MarketProfile;frame:PaperOpenFrame;
 previousSource:PaperOpenFrame['source'];feeCarry:PaperFeeCarry;route:PaperCloseConvertRoute;now:number}){
 const {openModel:open,profile,frame,previousSource,feeCarry,route,now}=input,p=profile.pool;
 assert.equal(contentHash(profile),open.profileHash,'Paper conversion profile changed');
 assert.equal(referenceProofHash(frame.referenceProof),frame.referenceProofHash,'Paper conversion reference proof changed');
 assert(frame.referenceEligible&&frame.price0&&frame.price1&&frame.nativePrice&&
  frame.price0>0n&&frame.price1>0n&&frame.nativePrice>0n,'Paper conversion independent reference unavailable');
 assert(BigInt(frame.source.block)>BigInt(previousSource.block)&&
  BigInt(previousSource.block)>=BigInt(open.source.block),'Paper conversion source order invalid');
 assert(frame.source.timestamp>=previousSource.timestamp&&now>=frame.source.timestamp*1000&&
  now-frame.source.timestamp*1000<=180_000,'Paper conversion source stale');
 assert.equal(feeCarry.pool.toLowerCase(),p.pool.toLowerCase());
 assert.equal(feeCarry.token0Address.toLowerCase(),p.token0.toLowerCase());
 assert.equal(feeCarry.token1Address.toLowerCase(),p.token1.toLowerCase());
 assert.equal(feeCarry.from.block,open.source.block);assert.equal(feeCarry.from.hash.toLowerCase(),open.source.hash.toLowerCase());
 // The sampler consumes the ephemeral carry advanced from the persisted
 // predecessor through this exact candidate source. The replay helper binds
 // its interval.from to previousSource and interval.to to frame.source.
 assert.equal(feeCarry.through.block,frame.source.block);
 assert.equal(feeCarry.through.hash.toLowerCase(),frame.source.hash.toLowerCase());
 assert.equal(feeCarry.fee,p.fee);assert.equal(feeCarry.tickSpacing,p.tickSpacing);
 assert.equal(feeCarry.liquidity,open.candidate.liquidity);
 assert.deepEqual(feeCarry.range,open.candidate.range&&{tickLower:open.candidate.range.tickLower,
  tickUpper:open.candidate.range.tickUpper});
 assert(feeCarry.intervals>0&&feeCarry.accounting==='modeled_hypothetical_fee_share');
 assert.equal(p.quoteToken===0?p.token0.toLowerCase():p.token1.toLowerCase(),USDG.toLowerCase(),
  'Static conversion only supports USDG output');
 const quoteAsset=p.quoteToken===0?'token0':'token1',inputAsset=quoteAsset==='token0'?'token1':'token0',
  expectedPath=inputAsset==='token0'?[p.token0,p.token1]:[p.token1,p.token0],
  {routeHash,...routeContent}=route;
 assert.equal(route.inputAsset,inputAsset);assert.equal(route.path[1]!.toLowerCase(),
  (quoteAsset==='token0'?p.token0:p.token1).toLowerCase());
 assert.equal(route.router.toLowerCase(),p.router.toLowerCase());
 assert.equal(route.quoter.toLowerCase(),p.quoter.toLowerCase());assert.equal(route.fee,p.fee);
 assert(route.path.every((address,index)=>address.toLowerCase()===expectedPath[index]!.toLowerCase()));
 assert.equal(route.pathVersion,PAPER_STATIC_CONVERT_GAS_PATH);assert.equal(routeHash,contentHash(routeContent));
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0!)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0)),
  deviation=poolPrice1>frame.price1!?poolPrice1-frame.price1!:frame.price1!-poolPrice1;
 assert(deviation*1_000_000n<=frame.price1!*BigInt(profile.referencePolicy.maxPoolDeviationPpm),
  'Paper conversion pool price exceeds independent-reference band');
}

/**
 * Rebuilds the static/manual paper position on an owned fork at a later
 * canonical frame, performs decreaseLiquidity+collect, then quotes the exact
 * risk-token balance into configured USDG. It has no terminal mark dependency
 * and makes no upstream writes. `verifyPersistedContext` must read and replay
 * the open/prior marks and cumulative fee carry before this sampler is called.
 */
export async function samplePaperCloseConvertPrestate(input:{rpcUrl:string;openModel:PaperOpenModel;
 openMarkId:string;profile:MarketProfile;frame:PaperOpenFrame;
 previous:{markId:string;source:PaperOpenFrame['source']};route:PaperCloseConvertRoute;
 feeCarry:PaperFeeCarry;feeReplay:EphemeralStaticPaperCloseConvertFeeReplay;
 verifyPersistedContext:()=>Promise<void>;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
 beforeRead:()=>Promise<void>;maxRequests?:number;timeoutMs?:number;now?:number;
 deterministicClock?:boolean;sampledAt?:string;
 prefetchHints?:readonly ForkReadHint[];
 onReadHints?:(hints:readonly ForkReadHint[])=>void;
 onPhaseTiming?:(event:PaperCloseConvertPrestatePhaseTiming)=>void}):Promise<PaperCloseConvertPrestateReport>{
 const now=input.now??Date.now(),open=input.openModel,profile=marketProfileSchema.parse(input.profile),
  p=profile.pool,frame=input.frame,route=paperCloseConvertRouteSchema.parse(input.route),
  carry=input.feeCarry;
 const measurePhase=async<T>(stage:PaperCloseConvertPrestatePhase,run:()=>Promise<T>):Promise<T>=>{
  if(!input.onPhaseTiming)return run();
  const startedAt=Date.now();let state:PaperCloseConvertPrestatePhaseTiming['state']='completed';
  try{return await run();}
  catch(error){state='failed';throw error;}
  finally{
   const durationMs=Math.min(86_400_000,Math.max(0,Math.trunc(Date.now()-startedAt)));
   try{input.onPhaseTiming?.({stage,state,durationMs});}catch{/* Diagnostics must not affect sampling. */}
  }
 };
 assert.equal(input.feeReplay.kind,'paper_close_convert_ephemeral_fee_replay_v1');
 assert.equal(input.feeReplay.classification,'fork_estimated');
 assert.equal(input.feeReplay.to.block,frame.source.block);
 assert.equal(input.feeReplay.to.hash.toLowerCase(),frame.source.hash.toLowerCase());
 assert.equal(input.feeReplay.feeCarryHash,contentHash(carry));
 assert.equal(contentHash(input.feeReplay.feeCarry),contentHash(carry));
 assert.equal(input.feeReplay.intervalHash,contentHash(input.feeReplay.interval));
 assert.equal(input.feeReplay.interval.coverage.stream,input.feeReplay.stream);
 assert.equal(input.feeReplay.interval.coverage.targetSetHash,input.feeReplay.targetSetHash);
 assert.equal(open.strategyId,'static_manual_v1');assert.equal(open.campaignId,input.openModel.campaignId);
 assertTrustedSource({openModel:open,profile,frame,previousSource:input.previous.source,
  feeCarry:carry,route,now});
 await input.verifyPersistedContext();
 await input.verifyAnchors(p.chainId,[open.source,input.previous.source,frame.source]);
 const inventory=deriveInventory(open,frame,carry,route),riskIndex=route.inputAsset==='token0'?0:1,
  riskToken=(riskIndex===0?p.token0:p.token1) as Address,
  market={symbol:'STATIC',rwa:riskToken,pool:p.pool as Address,fee:p.fee,
   tickSpacing:p.tickSpacing,rwaDecimals:riskIndex===0?p.decimals0:p.decimals1},
  policy={market,budgetQuote:'10000000000',halfWidthSpacings:1,
   maxLiquiditySharePpm:10_000,maxSlippageBps:route.slippageBps,transactionTtlSeconds:300} as const,
  source={number:BigInt(frame.source.block),hash:frame.source.hash as Hash,timestamp:BigInt(frame.source.timestamp)},
  exitInventory:PaperExitInventory={liquidity:open.candidate.liquidity,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   idle0:inventory.idle0Raw,idle1:inventory.idle1Raw,fee0:inventory.fee0Raw,fee1:inventory.fee1Raw,
   nativeBalanceWei:'1000000000000000000',allowances:[
    {token:p.token0 as Address,spender:p.positionManager as Address,amount:inventory.idle0Raw},
    {token:p.token1 as Address,spender:p.positionManager as Address,amount:inventory.idle1Raw},
    {token:p.token0 as Address,spender:p.router as Address,amount:'0'},
    {token:p.token1 as Address,spender:p.router as Address,amount:'0'}]};
 assert(BigInt(open.candidate.dilutedSharePpm)<=10_000n,
  'paper_close_convert_prestate_sampler_share_cap_one_percent');
 const fork=await measurePhase('owned_fork_open',()=>openPaperFork({source,rpcUrl:input.rpcUrl,beforeRead:input.beforeRead,
  maxRequests:input.maxRequests??1600,timeoutMs:input.timeoutMs??300_000,
  deterministicClock:input.deterministicClock??false,
  prefetchHints:input.prefetchHints,onReadHints:input.onReadHints}));
 try{
  const local=await import('../client.js').then(({createRobinhoodClient})=>
   createRobinhoodClient(fork.localUrl,60_000,{retryCount:0}));
  const {context,tokenId,position}=await measurePhase('restore',async()=>{
   await new RangeKeeperChain(local,p).verify({block:source.number,hash:source.hash,
    timestamp:frame.source.timestamp});
   return restorePaperPosition(fork,policy,exitInventory);
  });
  assert.equal(position.liquidity,BigInt(open.candidate.liquidity));
  assert.equal(position.tickLower,open.candidate.range.tickLower);
  assert.equal(position.tickUpper,open.candidate.range.tickUpper);
  const balances=async()=>({token0:String(await context.local.readContract({address:p.token0 as Address,
   abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]})),
   token1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_ACCOUNT]}))});
  const allowances=async()=>({manager0:String(await context.local.readContract({address:p.token0 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.positionManager as Address]})),
   manager1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.positionManager as Address]})),
   router0:String(await context.local.readContract({address:p.token0 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.router as Address]})),
   router1:String(await context.local.readContract({address:p.token1 as Address,
    abi:paperTokenAbi,functionName:'allowance',args:[PAPER_ACCOUNT,p.router as Address]}))});
  const stageRows:{stage:typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number];tx:Awaited<ReturnType<typeof simulatePaperTransaction>>;
   allowancesBefore:Awaited<ReturnType<typeof allowances>>;allowancesAfter:Awaited<ReturnType<typeof allowances>>;
   balancesBefore:Awaited<ReturnType<typeof balances>>;balancesAfter:Awaited<ReturnType<typeof balances>>}[]=[];
  const send=async(stage:typeof PAPER_STATIC_CONVERT_GAS_STAGES_V2[number],to:Address,
   calldata:`0x${string}`)=>measurePhase(stage,async()=>{
   const allowancesBefore=await allowances(),balancesBefore=await balances(),
    tx=await simulatePaperTransaction(fork,{action:stage,to,calldata},PAPER_ACCOUNT),
    allowancesAfter=await allowances(),balancesAfter=await balances();
   assert.equal(tx.sourceBlock,frame.source.block);
   assert(tx.sourceHash.toLowerCase()===frame.source.hash.toLowerCase());
   assert(BigInt(tx.estimate.gas)>0n&&BigInt(tx.estimate.parentGas)<=BigInt(tx.estimate.gas));
   stageRows.push({stage,tx,allowancesBefore,allowancesAfter,balancesBefore,balancesAfter});
   return tx;
  });
  const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   sqrtPriceX96:frame.sqrtPriceX96}),deadline=source.timestamp+300n,bps=BigInt(route.slippageBps),
   withdrawCalldata=encodeFunctionData({abi:canaryExitAbi,functionName:'multicall',args:[[
    encodeFunctionData({abi:canaryExitAbi,functionName:'decreaseLiquidity',args:[{tokenId,
     liquidity:position.liquidity,amount0Min:principal.amount0*(10_000n-bps)/10_000n,
     amount1Min:principal.amount1*(10_000n-bps)/10_000n,deadline}]}),
    encodeFunctionData({abi:canaryExitAbi,functionName:'collect',args:[{tokenId,
     recipient:PAPER_ACCOUNT,amount0Max:(1n<<128n)-1n,amount1Max:(1n<<128n)-1n}]})]]}),
   withdraw=await send('withdraw_collect',p.positionManager as Address,withdrawCalldata),
   afterBalances=await balances();
  assert.equal(withdraw.sourceBlock,frame.source.block);assert.equal(withdraw.sourceHash.toLowerCase(),frame.source.hash.toLowerCase());
  assert.deepEqual(afterBalances,{token0:inventory.token0Raw,token1:inventory.token1Raw},
   'Owned-fork post-withdraw inventory differs from the saved candidate and fee carry');
  const inputAmount=BigInt(inventory.inputAmountRaw),quoteCalldata=encodeFunctionData({abi:paperQuoterAbi,
   functionName:'quoteExactInputSingle',args:[{tokenIn:route.path[0] as Address,
    tokenOut:route.path[1] as Address,amountIn:inputAmount,fee:route.fee,sqrtPriceLimitX96:0n}]}),
   quoteResult=await context.local.simulateContract({address:route.quoter as Address,
    abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:route.path[0] as Address,
     tokenOut:route.path[1] as Address,amountIn:inputAmount,fee:route.fee,sqrtPriceLimitX96:0n}]}),
   output=String(quoteResult.result[0]),minimum=String(BigInt(output)*BigInt(10_000-route.slippageBps)/10_000n);
  assert(BigInt(output)>0n&&BigInt(minimum)>0n,'Owned-fork USDG quote is unavailable');
  const quoteBody={schemaVersion:1 as const,kind:'paper_exact_input_quote_v1' as const,
   source:frame.source,router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
   inputAsset:route.inputAsset,inputAmountRaw:inventory.inputAmountRaw,expectedOutputRaw:output,
   minimumOutputRaw:minimum,slippageBps:route.slippageBps,pathVersion:route.pathVersion},
   quote=paperCloseConvertQuoteSchema.parse({...quoteBody,quoteHash:contentHash(quoteBody)}),
   swapInput=route.path[0] as Address,swapOutput=route.path[1] as Address,
   approveData=encodeFunctionData({abi:paperTokenAbi,functionName:'approve',
    args:[route.router as Address,inputAmount]});
  await send('approve_swap_input',swapInput,approveData);
  const swapInner=encodeFunctionData({abi:paperRouterAbi,functionName:'exactInputSingle',args:[{
   tokenIn:swapInput,tokenOut:swapOutput,fee:route.fee,recipient:PAPER_ACCOUNT,
   amountIn:inputAmount,amountOutMinimum:BigInt(minimum),sqrtPriceLimitX96:0n}]}),
   swapData=encodeFunctionData({abi:paperRouterAbi,functionName:'multicall',
    args:[deadline,[swapInner]]}),swapTx=await send('swap',route.router as Address,swapData),
   swapReturns=decodeFunctionResult({abi:paperRouterAbi,functionName:'multicall',data:swapTx.returnData});
  assert.equal(swapReturns.length,1);
  assert.equal(decodeFunctionResult({abi:paperRouterAbi,functionName:'exactInputSingle',
   data:swapReturns[0]!}),BigInt(output),'Owned-fork swap output differs from exact source quote');
  for(const index of [0,1] as const){
   await send(index===0?'cleanup_manager_token0':'cleanup_manager_token1',
    (index===0?p.token0:p.token1) as Address,encodeFunctionData({abi:paperTokenAbi,
     functionName:'approve',args:[p.positionManager as Address,0n]}));
  }
  for(const index of [0,1] as const){
   await send(index===0?'cleanup_router_token0':'cleanup_router_token1',
    (index===0?p.token0:p.token1) as Address,encodeFunctionData({abi:paperTokenAbi,
     functionName:'approve',args:[p.router as Address,0n]}));
  }
  assert.deepEqual(stageRows.map(row=>row.stage),[...PAPER_STATIC_CONVERT_GAS_STAGES_V2]);
  const finalBalances=await balances(),finalAllowances=await allowances();
  assert.equal(finalBalances[route.inputAsset],'0','Converted risk-token residue remains');
  assert(Object.values(finalAllowances).every(value=>value==='0'),'Fork allowance cleanup incomplete');
  const [slot,liquidity]=await Promise.all([
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'slot0'}),
   context.local.readContract({address:p.pool as Address,abi:poolAbi,functionName:'liquidity'})]),
   finalPosition=await readCanaryPosition(context.local,tokenId,await context.local.getBlockNumber({cacheTime:0}));
  assert.equal(finalPosition.liquidity,0n);assert.equal(finalPosition.tokensOwed0,0n);
  assert.equal(finalPosition.tokensOwed1,0n);
  const gasScope={campaignId:open.campaignId,revision:open.revision,openMarkId:input.openMarkId,
   latestMarkId:input.previous.markId,openModelHash:contentHash(open),profileHash:open.profileHash,
   feeCarryHash:contentHash(carry),feeReplayHash:input.feeReplay.replayHash,source:frame.source,
   routeHash:route.routeHash,inventory,quoteHash:quote.quoteHash,
   initialAllowances:stageRows[0]!.allowancesBefore};
  const gasScopeHash=contentHash(gasScope),sampledAt=input.sampledAt??new Date().toISOString(),
   provisionalStages=stageRows.map((row,stageIndex)=>{
    const callHash=keccak256(row.tx.calldata),gasUnitsExpected=String(row.tx.estimate.gas),
     model={schemaVersion:1,scopeHash:gasScopeHash,stageIndex,
      source:{block:row.tx.sourceBlock,hash:row.tx.sourceHash,estimatedAt:sampledAt,callHash,
       method:'owned_fork_nitro_exact_call_v1'},gasUnitsExpected,gasUnitsBound:String(
       (BigInt(gasUnitsExpected)*13n+9n)/10n),allowancesBefore:row.allowancesBefore,
      allowancesAfter:row.allowancesAfter,balancesBefore:row.balancesBefore,
      balancesAfter:row.balancesAfter,to:row.tx.to,calldata:row.tx.calldata,
      returnData:row.tx.returnData,localHash:row.tx.localHash,
      localGasUsed:row.tx.localGasUsed,localEffectiveGasPriceWei:row.tx.localEffectiveGasPriceWei,
      estimate:row.tx.estimate};
    return {stage:row.stage,source:model.source,sourceHash:contentHash(model.source),callHash,to:row.tx.to,
     calldata:row.tx.calldata,returnData:row.tx.returnData,localHash:row.tx.localHash,
     localGasUsed:row.tx.localGasUsed,localEffectiveGasPriceWei:row.tx.localEffectiveGasPriceWei,
     estimate:row.tx.estimate,allowancesBefore:row.allowancesBefore,allowancesAfter:row.allowancesAfter,
     balancesBefore:row.balancesBefore,balancesAfter:row.balancesAfter,gasUnitsExpected,
     gasUnitsBound:model.gasUnitsBound,scopeHash:gasScopeHash,sequenceHash:'pending',stageIndex};
   }),gasSequenceHash=contentHash(provisionalStages.map(stage=>({stage:stage.stage,
    callHash:stage.callHash,sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
    allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
    balancesAfter:stage.balancesAfter})));
  for(const stage of provisionalStages)(stage as {sequenceHash:string}).sequenceHash=gasSequenceHash;
  const withdrawCallHash=keccak256(withdrawCalldata),quoterCallHash=keccak256(quoteCalldata),
   replayBody={poolState:{tick:slot[1],sqrtPriceX96:String(slot[0]),poolLiquidity:String(liquidity)},
    balances:afterBalances,withdrawCallHash,quoterCallHash,quotedOutputRaw:output,
    position:{liquidity:String(finalPosition.liquidity),tokensOwed0:String(finalPosition.tokensOwed0),
     tokensOwed1:String(finalPosition.tokensOwed1)}},
   replay={...replayBody,replayHash:contentHash(replayBody)},
   body={schemaVersion:1 as const,kind:'paper_close_convert_prestate_report_v1' as const,
    campaignId:open.campaignId,revision:open.revision,profile,profileHash:open.profileHash,
    openModel:open,openModelHash:contentHash(open),openMarkId:input.openMarkId,
   previousMarkId:input.previous.markId,previousSource:input.previous.source,frame:serializeFrame(frame),route,
    feeCarryHash:contentHash(carry),feeReplay:{kind:input.feeReplay.kind,
     classification:input.feeReplay.classification,previousFeeEvidenceId:input.feeReplay.previousFeeEvidenceId,
     from:input.feeReplay.from,to:input.feeReplay.to,stream:input.feeReplay.stream,
   targetSetHash:input.feeReplay.targetSetHash,intervalHash:input.feeReplay.intervalHash,
     previousFeeCarryHash:input.feeReplay.previousFeeCarryHash,
     feeCarryHash:input.feeReplay.feeCarryHash,replayHash:input.feeReplay.replayHash},inventory,
    gasScopeHash,gasSequenceHash,gasStages:provisionalStages,
    simulationPrestate:{nativeBalanceWei:exitInventory.nativeBalanceWei,
     allowances:exitInventory.allowances.map(({token,spender,amount})=>({token:token.toLowerCase(),
      spender:spender.toLowerCase(),amount}))},quote,withdrawCalldata,quoteCalldata,
    postWithdrawReplay:replay,limitations:['owned_fork_restore_is_not_a_paper_fill',
     'inventory_is_simulated_not_canonical_custody','fee_carry_requires_persisted_replay',
     'v2_worker_acceptance_replay_unavailable','sampler_share_cap_is_one_percent',
     'native_fork_funding_is_simulation_only'] as const},
   reportHash=contentHash(body),postWithdraw:PaperCloseConvertPostWithdrawEvidence={
    verificationClass:'owned_fork_close_convert_post_withdraw_v2',reportHash,source:frame.source,
    postWithdrawReplayHash:replay.replayHash,withdrawCallHash,quoterCallHash,
    poolState:replay.poolState,balances:afterBalances,quotedOutputRaw:output,
    position:replay.position},
   sourceReplayHash=contentHash({kind:'paper_close_convert_prestate_source_replay_v1',reportHash,
    source:frame.source,openModelHash:contentHash(open),feeCarryHash:contentHash(carry),
    postWithdrawReplayHash:replay.replayHash,quoteHash:quote.quoteHash});
  await measurePhase('final_anchor',()=>input.verifyAnchors(p.chainId,
   [open.source,input.previous.source,frame.source]));
  return verifyPaperCloseConvertPrestateReport({...body,reportHash,postWithdraw,sourceReplayHash});
 }finally{await fork.close();}
}

/** Checks the sampler envelope against independently supplied saved inputs.
 * It proves byte/source/inventory binding; upstream wiring must still run the
 * bounded owned-fork sampler itself and replay the persisted fee carry. */
export function verifyPaperCloseConvertPrestateReport(rawInput:unknown):PaperCloseConvertPrestateReport{
 const report=paperCloseConvertPrestateReportSchema.parse(rawInput);
 assert.equal(report.reportHash,contentHash(reportDigestBody(report)),
  'Paper close-convert prestate report changed');
 assert.equal(report.openModelHash,contentHash(report.openModel));
 assert.equal(report.feeReplay.to.block,report.frame.source.block);
 assert.equal(report.feeReplay.to.hash.toLowerCase(),report.frame.source.hash.toLowerCase());
 assert.equal(report.feeReplay.feeCarryHash,report.feeCarryHash);
 assert.equal(report.feeReplay.from.block,report.previousSource.block);
 assert.equal(report.feeReplay.from.hash.toLowerCase(),report.previousSource.hash.toLowerCase());
 assert(/^[1-9][0-9]*$/.test(report.feeReplay.previousFeeEvidenceId));
 assert.equal(report.openModel.profileHash,report.profileHash);
 assert.equal(report.profileHash,contentHash(report.profile));
 assert.equal(report.openModel.campaignId,report.campaignId);
 assert.equal(report.openModel.revision,report.revision);
 const {routeHash,...routeBody}=report.route;
 assert.equal(routeHash,contentHash(routeBody));
 const {quoteHash,...quoteBody}=report.quote;
 assert.equal(quoteHash,contentHash(quoteBody));
 assert.equal(report.quote.source.block,report.frame.source.block);
 assert.equal(report.quote.source.hash.toLowerCase(),report.frame.source.hash.toLowerCase());
 assert.equal(report.quote.inputAsset,report.route.inputAsset);
 assert.equal(report.quote.path[0]?.toLowerCase(),report.route.path[0]?.toLowerCase());
 assert.equal(report.quote.path[1]?.toLowerCase(),report.route.path[1]?.toLowerCase());
 assert.equal(report.quote.fee,report.route.fee);
 assert.equal(report.postWithdraw.reportHash,report.reportHash);
 const {replayHash,...replayBody}=report.postWithdrawReplay;
 assert.equal(replayHash,contentHash(replayBody));
 assert.equal(report.postWithdraw.postWithdrawReplayHash,replayHash);
 assert.equal(report.postWithdraw.withdrawCallHash,report.postWithdrawReplay.withdrawCallHash);
 assert.equal(report.postWithdraw.quoterCallHash,report.postWithdrawReplay.quoterCallHash);
 assert.equal(report.postWithdraw.quotedOutputRaw,report.quote.expectedOutputRaw);
 assert.equal(report.quote.inputAmountRaw,report.inventory.inputAmountRaw);
 assert.equal(report.postWithdraw.source.hash.toLowerCase(),report.frame.source.hash.toLowerCase());
 assert.deepEqual(report.postWithdraw.balances,{token0:report.inventory.token0Raw,
  token1:report.inventory.token1Raw});
 assert.equal(report.postWithdraw.position.liquidity,'0');
 assert.equal(report.postWithdraw.position.tokensOwed0,'0');
 assert.equal(report.postWithdraw.position.tokensOwed1,'0');
 const expectedInput=report.route.inputAsset==='token0'?report.inventory.token0Raw:report.inventory.token1Raw;
 assert.equal(report.inventory.inputAmountRaw,expectedInput);
 assert.equal(report.inventory.token0Raw,String(BigInt(report.inventory.principal0Raw)+
  BigInt(report.inventory.idle0Raw)+BigInt(report.inventory.fee0Raw)));
 assert.equal(report.inventory.token1Raw,String(BigInt(report.inventory.principal1Raw)+
  BigInt(report.inventory.idle1Raw)+BigInt(report.inventory.fee1Raw)));
 const gasScopeHash=contentHash({campaignId:report.campaignId,revision:report.revision,
  openMarkId:report.openMarkId,latestMarkId:report.previousMarkId,openModelHash:report.openModelHash,
  profileHash:report.profileHash,feeCarryHash:report.feeCarryHash,
  feeReplayHash:report.feeReplay.replayHash,source:report.frame.source,
  routeHash:report.route.routeHash,inventory:report.inventory,quoteHash:report.quote.quoteHash,
  initialAllowances:report.gasStages[0]!.allowancesBefore});
 assert.equal(report.gasScopeHash,gasScopeHash,'Prestate gas scope changed');
 const stageSequence=report.gasStages.map(stage=>({stage:stage.stage,callHash:stage.callHash,
  sourceHash:stage.sourceHash,allowancesBefore:stage.allowancesBefore,
  allowancesAfter:stage.allowancesAfter,balancesBefore:stage.balancesBefore,
  balancesAfter:stage.balancesAfter}));
 assert.equal(report.gasSequenceHash,contentHash(stageSequence),'Prestate gas sequence changed');
 assert.deepEqual(report.gasStages.map(stage=>stage.stage),[...PAPER_STATIC_CONVERT_GAS_STAGES_V2]);
 let estimatedAt:string|null=null,priorAllowance:Record<string,string>|null=null,
  priorBalances:Record<string,string>|null=null;
 for(let index=0;index<report.gasStages.length;index++){
  const stage=report.gasStages[index]!,stageName=PAPER_STATIC_CONVERT_GAS_STAGES_V2[index]!;
  assert.equal(stage.stageIndex,index);assert.equal(stage.scopeHash,gasScopeHash);
  assert.equal(stage.sequenceHash,report.gasSequenceHash);
  assert.equal(stage.source.block,report.frame.source.block);
  assert.equal(stage.source.hash.toLowerCase(),report.frame.source.hash.toLowerCase());
  assert.equal(stage.source.callHash,stage.callHash);
  assert.equal(stage.callHash,keccak256(stage.calldata as `0x${string}`));
  assert.equal(stage.sourceHash,contentHash(stage.source));
  assert.equal(stage.source.method,'owned_fork_nitro_exact_call_v1');
  if(estimatedAt===null)estimatedAt=stage.source.estimatedAt;
  else assert.equal(stage.source.estimatedAt,estimatedAt);
  if(priorAllowance)assert.deepEqual(stage.allowancesBefore,priorAllowance);
  if(priorBalances)assert.deepEqual(stage.balancesBefore,priorBalances);
  const estimate=stage.estimate;
  assert.equal(stage.gasUnitsExpected,estimate.gas);
  assert.equal(stage.gasUnitsBound,String((BigInt(estimate.gas)*13n+9n)/10n));
  assert(BigInt(estimate.parentGas)<=BigInt(estimate.gas));
  assert.equal(BigInt(estimate.totalFeeWei),BigInt(estimate.gas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.parentFeeWei),BigInt(estimate.parentGas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.executionFeeWei),BigInt(estimate.totalFeeWei)-BigInt(estimate.parentFeeWei));
  const to=stage.to as `0x${string}`,calldata=stage.calldata as `0x${string}`;
  if(stageName==='withdraw_collect'){
   assert.equal(to.toLowerCase(),report.profile.pool.positionManager.toLowerCase());
   assert.equal(calldata,report.withdrawCalldata);
  }else if(stageName==='approve_swap_input'){
   assert.equal(to.toLowerCase(),report.route.path[0]!.toLowerCase());
   const call=decodeFunctionData({abi:paperTokenAbi,data:calldata});
   assert.equal(call.functionName,'approve');assert.equal(call.args[0].toLowerCase(),report.route.router.toLowerCase());
   assert.equal(call.args[1],BigInt(report.inventory.inputAmountRaw));
  }else if(stageName==='swap'){
   assert.equal(to.toLowerCase(),report.route.router.toLowerCase());
   const outer=decodeFunctionData({abi:paperRouterAbi,data:calldata});
   assert.equal(outer.functionName,'multicall');assert.equal(outer.args[1].length,1);
   const inner=decodeFunctionData({abi:paperRouterAbi,data:outer.args[1][0]!});
   assert.equal(inner.functionName,'exactInputSingle');
   const params=inner.args[0];
   assert.equal(params.tokenIn.toLowerCase(),report.route.path[0]!.toLowerCase());
   assert.equal(params.tokenOut.toLowerCase(),report.route.path[1]!.toLowerCase());
   assert.equal(params.fee,report.route.fee);assert.equal(params.amountIn,BigInt(report.inventory.inputAmountRaw));
   assert.equal(params.amountOutMinimum,BigInt(report.quote.minimumOutputRaw));
  }else{
   const tokenIndex=stageName.endsWith('token0')?0:1,
    routerStage=stageName.startsWith('cleanup_router'),
    expectedToken=tokenIndex===0?report.profile.pool.token0:report.profile.pool.token1,
    expectedSpender=routerStage?report.route.router:report.profile.pool.positionManager;
   assert.equal(to.toLowerCase(),expectedToken.toLowerCase());
   const call=decodeFunctionData({abi:paperTokenAbi,data:calldata});
   assert.equal(call.functionName,'approve');assert.equal(call.args[0].toLowerCase(),expectedSpender.toLowerCase());
   assert.equal(call.args[1],0n);
  }
  priorAllowance=stage.allowancesAfter;priorBalances=stage.balancesAfter;
 }
 assert.equal(priorBalances?.[report.route.inputAsset],'0');
 assert(Object.values(priorAllowance??{}).every(value=>value==='0'));
 assert.equal(report.sourceReplayHash,contentHash({kind:'paper_close_convert_prestate_source_replay_v1',
  reportHash:report.reportHash,source:report.frame.source,openModelHash:report.openModelHash,
  feeCarryHash:report.feeCarryHash,postWithdrawReplayHash:replayHash,quoteHash:report.quote.quoteHash}));
 return report;
}
