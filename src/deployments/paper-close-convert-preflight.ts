import assert from 'node:assert/strict';
import {z} from 'zod';
import type {RobinhoodClient} from '../client.js';
import {contentHash} from './contracts.js';
import {principalAmounts} from '../backtest/principal.js';
import {paperQuoterAbi} from '../paper/execution-abi.js';
import {USDG} from '../constants.js';
import {referenceProofHash} from './market-profile.js';
import type {PaperFeeCarry} from './paper-fee-replay.js';
import {ephemeralStaticPaperCloseConvertFeeReplaySchema,verifyEphemeralStaticPaperCloseConvertFeeReplay,
 type EphemeralStaticPaperCloseConvertFeeReplay} from './paper-close-convert-ephemeral-fees.js';
import {paperCloseConvertQuoteSchema,paperCloseConvertRouteSchema,
 paperCloseConvertGasScopeV2Schema,paperCloseConvertGasScopeHashV2,
 paperCloseConvertGasSizeBandV2,paperCloseConvertGasAllowanceStatesV2,
 costPaperCloseConvertGasV2,PAPER_STATIC_CONVERT_GAS_PATH,
 type PaperCloseConvertGasScopeV2,type PaperCloseConvertQuote,
 type PaperCloseConvertRoute,type PaperCloseConvertCostsV2} from './paper-close-convert-model.js';
import type {PaperGasProfileRow} from './paper-cost.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {PaperCanonicalAnchor} from './paper-canonical-anchors.js';
import type {DeploymentStore} from './store.js';

const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const postWithdrawSchema=z.object({verificationClass:z.literal('owned_fork_close_convert_post_withdraw_v2'),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/),source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 postWithdrawReplayHash:z.string().regex(/^[0-9a-f]{64}$/),withdrawCallHash:hash,quoterCallHash:hash,
 poolState:z.object({tick:z.number().int(),sqrtPriceX96:raw,poolLiquidity:raw}).strict(),
 balances:z.object({token0:raw,token1:raw}).strict(),quotedOutputRaw:raw,
 position:z.object({liquidity:raw,tokensOwed0:raw,tokensOwed1:raw}).strict()}).strict();
export type PaperCloseConvertPostWithdrawEvidence=z.infer<typeof postWithdrawSchema>;

export interface PaperCloseConvertPreflightState {
 openModel:import('./paper-open-model.js').PaperOpenModel;openMarkId:string;
 previous:{markId:string;sourceBlock:string;sourceHash:string;source:PaperOpenFrame['source']};
 profile:import('./market-profile.js').MarketProfile;profileHash:string;configHash:string;
 parameters:Record<string,unknown>;
}
export interface PaperCloseConvertPreviewWriter {
 recordPreview(input:{campaignId:string;expectedRevision:number;kind:'close_convert';
  request:Record<string,unknown>;proposal:Record<string,unknown>;evidence:Record<string,unknown>;
  expiresAt:Date}):Promise<{id:string;contentDigest:string;expiresAt:Date|string}>;
}
export interface PaperCloseConvertFeeEvidenceBinding {id:string;proofHash:string;carryHash:string}

export type PaperStaticCloseConvertTerminalModel={
 schemaVersion:1;kind:'paper_static_manual_close_convert_terminal_v2';campaignId:string;revision:number;
 openMarkId:string;previousMarkId:string;openModelHash:string;source:PaperOpenFrame['source'];
 poolState:PaperCloseConvertPostWithdrawEvidence['poolState'];
 reference:{price0:string;price1:string;nativePrice:string};referenceProof:Record<string,unknown>;
 referenceProofHash:string;inventory:{principal0Raw:string;principal1Raw:string;idle0Raw:string;idle1Raw:string;
 fee0Raw:string;fee1Raw:string;token0Raw:string;token1Raw:string;inputAsset:'token0'|'token1';inputAmountRaw:string};
 conversionRoute:PaperCloseConvertRoute;quote:PaperCloseConvertQuote;
 feeReplay:EphemeralStaticPaperCloseConvertFeeReplay;
 postWithdraw:PaperCloseConvertPostWithdrawEvidence;scope:PaperCloseConvertGasScopeV2;
 costs:PaperCloseConvertCostsV2;modelHash:string;
};

const terminalHashBody=(model:Omit<PaperStaticCloseConvertTerminalModel,'modelHash'>)=>model;
const terminalBodySchema=z.object({schemaVersion:z.literal(1),kind:z.literal('paper_static_manual_close_convert_terminal_v2'),
 campaignId:z.uuid(),revision:z.number().int().positive(),openMarkId:raw,previousMarkId:raw,
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),
 source:z.object({block:raw,hash,timestamp:z.number().int().nonnegative()}).strict(),
 poolState:postWithdrawSchema.shape.poolState,
 reference:z.object({price0:raw,price1:raw,nativePrice:raw}).strict(),
 referenceProof:z.record(z.string(),z.unknown()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
 inventory:z.object({principal0Raw:raw,principal1Raw:raw,idle0Raw:raw,idle1Raw:raw,
  fee0Raw:raw,fee1Raw:raw,token0Raw:raw,token1Raw:raw,inputAsset:z.enum(['token0','token1']),
  inputAmountRaw:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
 conversionRoute:paperCloseConvertRouteSchema,quote:paperCloseConvertQuoteSchema,
 feeReplay:ephemeralStaticPaperCloseConvertFeeReplaySchema,
 postWithdraw:postWithdrawSchema,scope:paperCloseConvertGasScopeV2Schema,
 costs:z.custom<PaperCloseConvertCostsV2>(),}).strict();
const terminalSchema=terminalBodySchema.extend({modelHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

export function parsePaperStaticCloseConvertTerminalV2(rawInput:unknown):PaperStaticCloseConvertTerminalModel{
 const model=terminalSchema.parse(rawInput),{modelHash,...body}=model;
 if(contentHash(body)!==modelHash)throw Error('paper_close_convert_terminal_model_hash_invalid');
 const {replayHash,...replayBody}=model.feeReplay;
 if(contentHash(replayBody)!==replayHash||contentHash(model.feeReplay.interval)!==model.feeReplay.intervalHash||
  contentHash(model.feeReplay.feeCarry)!==model.feeReplay.feeCarryHash)
  throw Error('paper_close_convert_terminal_fee_replay_hash_invalid');
 return model;
}

function exactRoute(state:PaperCloseConvertPreflightState):PaperCloseConvertRoute{
 const p=state.profile.pool,limits=state.parameters.limits as {maxSlippageBps?:unknown}|undefined;
 const quoteAddress=p.quoteToken===0?p.token0:p.token1;
 if(quoteAddress.toLowerCase()!==USDG.toLowerCase())
  throw Error('paper_close_convert_usdg_route_unavailable');
 if(!limits||!Number.isSafeInteger(limits.maxSlippageBps)||Number(limits.maxSlippageBps)<=0||
  Number(limits.maxSlippageBps)>500)throw Error('paper_close_convert_limits_unavailable');
 const inputAsset=p.quoteToken===0?'token1':'token0',
  path=inputAsset==='token0'?[p.token0,p.token1]:[p.token1,p.token0],
  {router,quoter,fee,slippageBps,pathVersion}= {
   router:p.router,quoter:p.quoter,fee:p.fee,slippageBps:Number(limits.maxSlippageBps),
   pathVersion:PAPER_STATIC_CONVERT_GAS_PATH};
 const body={router,quoter,path,fee,inputAsset,slippageBps,pathVersion};
 return paperCloseConvertRouteSchema.parse({...body,routeHash:contentHash(body)});
}

/** A source pinned Quoter read. It does not sign or send a transaction. */
export async function quotePaperCloseConvertAtSource(client:RobinhoodClient,
 routeInput:unknown,sourceInput:PaperOpenFrame['source'],inputAmountRaw:string):Promise<PaperCloseConvertQuote>{
 const route=paperCloseConvertRouteSchema.parse(routeInput),source=z.object({block:raw,hash,timestamp:z.number().int().nonnegative()})
  .strict().parse(sourceInput);
 if(!/^[1-9][0-9]*$/.test(inputAmountRaw))throw Error('paper_convert_quote_input_invalid');
 assert.equal(await client.getChainId(),4663,'Paper conversion quote chain changed');
 const block=BigInt(source.block),read=()=>client.getBlock({blockNumber:block});
 const before=await read();assert.equal(before.hash.toLowerCase(),source.hash.toLowerCase());
 assert.equal(Number(before.timestamp),source.timestamp);
 const result=await client.simulateContract({address:route.quoter as `0x${string}`,
  abi:paperQuoterAbi,functionName:'quoteExactInputSingle',blockNumber:block,
  args:[{tokenIn:route.path[0] as `0x${string}`,tokenOut:route.path[1] as `0x${string}`,
   amountIn:BigInt(inputAmountRaw),fee:route.fee,sqrtPriceLimitX96:0n}]});
 const after=await read();
 assert.equal(`${after.hash.toLowerCase()}:${Number(after.timestamp)}`,
  `${before.hash.toLowerCase()}:${Number(before.timestamp)}`,'Paper conversion quote source changed');
 const expectedOutputRaw=String(result.result[0]),minimumOutputRaw=String(
  BigInt(expectedOutputRaw)*BigInt(10_000-route.slippageBps)/10_000n),
  body={schemaVersion:1 as const,kind:'paper_exact_input_quote_v1' as const,source,
   router:route.router,quoter:route.quoter,path:route.path,fee:route.fee,
   inputAsset:route.inputAsset,inputAmountRaw,expectedOutputRaw,minimumOutputRaw,
   slippageBps:route.slippageBps,pathVersion:route.pathVersion};
 if(BigInt(expectedOutputRaw)<=0n||BigInt(minimumOutputRaw)<=0n)
  throw Error('paper_convert_quote_output_unavailable');
 return paperCloseConvertQuoteSchema.parse({...body,quoteHash:contentHash(body)});
}

/**
 * Saves an inert terminal preview only after a trusted owned-fork verifier
 * confirms the withdraw/collect and Quoter replay at the exact canonical frame.
 * The V2 profile set and quote are bound with the preview in one recordPreview
 * transaction. HTTP acceptance remains disabled until worker replay consumes
 * this V2 envelope.
 */
export async function persistTrustedStaticPaperCloseConvertPreview(input:{store:PaperCloseConvertPreviewWriter;
 state:PaperCloseConvertPreflightState;frame:PaperOpenFrame;previousFeeCarry:PaperFeeCarry;
 feeReplay:EphemeralStaticPaperCloseConvertFeeReplay;
 feeEvidence:PaperCloseConvertFeeEvidenceBinding;postWithdraw:unknown;client:RobinhoodClient;
 verifyPersistedContext:(input:{state:PaperCloseConvertPreflightState;previousFeeCarry:PaperFeeCarry;
  feeCarry:PaperFeeCarry;
  feeReplay:EphemeralStaticPaperCloseConvertFeeReplay;feeEvidence:PaperCloseConvertFeeEvidenceBinding;
  source:PaperOpenFrame['source']})=>Promise<void>;
 verifyAnchors:(chainId:number,sources:readonly PaperCanonicalAnchor[])=>Promise<void>;
 verifyOwnedFork:(input:{state:PaperCloseConvertPreflightState;frame:PaperOpenFrame;
  route:PaperCloseConvertRoute;inventory:PaperStaticCloseConvertTerminalModel['inventory'];
  postWithdraw:PaperCloseConvertPostWithdrawEvidence;quote:PaperCloseConvertQuote})=>Promise<{
   reportHash:string;postWithdrawReplayHash:string;sourceReplayHash:string;source:PaperOpenFrame['source']}>;
 gasProfiles:readonly PaperGasProfileRow[];gasPriceWei:bigint;now?:number}){
 const now=input.now??Date.now(),state=input.state,open=state.openModel,p=state.profile.pool,
  frame=input.frame,feeReplay=input.feeReplay,feeCarry=feeReplay.feeCarry,
  post=postWithdrawSchema.parse(input.postWithdraw);
 if(open.strategyId!=='static_manual_v1'||
  open.profileHash!==state.profileHash||contentHash(state.profile)!==state.profileHash||
  open.revision<1||
  BigInt(frame.source.block)<=BigInt(state.previous.sourceBlock)||
  frame.source.timestamp<state.previous.source.timestamp||now<frame.source.timestamp*1000||
  now-frame.source.timestamp*1000>180_000||!frame.referenceEligible||!frame.referenceProof||
  referenceProofHash(frame.referenceProof)!==frame.referenceProofHash||
  !frame.price0||!frame.price1||!frame.nativePrice||frame.price0<=0n||frame.price1<=0n||
  frame.nativePrice<=0n||frame.sqrtPriceX96<=0n||frame.poolLiquidity<=0n)
  throw Error('paper_close_convert_terminal_context_unavailable');
 if(!/^[1-9][0-9]*$/.test(input.feeEvidence.id)||
  !/^[0-9a-f]{64}$/.test(input.feeEvidence.proofHash)||
  !/^[0-9a-f]{64}$/.test(input.feeEvidence.carryHash))
  throw Error('paper_close_convert_fee_evidence_unavailable');
 const previousFeeCarry=input.previousFeeCarry;
 if(previousFeeCarry.pool.toLowerCase()!==p.pool.toLowerCase()||
  previousFeeCarry.token0Address.toLowerCase()!==p.token0.toLowerCase()||
  previousFeeCarry.token1Address.toLowerCase()!==p.token1.toLowerCase()||
  previousFeeCarry.through.block!==state.previous.sourceBlock||
  previousFeeCarry.through.hash.toLowerCase()!==state.previous.sourceHash.toLowerCase()||
  previousFeeCarry.from.block!==open.source.block||previousFeeCarry.from.hash.toLowerCase()!==open.source.hash.toLowerCase()||
  previousFeeCarry.fee!==p.fee||previousFeeCarry.tickSpacing!==p.tickSpacing||
  previousFeeCarry.liquidity!==open.candidate.liquidity||
  previousFeeCarry.range.tickLower!==open.candidate.range.tickLower||
  previousFeeCarry.range.tickUpper!==open.candidate.range.tickUpper||
  previousFeeCarry.intervals<1||previousFeeCarry.accounting!=='modeled_hypothetical_fee_share'||
  feeCarry.through.block!==frame.source.block||feeCarry.through.hash.toLowerCase()!==frame.source.hash.toLowerCase()||
  feeCarry.from.block!==open.source.block||feeCarry.from.hash.toLowerCase()!==open.source.hash.toLowerCase()||
  feeCarry.intervals!==previousFeeCarry.intervals+1||
  feeCarry.pool.toLowerCase()!==p.pool.toLowerCase()||feeCarry.liquidity!==open.candidate.liquidity)
  throw Error('paper_close_convert_fee_carry_unavailable');
 verifyEphemeralStaticPaperCloseConvertFeeReplay({replay:feeReplay,previous:input.previousFeeCarry,
  sampleSource:frame.source,previousFeeEvidenceId:input.feeEvidence.id,
  previousFeeCarryHash:input.feeEvidence.carryHash,stream:feeCarry.stream,
  targetSetHash:feeCarry.targetSetHash,opening:open.source});
 if(feeReplay.from.block!==state.previous.sourceBlock||
  feeReplay.from.hash.toLowerCase()!==state.previous.sourceHash.toLowerCase()||
  feeReplay.to.block!==frame.source.block||feeReplay.to.hash.toLowerCase()!==frame.source.hash.toLowerCase())
  throw Error('paper_close_convert_fee_replay_source_mismatch');
 await input.verifyPersistedContext({state,previousFeeCarry:input.previousFeeCarry,feeCarry,feeReplay,
  feeEvidence:input.feeEvidence,source:frame.source});
 await input.verifyAnchors(state.profile.pool.chainId,[open.source,state.previous.source,frame.source]);
 const route=exactRoute(state),quoteAsset=p.quoteToken===0?'token0':'token1',
  inputAsset: 'token0'|'token1'=quoteAsset==='token0'?'token1':'token0';
 const poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*frame.price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0)),
  deviation=poolPrice1>frame.price1?poolPrice1-frame.price1:frame.price1-poolPrice1;
 if(deviation*1_000_000n>frame.price1*BigInt(state.profile.referencePolicy.maxPoolDeviationPpm))
  throw Error('paper_close_convert_independent_price_band');
 if(route.inputAsset!==inputAsset||route.path[1]?.toLowerCase()!==
  (quoteAsset==='token0'?p.token0:p.token1).toLowerCase())
  throw Error('paper_close_convert_usdg_route_unavailable');
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:frame.sqrtPriceX96}),
  idle0=BigInt(open.candidate.idle0),idle1=BigInt(open.candidate.idle1),
  fee0=BigInt(feeCarry.token0.lowerAmountRaw),fee1=BigInt(feeCarry.token1.lowerAmountRaw),
  inventory={principal0Raw:String(principal.amount0),principal1Raw:String(principal.amount1),
   idle0Raw:String(idle0),idle1Raw:String(idle1),fee0Raw:String(fee0),fee1Raw:String(fee1),
   token0Raw:String(principal.amount0+idle0+fee0),token1Raw:String(principal.amount1+idle1+fee1),
   inputAsset,inputAmountRaw:String(inputAsset==='token0'?principal.amount0+idle0+fee0:
    principal.amount1+idle1+fee1)};
 if(BigInt(inventory.inputAmountRaw)<=0n||post.source.block!==frame.source.block||
  post.source.hash.toLowerCase()!==frame.source.hash.toLowerCase()||
  post.source.timestamp!==frame.source.timestamp||post.position.liquidity!=='0'||
  post.position.tokensOwed0!=='0'||post.position.tokensOwed1!=='0'||
  post.balances.token0!==inventory.token0Raw||post.balances.token1!==inventory.token1Raw)
  throw Error('paper_close_convert_post_withdraw_inventory_mismatch');
 const quote=paperCloseConvertQuoteSchema.parse(await quotePaperCloseConvertAtSource(
  input.client,route,frame.source,inventory.inputAmountRaw));
 if(quote.source.hash.toLowerCase()!==post.source.hash.toLowerCase()||
  quote.inputAmountRaw!==inventory.inputAmountRaw||quote.inputAsset!==inputAsset||
  quote.expectedOutputRaw!==post.quotedOutputRaw||quote.quoteHash.length!==64||
  quote.expectedOutputRaw!==postWithdrawSchema.parse(input.postWithdraw).quotedOutputRaw)
  throw Error('paper_close_convert_quote_replay_mismatch');
 const ownedReplay=await input.verifyOwnedFork({state,frame,route,inventory,postWithdraw:post,quote});
 if(ownedReplay.reportHash!==post.reportHash||
  ownedReplay.postWithdrawReplayHash!==post.postWithdrawReplayHash||
  contentHash(ownedReplay.source)!==contentHash(frame.source)||
  !/^[0-9a-f]{64}$/.test(ownedReplay.sourceReplayHash))
  throw Error('paper_close_convert_owned_fork_attestation_mismatch');
 const residual0=BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted),
  residual1=BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted);
 if(residual0<0n||residual1<0n)throw Error('paper_close_convert_initial_allowance_invalid');
 const scope=paperCloseConvertGasScopeV2Schema.parse({poolAddress:p.pool,profileHash:state.profileHash,
  openModelHash:contentHash(open),candidate:{deployedValue:open.candidate.deployedValue,
   sharePpm:open.candidate.dilutedSharePpm,tickLower:open.candidate.range.tickLower,
   tickUpper:open.candidate.range.tickUpper,liquidity:open.candidate.liquidity},
  routeHash:route.routeHash,inputAsset,inputAmountRaw:inventory.inputAmountRaw,
  inventory:{token0Raw:inventory.token0Raw,token1Raw:inventory.token1Raw},
  initialAllowances:{manager0:String(residual0),manager1:String(residual1),router0:'0',router1:'0'}});
 const costs=costPaperCloseConvertGasV2(input.gasProfiles,scope,frame.nativePrice,
  input.gasPriceWei,now,new Date(now).toISOString());
 const body={schemaVersion:1 as const,kind:'paper_static_manual_close_convert_terminal_v2' as const,
  campaignId:open.campaignId,revision:open.revision,openMarkId:state.openMarkId,
  previousMarkId:state.previous.markId,openModelHash:contentHash(open),source:frame.source,
  poolState:post.poolState,reference:{price0:String(frame.price0),price1:String(frame.price1),
   nativePrice:String(frame.nativePrice)},referenceProof:frame.referenceProof,
  referenceProofHash:frame.referenceProofHash,inventory,conversionRoute:route,quote,
  feeReplay,postWithdraw:post,scope,costs};
 const parsed=terminalBodySchema.parse(body),model=terminalSchema.parse({...parsed,
  modelHash:contentHash(terminalHashBody(parsed))});
 const expiresAt=new Date(now+60_000),modelHash=model.modelHash;
 const saved=await input.store.recordPreview({campaignId:open.campaignId,
  expectedRevision:open.revision,kind:'close_convert',request:{kind:'close_convert',
   strategyId:'static_manual_v1',profileHash:state.profileHash,openMarkId:state.openMarkId,
   previousMarkId:state.previous.markId,modelHash,scopeHash:paperCloseConvertGasScopeHashV2(scope)},
  proposal:{paperCloseConvertTerminalV2:model},evidence:{
   verificationClass:'canonical_static_paper_close_convert_terminal_v2',
   classification:'paper_model_provisional',profileHash:state.profileHash,modelHash,
   openModelHash:model.openModelHash,referenceProofHash:model.referenceProofHash,
   source:model.source,costEvidenceClass:'fork_estimated',
   costProfileIds:costs.stages.map(stage=>stage.profileId),
   costScopeHash:costs.scopeHash,postWithdrawReplayHash:post.postWithdrawReplayHash,
   sourceReplayHash:ownedReplay.sourceReplayHash,
   feeEvidenceId:input.feeEvidence.id,feeEvidenceHash:input.feeEvidence.proofHash,
   feeCarryHash:feeReplay.feeCarryHash,priorFeeCarryHash:feeReplay.previousFeeCarryHash,
   feeIntervalHash:feeReplay.intervalHash,feeReplayHash:feeReplay.replayHash,
   feeStream:feeReplay.stream,feeTargetSetHash:feeReplay.targetSetHash,
   paidCostsAvailable:false,feeAccrualAvailable:false,
   quoteHash:quote.quoteHash},expiresAt});
 return {id:saved.id,kind:'close_convert' as const,status:'indicative' as const,
  expectedRevision:open.revision,contentDigest:saved.contentDigest,
  expiresAt:expiresAt.toISOString(),source:model.source,modelHash,
  inventory:model.inventory,conversionRoute:model.conversionRoute,
  quote:{expectedOutputRaw:quote.expectedOutputRaw,minimumOutputRaw:quote.minimumOutputRaw,
   inputAmountRaw:quote.inputAmountRaw,quoteHash:quote.quoteHash},
  costs:{status:'provisional' as const,scope:'convert_close_gas_only' as const,
   pathVersion:costs.pathVersion,scopeHash:costs.scopeHash,sequenceHash:costs.sequenceHash,
   sizeBand:costs.sizeBand,profileIds:costs.stages.map(stage=>stage.profileId),
   expectedValue:costs.expectedValue,boundValue:costs.boundValue,
   gasPriceObservedAt:costs.gasPriceObservedAt},economics:null,
  trustedPreviewSaved:true,actionAvailable:false,operationAcceptanceAvailable:false,
  paidCostsAvailable:false,feeAccrualAvailable:false,
  limitations:['owned_fork_withdraw_is_not_a_paper_fill','gas_is_fork_estimated_not_paid',
   'fee_carry_is_modeled_hypothetical_not_earned','execution_delay_failure_and_final_custody_unmodeled',
   'v2_worker_acceptance_replay_is_not_enabled']};
}

export type PaperCloseConvertPreflight=Awaited<ReturnType<typeof persistTrustedStaticPaperCloseConvertPreview>>;
