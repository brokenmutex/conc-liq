import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeFunctionData,decodeFunctionResult,encodeFunctionData,keccak256} from 'viem';
import {z} from 'zod';
import {guardedCanaryPositionManagerAbi} from '../canary-plan/abi.js';
import {canaryExitAbi} from '../canary-plan/exit.js';
import {PAPER_ACCOUNT,PAPER_ROUTER,paperQuoterAbi,paperRouterAbi,paperTokenAbi} from '../paper/execution-abi.js';
import {principalAmounts} from '../backtest/principal.js';
import {allocationSchema,contentHash,staticParameters} from './contracts.js';
import {marketProfileSchema,referenceProofHash} from './market-profile.js';
import {paperGasModelSchema,PAPER_STATIC_GAS_PATH,PAPER_STATIC_GAS_STAGES} from './paper-cost.js';
import {paperOpenModelSchema} from './paper-open-model.js';
import {PAPER_STATIC_CONVERT_GAS_PATH_V2,PAPER_STATIC_CONVERT_GAS_STAGES_V2,
 paperCloseConvertGasScopeV2Schema,paperCloseConvertGasScopeHashV2,
 paperCloseConvertGasSizeBandV2,paperCloseConvertGasAllowanceStatesV2,
 paperCloseConvertGasStageModelV2Schema,
 paperCloseConvertQuoteSchema,paperCloseConvertRouteSchema} from './paper-close-convert-model.js';

const positive=z.string().regex(/^[1-9][0-9]*$/);
const nonnegative=z.string().regex(/^(0|[1-9][0-9]*)$/);
const estimateSchema=z.object({gas:positive,parentGas:nonnegative,baseFeeWei:positive,
 parentBaseFeeWei:nonnegative,totalFeeWei:nonnegative,parentFeeWei:nonnegative,
 executionFeeWei:nonnegative,
 basis:z.literal('node_estimateGas_with_paper_prestate_and_parent_component')}).strict();

/** Checks the self-contained owned-fork report before it can be retained or
 * imported. This proves internal consistency, not independent provider truth. */
export function verifyPaperGasEvidence(raw:unknown){
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'Paper gas report missing');
 const report=raw as Record<string,unknown>,{reportHash,...body}=report;
 assert(typeof reportHash==='string'&&reportHash===contentHash(body),'Paper gas report hash mismatch');
 assert.equal(report.schemaVersion,1);assert.equal(report.pathVersion,PAPER_STATIC_GAS_PATH);
 assert.equal(report.strategyId,'static_manual_v1');
 const profile=marketProfileSchema.parse(report.profile);
 assert.equal(report.profileHash,contentHash(profile));
 assert.equal(String(report.pool).toLowerCase(),profile.pool.pool.toLowerCase());
 const parameters=staticParameters.parse(report.parameters);
 allocationSchema.parse(report.allocation);
 const config={...(report.parameters as Record<string,unknown>),strategyId:report.strategyId,
  strategyVersion:report.strategyVersion,stateSchemaVersion:report.stateSchemaVersion};
 assert.equal(report.configHash,contentHash(config));
 const source=report.source as {block:string;hash:string;timestamp:number};
 assert(source&&/^\d+$/.test(source.block)&&/^0x[0-9a-fA-F]{64}$/.test(source.hash)&&
  Number.isSafeInteger(source.timestamp)&&source.timestamp>0);
 const reference=report.reference as {proofHash:string};
 assert.equal(referenceProofHash(report.referenceProof),reference.proofHash);
 const candidate=report.candidate as {range:{tickLower:number;tickUpper:number};
  deployedValue:string;dilutedSharePpm:string;amount0Desired:string;amount1Desired:string;
  amount0Minted:string;amount1Minted:string};
 assert(candidate&&reference&&candidate.range);
 assert.equal(report.candidateHash,contentHash({campaignId:report.campaignId,revision:report.revision,
  profileHash:report.profileHash,configHash:report.configHash,source:report.source,
  referenceProofHash:reference.proofHash,candidate}));
 const stages=report.stageProfiles;
 assert(Array.isArray(stages)&&stages.length===PAPER_STATIC_GAS_STAGES.length);
 for(let index=0;index<stages.length;index++){
  const item=stages[index] as Record<string,unknown>;
  assert.equal(item.stage,PAPER_STATIC_GAS_STAGES[index]);
  const model=paperGasModelSchema.parse(item.model),evidence=item.evidence as Record<string,unknown>;
  assert.equal(item.sourceHash,contentHash(model.source));
  assert.equal(model.source.block,source.block);
  assert.equal(model.source.hash.toLowerCase(),source.hash.toLowerCase());
  assert.equal(model.source.estimatedAt,report.sampledAt);
  assert.equal(model.tickLower,candidate.range.tickLower);
  assert.equal(model.tickUpper,candidate.range.tickUpper);
  assert.equal(model.sizeMinValue,candidate.deployedValue);
  assert.equal(model.sizeMaxValue,candidate.deployedValue);
  assert.equal(model.shareMinPpm,candidate.dilutedSharePpm);
  assert.equal(model.shareMaxPpm,candidate.dilutedSharePpm);
  assert.equal(model.source.callHash,keccak256(evidence.calldata as `0x${string}`));
  const stage=PAPER_STATIC_GAS_STAGES[index]!,to=String(evidence.to);
  const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
  if(stage==='approve_token0'||stage==='approve_token1'||stage==='cleanup_token0'||stage==='cleanup_token1'){
   const token=stage.endsWith('token0')?profile.pool.token0:profile.pool.token1;
   assert(same(to,token),'Token stage target changed');
   const call=decodeFunctionData({abi:paperTokenAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(call.functionName,'approve');
   assert(same(call.args[0],profile.pool.positionManager));
   const expected=stage.startsWith('cleanup')?0n:
    BigInt(stage.endsWith('token0')?candidate.amount0Desired:candidate.amount1Desired);
   assert.equal(call.args[1],expected);
  }else if(stage==='mint'){
   assert(same(to,profile.pool.positionManager));
   const call=decodeFunctionData({abi:guardedCanaryPositionManagerAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(call.functionName,'mint');
   const p=call.args[0];
   assert(same(p.token0,profile.pool.token0)&&same(p.token1,profile.pool.token1));
   assert.equal(p.fee,profile.pool.fee);assert.equal(p.tickLower,candidate.range.tickLower);
   assert.equal(p.tickUpper,candidate.range.tickUpper);assert(same(p.recipient,PAPER_ACCOUNT));
  assert.equal(p.amount0Desired,BigInt(candidate.amount0Desired));
  assert.equal(p.amount1Desired,BigInt(candidate.amount1Desired));
   assert(parameters.limits);
   const haircut=10_000n-BigInt(parameters.limits.maxSlippageBps);
   assert.equal(p.amount0Min,BigInt(candidate.amount0Minted)*haircut/10_000n);
   assert.equal(p.amount1Min,BigInt(candidate.amount1Minted)*haircut/10_000n);
   assert(p.deadline>BigInt(source.timestamp)&&p.deadline<=BigInt(source.timestamp+300));
  }else{
   assert(same(to,profile.pool.positionManager));
   const outer=decodeFunctionData({abi:canaryExitAbi,data:evidence.calldata as `0x${string}`});
   assert.equal(outer.functionName,'multicall');assert.equal(outer.args[0].length,2);
   const decrease=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][0]!});
   const collect=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][1]!});
   assert.equal(decrease.functionName,'decreaseLiquidity');assert.equal(collect.functionName,'collect');
   assert.equal(decrease.args[0].tokenId,BigInt(report.tokenId as string));
   assert.equal(decrease.args[0].liquidity,BigInt(report.liquidity as string));
   assert(decrease.args[0].deadline>BigInt(source.timestamp)&&
    decrease.args[0].deadline<=BigInt(source.timestamp+300));
   assert.equal(collect.args[0].tokenId,decrease.args[0].tokenId);
   assert(same(collect.args[0].recipient,PAPER_ACCOUNT));
   assert.equal(collect.args[0].amount0Max,(1n<<128n)-1n);
   assert.equal(collect.args[0].amount1Max,(1n<<128n)-1n);
  }
  assert(BigInt(model.gasUnitsExpected)>0n&&BigInt(model.gasUnitsBound)>=BigInt(model.gasUnitsExpected));
  const estimate=estimateSchema.parse(evidence.estimate);
  assert.equal(model.gasUnitsExpected,estimate.gas);
  assert(BigInt(estimate.parentGas)<=BigInt(estimate.gas));
  assert.equal(BigInt(estimate.totalFeeWei),BigInt(estimate.gas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.parentFeeWei),BigInt(estimate.parentGas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.executionFeeWei),BigInt(estimate.totalFeeWei)-BigInt(estimate.parentFeeWei));
  assert.equal(evidence.stateOverrideHash,createHash('sha256')
   .update(JSON.stringify(evidence.stateOverrides)).digest('hex'));
 }
 return report;
}

const rawText=z.string().regex(/^(0|[1-9][0-9]*)$/);
const evmHash=z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const anchoredBlock=z.object({block:rawText,hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),
 timestamp:z.number().int().nonnegative()}).strict();
const feeCarryToken=z.object({lowerRawQ128:rawText,upperRawQ128:rawText,
 lowerAmountRaw:rawText,upperAmountRaw:rawText}).strict();
const feeCarrySchema=z.object({kind:z.literal('paper_fee_carry_v1'),pool:z.string(),
 token0Address:z.string(),token1Address:z.string(),fee:z.number().int().positive(),
 tickSpacing:z.number().int().positive(),range:z.object({tickLower:z.number().int(),
 tickUpper:z.number().int()}).strict(),liquidity:rawText,stream:z.string().min(1),
 targetSetHash:z.string().min(1),from:z.object({block:rawText,
  hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict(),through:z.object({block:rawText,
  hash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict(),token0:feeCarryToken,
 token1:feeCarryToken,intervals:z.number().int().positive(),events:z.number().int().nonnegative(),
 segments:z.number().int().nonnegative(),partialSegments:z.number().int().nonnegative(),
 accounting:z.literal('modeled_hypothetical_fee_share')}).strict();
const allowanceState=z.object({manager0:rawText,manager1:rawText,router0:rawText,router1:rawText}).strict();
const tokenBalances=z.object({token0:rawText,token1:rawText}).strict();
const sealedRuntimeIdentitySchema=z.object({buildId:z.string().regex(/^[a-f0-9]{64}$/),
 configHash:z.string().regex(/^[a-f0-9]{64}$/),nodeVersion:z.string().min(1)}).strict();
const closeStageEvidence=z.object({stage:z.enum(PAPER_STATIC_CONVERT_GAS_STAGES_V2),
 allowanceState:z.string().min(1).max(160),sourceHash:z.string().regex(/^[0-9a-f]{64}$/),
 model:paperCloseConvertGasStageModelV2Schema,evidence:z.object({to:z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  calldata:z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/),returnData:z.string(),
  localHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),localGasUsed:rawText,
  localEffectiveGasPriceWei:rawText,estimate:estimateSchema,
  stateOverrideHash:z.string().regex(/^[0-9a-f]{64}$/),
  stateOverrides:z.record(z.string(),z.unknown()),
  balancesBefore:tokenBalances,balancesAfter:tokenBalances,
  allowancesBefore:allowanceState,allowancesAfter:allowanceState}).strict()}).strict();
const closeConvertGasReportSchema=z.object({schemaVersion:z.literal(2),
 kind:z.literal('paper_close_convert_gas_report_v2'),
 pathVersion:z.literal(PAPER_STATIC_CONVERT_GAS_PATH_V2),classification:z.literal('fork_estimated'),
 campaignId:z.uuid(),revision:z.number().int().positive(),terminalMarkId:rawText,previousMarkId:rawText,
 runtimeIdentity:sealedRuntimeIdentitySchema,
 profile:z.record(z.string(),z.unknown()),
 profileHash:z.string().regex(/^[0-9a-f]{64}$/),openModel:paperOpenModelSchema,
 openModelHash:z.string().regex(/^[0-9a-f]{64}$/),source:anchoredBlock,
 frame:z.object({tick:z.number().int(),sqrtPriceX96:rawText,poolLiquidity:rawText,
  referenceProof:z.record(z.string(),z.unknown()),referenceProofHash:z.string().regex(/^[0-9a-f]{64}$/),
  price0:rawText,price1:rawText,nativePrice:rawText}).strict(),
 route:paperCloseConvertRouteSchema,
 feeEvidence:z.object({id:rawText,proofHash:z.string().regex(/^[0-9a-f]{64}$/),
  carryHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),feeCarry:feeCarrySchema,
 inventory:z.object({principal0Raw:rawText,principal1Raw:rawText,idle0Raw:rawText,idle1Raw:rawText,
  fee0Raw:rawText,fee1Raw:rawText,preSwap0Raw:rawText,preSwap1Raw:rawText,
  inputAsset:z.enum(['token0','token1']),inputAmountRaw:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
 quote:paperCloseConvertQuoteSchema,scope:paperCloseConvertGasScopeV2Schema,
 scopeHash:z.string().regex(/^[0-9a-f]{64}$/),sequenceHash:z.string().regex(/^[0-9a-f]{64}$/),
 sizeBand:z.string().min(1),sampledAt:z.iso.datetime({offset:true}),
 restoredPosition:z.object({tokenId:rawText,liquidity:rawText}).strict(),
 postWithdrawReplay:z.object({poolState:z.object({tick:z.number().int(),sqrtPriceX96:rawText,
  liquidity:rawText}).strict(),balances:tokenBalances,withdrawCallHash:evmHash,
  quoterCallHash:evmHash,quotedOutputRaw:rawText,replayHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
 initialAllowances:allowanceState,finalBalances:tokenBalances,finalAllowances:allowanceState,
 stageProfiles:z.array(closeStageEvidence).length(PAPER_STATIC_CONVERT_GAS_STAGES_V2.length),
 readBudget:z.object({requests:z.number().int().nonnegative(),rejected:z.number().int().nonnegative(),
  methods:z.record(z.string(),z.number().int().nonnegative()),maxRequests:z.number().int().positive()}).strict(),
 limitations:z.tuple([z.literal('owned_fork_restore_is_not_a_paper_fill'),
  z.literal('gas_is_fork_estimated_not_paid'),z.literal('fee_carry_requires_registered_replay'),
  z.literal('execution_delay_and_failure_unmodeled'),
  z.literal('source_verifier_must_replay_post_withdraw_quote')]),
 reportHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict();

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export const paperCloseConvertGasAllowanceStateV2=(stage:string,state:z.infer<typeof allowanceState>)=>
 `close_convert_v2_${stage}_${contentHash(state).slice(0,24)}`;

/** Validates all V2 stage calls and their before/after allowance and token
 * state. Canonical quote, saved fee-carry identity and source trust are checked
 * separately by verifyPaperCloseConvertGasSource. */
export function verifyPaperCloseConvertGasEvidence(raw:unknown){
 const report=closeConvertGasReportSchema.parse(raw),{reportHash,...body}=report;
 assert.equal(reportHash,contentHash(body),'Paper close-convert gas report hash mismatch');
 const profile=marketProfileSchema.parse(report.profile),open=paperOpenModelSchema.parse(report.openModel),
  route=paperCloseConvertRouteSchema.parse(report.route),carry=feeCarrySchema.parse(report.feeCarry),
  quote=paperCloseConvertQuoteSchema.parse(report.quote),p=profile.pool;
 assert.equal(report.profileHash,contentHash(profile));
 assert(sealedRuntimeIdentitySchema.safeParse(report.runtimeIdentity).success,
  'Paper close-convert gas report has no sealed runtime identity');
 assert.equal(open.profileHash,report.profileHash);assert.equal(report.openModelHash,contentHash(open));
 assert.equal(open.campaignId,report.campaignId);assert.equal(open.revision,report.revision);
 assert.equal(report.profileHash,open.profileHash);
 assert.equal(referenceProofHash(report.frame.referenceProof),report.frame.referenceProofHash);
 assert(BigInt(report.frame.sqrtPriceX96)>0n&&BigInt(report.frame.poolLiquidity)>0n&&
  BigInt(report.frame.price0)>0n&&BigInt(report.frame.price1)>0n&&BigInt(report.frame.nativePrice)>0n,
  'Close-convert gas reference frame is not positive');
 assert.equal(report.source.block,report.quote.source.block);
 assert(same(report.source.hash,report.quote.source.hash)&&
  report.source.timestamp===report.quote.source.timestamp);
 const {routeHash,...routeBody}=route;
 assert.equal(routeHash,contentHash(routeBody),'Paper close-convert route hash mismatch');
 const quoteAsset=p.quoteToken===0?'token0':'token1',inputIndex=route.inputAsset==='token0'?0:1,
  expectedPath=route.inputAsset==='token0'?[p.token0,p.token1]:[p.token1,p.token0];
 assert.equal(report.pathVersion,PAPER_STATIC_CONVERT_GAS_PATH_V2);
 assert(same(route.router,p.router)&&same(route.quoter,p.quoter)&&route.fee===p.fee&&
  route.path.every((address,index)=>same(address,expectedPath[index]!))&&
  route.inputAsset!==quoteAsset,'Close-convert gas route is outside the configured risk-to-quote path');
 assert.equal(carry.kind,'paper_fee_carry_v1');
 assert.equal(report.feeEvidence.carryHash,contentHash(carry),
  'Terminal close fee carry hash mismatch');
 assert(same(carry.pool,p.pool)&&same(carry.token0Address,p.token0)&&same(carry.token1Address,p.token1)&&
  carry.fee===p.fee&&carry.tickSpacing===p.tickSpacing&&
  carry.liquidity===open.candidate.liquidity&&
  carry.range.tickLower===open.candidate.range.tickLower&&
  carry.range.tickUpper===open.candidate.range.tickUpper&&
  carry.from.block===open.source.block&&same(carry.from.hash,open.source.hash)&&
  carry.through.block===report.source.block&&same(carry.through.hash,report.source.hash),
  'Terminal fee carry does not match the open position or close source');
 for(const token of [carry.token0,carry.token1]){
  const lower=BigInt(token.lowerRawQ128),upper=BigInt(token.upperRawQ128);
  assert(lower>=0n&&upper>=lower&&token.lowerAmountRaw===String(lower/(1n<<128n))&&
   token.upperAmountRaw===String(upper/(1n<<128n)),'Terminal fee carry amount mismatch');
 }
 assert.equal(report.feeEvidence.id.length>0,true);
 const principal=principalAmounts({liquidity:BigInt(open.candidate.liquidity),
  tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
  sqrtPriceX96:BigInt(report.frame.sqrtPriceX96)}),
  idle0=BigInt(open.candidate.idle0),idle1=BigInt(open.candidate.idle1),
  fee0=BigInt(carry.token0.lowerAmountRaw),fee1=BigInt(carry.token1.lowerAmountRaw),
  pre0=principal.amount0+idle0+fee0,pre1=principal.amount1+idle1+fee1,
  input=route.inputAsset==='token0'?pre0:pre1;
 assert.equal(report.inventory.principal0Raw,String(principal.amount0));
 assert.equal(report.inventory.principal1Raw,String(principal.amount1));
 assert.equal(report.inventory.idle0Raw,String(idle0));assert.equal(report.inventory.idle1Raw,String(idle1));
 assert.equal(report.inventory.fee0Raw,String(fee0));assert.equal(report.inventory.fee1Raw,String(fee1));
 assert.equal(report.inventory.preSwap0Raw,String(pre0));assert.equal(report.inventory.preSwap1Raw,String(pre1));
 assert.equal(report.inventory.inputAsset,route.inputAsset);assert.equal(report.inventory.inputAmountRaw,String(input));
 assert(input>0n,'No non-quote close-convert inventory');
 const {quoteHash,...quoteBody}=quote;
 assert.equal(quoteHash,contentHash(quoteBody),'Close-convert quote hash mismatch');
 assert.equal(quote.pathVersion,route.pathVersion);assert.equal(quote.router.toLowerCase(),route.router.toLowerCase());
 assert.equal(quote.quoter.toLowerCase(),route.quoter.toLowerCase());assert.deepEqual(quote.path,route.path);
 assert.equal(quote.fee,route.fee);assert.equal(quote.inputAsset,route.inputAsset);
 assert.equal(quote.inputAmountRaw,String(input));assert.equal(quote.source.block,report.source.block);
 assert(same(quote.source.hash,report.source.hash)&&quote.source.timestamp===report.source.timestamp);
 assert.equal(quote.slippageBps,route.slippageBps);
 assert.equal(quote.minimumOutputRaw,String(BigInt(quote.expectedOutputRaw)*
  BigInt(10_000-route.slippageBps)/10_000n));
 assert(BigInt(quote.minimumOutputRaw)>0n);
 assert.equal(report.restoredPosition.liquidity,open.candidate.liquidity);
 const withdrawStage=report.stageProfiles[0]!;
 assert.equal(report.postWithdrawReplay.withdrawCallHash,withdrawStage.model.source.callHash);
 assert.deepEqual(report.postWithdrawReplay.balances,{token0:String(pre0),token1:String(pre1)});
 assert.equal(report.postWithdrawReplay.quotedOutputRaw,quote.expectedOutputRaw);
 const quoteCall=encodeFunctionData({abi:paperQuoterAbi,functionName:'quoteExactInputSingle',args:[{
  tokenIn:route.path[0] as `0x${string}`,tokenOut:route.path[1] as `0x${string}`,
  amountIn:input,fee:route.fee,sqrtPriceLimitX96:0n}]});
 assert.equal(report.postWithdrawReplay.quoterCallHash,keccak256(quoteCall));
 const {replayHash,...postWithdrawReplayBody}=report.postWithdrawReplay;
 assert.equal(replayHash,contentHash(postWithdrawReplayBody),
  'Post-withdraw owned-fork replay hash mismatch');
 const riskToken=route.path[0]!,riskIndex=inputIndex,
  managerAllow0=String(BigInt(open.candidate.amount0Desired)-BigInt(open.candidate.amount0Minted)),
  managerAllow1=String(BigInt(open.candidate.amount1Desired)-BigInt(open.candidate.amount1Minted));
 assert.equal(managerAllow0,String(idle0));assert.equal(managerAllow1,String(idle1));
 const initial=allowanceState.parse({manager0:managerAllow0,manager1:managerAllow1,router0:'0',router1:'0'});
 assert.deepEqual(report.initialAllowances,initial,'Initial close allowance state is not derived from open');
 const scope=paperCloseConvertGasScopeV2Schema.parse(report.scope),expectedScope={
  poolAddress:p.pool,profileHash:report.profileHash,openModelHash:report.openModelHash,
 candidate:{deployedValue:open.candidate.deployedValue,sharePpm:open.candidate.dilutedSharePpm,
   tickLower:open.candidate.range.tickLower,tickUpper:open.candidate.range.tickUpper,
   liquidity:open.candidate.liquidity},routeHash,inputAsset:route.inputAsset,inputAmountRaw:String(input),
  inventory:{token0Raw:String(pre0),token1Raw:String(pre1)},initialAllowances:initial};
 assert.deepEqual(scope,expectedScope,'Close-convert gas scope differs from sampled inventory');
 assert.equal(report.scopeHash,paperCloseConvertGasScopeHashV2(scope));
 assert.equal(report.sizeBand,paperCloseConvertGasSizeBandV2(scope));
 const expectedSequenceHash=contentHash(report.stageProfiles.map(stage=>({stage:stage.stage,
  allowanceState:stage.allowanceState,callHash:stage.model.source.callHash})));
 assert.equal(report.sequenceHash,expectedSequenceHash,'Close-convert stage sequence hash mismatch');
 const deterministicAllowanceStates=paperCloseConvertGasAllowanceStatesV2(scope);
 let expectedBefore: z.infer<typeof allowanceState>=initial;
 const balancesBeforeWithdraw={token0:String(idle0+fee0),token1:String(idle1+fee1)};
 const balancesAfterWithdraw={token0:String(pre0),token1:String(pre1)};
 let expectedBalances: z.infer<typeof tokenBalances>=balancesBeforeWithdraw;
 const bps=route.slippageBps,manager=p.positionManager,router=p.router;
 let commonSource:string|null=null;
 for(let index=0;index<report.stageProfiles.length;index++){
  const stage=report.stageProfiles[index]!,stageName=PAPER_STATIC_CONVERT_GAS_STAGES_V2[index]!;
  assert.equal(stage.stage,stageName,'Conversion gas report stage order changed');
  assert.equal(stage.allowanceState,deterministicAllowanceStates[stageName]);
  assert.equal(stage.allowanceState,paperCloseConvertGasAllowanceStateV2(stageName,stage.evidence.allowancesBefore),
   'Conversion gas profile allowance scope is not derived from stage prestate');
  assert.deepEqual(stage.evidence.allowancesBefore,expectedBefore,
   'Conversion gas allowance state is discontinuous');
  assert.deepEqual(stage.evidence.balancesBefore,expectedBalances,
   'Conversion gas token state is discontinuous');
  const model=paperCloseConvertGasStageModelV2Schema.parse(stage.model),evidence=stage.evidence;
  assert.equal(stage.sourceHash,contentHash(model.source));
  assert.equal(model.source.block,report.source.block);assert(same(model.source.hash,report.source.hash));
  assert.equal(model.source.estimatedAt,report.sampledAt);
  assert.equal(model.tickLower,open.candidate.range.tickLower);
  assert.equal(model.tickUpper,open.candidate.range.tickUpper);
  assert.equal(model.sizeMinValue,open.candidate.deployedValue);
  assert.equal(model.sizeMaxValue,open.candidate.deployedValue);
  assert.equal(model.shareMinPpm,open.candidate.dilutedSharePpm);
  assert.equal(model.shareMaxPpm,open.candidate.dilutedSharePpm);
  assert.equal(model.scopeHash,report.scopeHash);assert.equal(model.sequenceHash,report.sequenceHash);
  assert.equal(model.stageIndex,index);assert.equal(model.stageCount,PAPER_STATIC_CONVERT_GAS_STAGES_V2.length);
  const currentSource=`${model.source.block}:${model.source.hash.toLowerCase()}:${model.source.estimatedAt}`;
  if(commonSource===null)commonSource=currentSource;else assert.equal(currentSource,commonSource,
   'Close-convert stages do not share one sample source');
  assert.equal(model.source.callHash,keccak256(evidence.calldata as `0x${string}`));
  const to=evidence.to as `0x${string}`,calldata=evidence.calldata as `0x${string}`,
   before=stage.evidence.allowancesBefore,after=stage.evidence.allowancesAfter;
  let balancesAfter: z.infer<typeof tokenBalances>=expectedBalances;
  if(stageName==='withdraw_collect'){
   assert(same(to,manager));
   const outer=decodeFunctionData({abi:canaryExitAbi,data:calldata});
   assert.equal(outer.functionName,'multicall');assert.equal(outer.args[0].length,2);
   const decrease=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][0]!});
   const collect=decodeFunctionData({abi:canaryExitAbi,data:outer.args[0][1]!});
   assert.equal(decrease.functionName,'decreaseLiquidity');assert.equal(collect.functionName,'collect');
   assert.equal(decrease.args[0].tokenId,BigInt(report.restoredPosition.tokenId));
   assert.equal(decrease.args[0].liquidity,BigInt(open.candidate.liquidity));
   assert.equal(decrease.args[0].amount0Min,principal.amount0*BigInt(10_000-bps)/10_000n);
   assert.equal(decrease.args[0].amount1Min,principal.amount1*BigInt(10_000-bps)/10_000n);
   assert(decrease.args[0].deadline>BigInt(report.source.timestamp)&&
    decrease.args[0].deadline<=BigInt(report.source.timestamp+300));
   assert.equal(collect.args[0].tokenId,decrease.args[0].tokenId);
   assert(same(collect.args[0].recipient,PAPER_ACCOUNT));
   assert.equal(collect.args[0].amount0Max,(1n<<128n)-1n);
   assert.equal(collect.args[0].amount1Max,(1n<<128n)-1n);
   const results=decodeFunctionResult({abi:canaryExitAbi,functionName:'multicall',
    data:evidence.returnData as `0x${string}`});
   assert.equal(results.length,2);
   const decreased=decodeFunctionResult({abi:canaryExitAbi,functionName:'decreaseLiquidity',data:results[0]!}),
    collected=decodeFunctionResult({abi:canaryExitAbi,functionName:'collect',data:results[1]!});
   assert.equal(decreased[0],principal.amount0);assert.equal(decreased[1],principal.amount1);
   assert.equal(collected[0],principal.amount0+fee0);assert.equal(collected[1],principal.amount1+fee1);
   assert.deepEqual(after,before);balancesAfter=balancesAfterWithdraw;
  }else if(stageName==='approve_swap_input'){
   assert(same(to,riskToken));
   const call=decodeFunctionData({abi:paperTokenAbi,data:calldata});
   assert.equal(call.functionName,'approve');assert(same(call.args[0],router));
   assert.equal(call.args[1],input);
   assert.equal(decodeFunctionResult({abi:paperTokenAbi,functionName:'approve',
    data:evidence.returnData as `0x${string}`}),true);
   const key=riskIndex===0?'router0':'router1';
   const next={...before,[key]:String(input)};assert.deepEqual(after,next);expectedBefore=next;
  }else if(stageName==='swap'){
   assert(same(to,router));
   const outer=decodeFunctionData({abi:paperRouterAbi,data:calldata});
   assert.equal(outer.functionName,'multicall');assert.equal(outer.args[1].length,1);
   assert(outer.args[0]>BigInt(report.source.timestamp)&&outer.args[0]<=BigInt(report.source.timestamp+300));
   const inner=decodeFunctionData({abi:paperRouterAbi,data:outer.args[1][0]!});
   assert.equal(inner.functionName,'exactInputSingle');
   const params=inner.args[0];
   assert(same(params.tokenIn,route.path[0]!)&&same(params.tokenOut,route.path[1]!));
   assert.equal(params.fee,route.fee);assert(same(params.recipient,PAPER_ACCOUNT));
   assert.equal(params.amountIn,input);assert.equal(params.amountOutMinimum,BigInt(quote.minimumOutputRaw));
   assert.equal(params.sqrtPriceLimitX96,0n);
   const routerKey=riskIndex===0?'router0':'router1';
   const next={...before,[routerKey]:'0'};assert.deepEqual(after,next);expectedBefore=next;
   const calls=decodeFunctionResult({abi:paperRouterAbi,functionName:'multicall',data:evidence.returnData as `0x${string}`});
   assert.equal(calls.length,1);
   const actual=decodeFunctionResult({abi:paperRouterAbi,functionName:'exactInputSingle',data:calls[0]!});
   assert.equal(actual,BigInt(quote.expectedOutputRaw),'Fork swap output differs from pinned quote');
   const result0=riskIndex===0?'0':String(BigInt(expectedBalances.token0)+BigInt(quote.expectedOutputRaw));
   const result1=riskIndex===1?'0':String(BigInt(expectedBalances.token1)+BigInt(quote.expectedOutputRaw));
   balancesAfter={token0:result0,token1:result1};
  }else if(stageName==='cleanup_manager_token0'||stageName==='cleanup_manager_token1'){
   const tokenIndex=stageName.endsWith('token0')?0:1,token=tokenIndex===0?p.token0:p.token1,
    key=tokenIndex===0?'manager0':'manager1';
   assert(same(to,token));
   const call=decodeFunctionData({abi:paperTokenAbi,data:calldata});
   assert.equal(call.functionName,'approve');assert(same(call.args[0],manager));assert.equal(call.args[1],0n);
   assert.equal(decodeFunctionResult({abi:paperTokenAbi,functionName:'approve',
    data:evidence.returnData as `0x${string}`}),true);
   const next={...before,[key]:'0'};assert.deepEqual(after,next);expectedBefore=next;
  }else{
   const tokenIndex=stageName==='cleanup_router_token0'?0:1,
    token=tokenIndex===0?p.token0:p.token1,key=tokenIndex===0?'router0':'router1';
   assert(stageName==='cleanup_router_token0'||stageName==='cleanup_router_token1');
   assert(same(to,token));
   const call=decodeFunctionData({abi:paperTokenAbi,data:calldata});
   assert.equal(call.functionName,'approve');assert(same(call.args[0],router));assert.equal(call.args[1],0n);
   assert.equal(decodeFunctionResult({abi:paperTokenAbi,functionName:'approve',
    data:evidence.returnData as `0x${string}`}),true);
   const next={...before,[key]:'0'};
   assert.deepEqual(after,next);expectedBefore=next;
  }
  if(stageName==='withdraw_collect')expectedBefore=after;
  if(stageName==='cleanup_manager_token0'||stageName==='cleanup_manager_token1'||
   stageName==='cleanup_router_token0'||stageName==='cleanup_router_token1')balancesAfter=expectedBalances;
  expectedBalances=balancesAfter;
  assert(BigInt(model.gasUnitsExpected)>0n&&BigInt(model.gasUnitsBound)>=BigInt(model.gasUnitsExpected));
  const estimate=estimateSchema.parse(evidence.estimate);
  assert.equal(model.gasUnitsExpected,estimate.gas);
  assert(BigInt(estimate.parentGas)<=BigInt(estimate.gas));
  assert.equal(BigInt(estimate.totalFeeWei),BigInt(estimate.gas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.parentFeeWei),BigInt(estimate.parentGas)*BigInt(estimate.baseFeeWei));
  assert.equal(BigInt(estimate.executionFeeWei),BigInt(estimate.totalFeeWei)-BigInt(estimate.parentFeeWei));
  assert.equal(evidence.stateOverrideHash,createHash('sha256')
   .update(JSON.stringify(evidence.stateOverrides)).digest('hex'));
  assert.deepEqual(expectedBefore,after);
 }
 assert.deepEqual(report.finalBalances,expectedBalances);
 assert.deepEqual(report.finalAllowances,expectedBefore);
 assert.equal(BigInt(report.finalBalances[route.inputAsset==='token0'?'token0':'token1']),0n,
  'Converted risk-token residue remains');
 assert.equal(BigInt(report.finalAllowances.manager0),0n);
 assert.equal(BigInt(report.finalAllowances.manager1),0n);
 assert.equal(BigInt(report.finalAllowances.router0),0n);
 assert.equal(BigInt(report.finalAllowances.router1),0n);
 return report;
}
