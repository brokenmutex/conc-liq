import {z} from 'zod';
import {getAddress,type Address} from 'viem';
import {rangeKeeperLimitsSchema} from './contracts.js';
import {contentHash} from './contracts.js';
import {marketProfileSchema,referenceProofHash,type MarketProfile} from './market-profile.js';
import type {PaperOpenFrame} from './paper-preview.js';
import type {PaperSetupProfile} from './paper-setup-preflight.js';
import {planRangeKeeper,rangeKeeperRange,rawValue} from '../strategy/rangekeeper/planner.js';
import {parseRangeKeeperConfig,rangeKeeperConfigHash,type RangeKeeperConfig} from '../strategy/rangekeeper/config.js';
import type {RangeKeeperCandidate,RangeKeeperLimits} from '../strategy/rangekeeper/domain.js';
import {allocateRangeKeeperFunding} from '../strategy/rangekeeper/funding.js';
import type {LiveWalletAllocationSnapshot} from './live-wallet-allocation.js';
import type {LiveWalletReview} from './live-wallet-reader.js';
import {liveSetupEvidenceHash,type LiveSetupSimulationRequest} from './rangekeeper-live-setup-simulation.js';
import {rangeKeeperPinnedSemanticIdentity} from './rangekeeper-live-review-runtime.js';

const MAX_CAPITAL_QUOTE=100_000n*10n**6n;
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/).max(12)
 .refine(v=>BigInt(v)>0n&&BigInt(v)<=MAX_CAPITAL_QUOTE);
/** How long a live campaign may run and how many economic actions (open, each recenter) it may take.
 * Bounds mirror the kernel config schema. 0 means open-ended (no expiry) and unlimited actions. */
export const rangeKeeperLiveCampaignScopeInput=z.object({maxDurationSeconds:z.number().int().min(0).max(86_400),
 maxEconomicActions:z.number().int().min(0).max(10)}).strict();
export type RangeKeeperLiveCampaignScope=z.infer<typeof rangeKeeperLiveCampaignScopeInput>;
/** Applied when a request omits the scope, so a client that predates the field keeps the bounded behavior
 * every live campaign had before the scope became an operator input. The operator dashboard always sends it. */
export const RANGEKEEPER_LIVE_LEGACY_CAMPAIGN_SCOPE:RangeKeeperLiveCampaignScope=
 Object.freeze({maxDurationSeconds:43_200,maxEconomicActions:2});
export const rangeKeeperLiveSetupPreflightInput=z.object({profileId:z.uuid(),capitalQuoteRaw:raw,
 fullWidthSpacings:z.number().int().min(2).max(2000).refine(v=>v%2===0),limits:rangeKeeperLimitsSchema,
 campaignScope:rangeKeeperLiveCampaignScopeInput.optional()}).strict();
export type RangeKeeperLiveSetupPreflightInput=z.input<typeof rangeKeeperLiveSetupPreflightInput>;

export type RangeKeeperLiveSetupWallet={id:string;address:Address;walletCode?:RangeKeeperConfig['walletCode']};
export type RangeKeeperLiveSetupQuote=(token:0|1,amountIn:bigint)=>Promise<{
 amountOut:bigint;priceAfter:bigint;feeValue:bigint;shortfallValue:bigint;
 sourceBlock:bigint;sourceHash:string}>;
export type RangeKeeperLiveSetupSnapshot=LiveWalletAllocationSnapshot&{source:PaperOpenFrame['source'];
 status:'available'|'unavailable';canonical:boolean;nonce:string|null;
 /** Existing wallet allowances reported by the review: zero required, or the in-policy persistent ones accepted. */
 allowancePolicy?:LiveWalletReview['allowancePolicy'];
 nftCustody:{status:'available'|'unavailable';enumerationComplete:boolean;tokenIds:readonly string[]|null}};

const ceil=(n:bigint,d:bigint)=>n===0n?0n:(n+d-1n)/d;
const quoteValue=(amount:bigint,price:bigint,decimals:number,quotePrice:bigint,quoteDecimals:number)=>
 ceil(amount*price*10n**BigInt(quoteDecimals),10n**BigInt(decimals)*quotePrice);
function allocateQuoteBudget(input:{free0:bigint;free1:bigint;price0:bigint;price1:bigint;
 decimals0:number;decimals1:number;quotePrice:bigint;quoteDecimals:number;budget:bigint}){
 const value=(a:bigint,b:bigint)=>quoteValue(a,input.price0,input.decimals0,input.quotePrice,input.quoteDecimals)+
  quoteValue(b,input.price1,input.decimals1,input.quotePrice,input.quoteDecimals);
 const total=value(input.free0,input.free1);
 if(total<=input.budget)return {amount0:input.free0,amount1:input.free1,value:total};
 let low=0n,high=10n**18n;
 while(low<high){const mid=(low+high+1n)/2n;
  if(value(input.free0*mid/10n**18n,input.free1*mid/10n**18n)<=input.budget)low=mid;
  else high=mid-1n;}
 const amount0=input.free0*low/10n**18n,amount1=input.free1*low/10n**18n;
 return {amount0,amount1,value:value(amount0,amount1)};
}
const serialCandidate=(c:RangeKeeperCandidate)=>({kind:c.kind,range:c.range,
 swap:c.swap?{token:c.swap.token,amountIn:String(c.swap.amountIn),quotedOut:String(c.swap.quotedOut),
  minOut:String(c.swap.minOut),priceAfter:String(c.swap.priceAfter),feeValue:String(c.swap.feeValue),
  shortfallValue:String(c.swap.shortfallValue)}:null,amount0Desired:String(c.amount0Desired),
 amount1Desired:String(c.amount1Desired),amount0Min:String(c.amount0Min),amount1Min:String(c.amount1Min),
 liquidity:String(c.liquidity),deployedValue:String(c.deployedValue),sourceBlock:String(c.sourceBlock),
 sourceHash:c.sourceHash,expiresAt:c.expiresAt});
function unavailable(input:RangeKeeperLiveSetupPreflightInput,reason:string){return {
 schemaVersion:1 as const,kind:'rangekeeper_live_setup_preflight' as const,mode:'live' as const,
 strategyId:'rangekeeper_v1' as const,status:'unavailable' as const,profileId:input.profileId,
 input:{capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits,
  campaignScope:input.campaignScope??RANGEKEEPER_LIVE_LEGACY_CAMPAIGN_SCOPE},
 profile:null,source:null,wallet:null,requirements:null,range:null,candidate:null,references:null,policy:null,costs:{status:'unavailable' as const},
 binding:null,missing:[reason],reason:'rangekeeper_live_execution_unavailable',actionAvailable:false,
 draftCreationAvailable:false,operationAcceptanceAvailable:false,executionEligible:false};}

/** Read-only live setup evidence. The wallet and profile are supplied by the
 * server adapter; request data contains only the paper-shaped setup fields. */
export async function buildRangeKeeperLiveSetupPreflight(input:RangeKeeperLiveSetupPreflightInput,deps:{
 buildId:string;
 serverWallet:()=>Promise<RangeKeeperLiveSetupWallet|null>;
 loadProfile:(id:string)=>Promise<PaperSetupProfile|null>;
 readFrame:(profile:MarketProfile,pinned?:PaperOpenFrame['source'])=>Promise<PaperOpenFrame>;
 readWalletSnapshot:(profile:MarketProfile,wallet:RangeKeeperLiveSetupWallet)=>Promise<RangeKeeperLiveSetupSnapshot>;
 readGasPrice:()=>Promise<{baseFeePerGasWei:bigint;marketGasPriceWei:bigint}>;
 verifyCanonical:(chainId:number,source:PaperOpenFrame['source'])=>Promise<void>;
 quote:RangeKeeperLiveSetupQuote;
 simulateCandidate:(request:LiveSetupSimulationRequest)=>Promise<{
  status:'success';source:PaperOpenFrame['source'];candidateHash:string;profileHash:string;allocationHash:string;
  limitsHash:string;sequenceHash:string;gasByStage:readonly {phase:'entry'|'exit';kind:string;gasUsed:string;estimatedGas?:string;
   gasUnitsBound:string}[];maxFeePerGasWei:string;actionGasWei:string;completeExitGasWei:string;
  estimatedCostValue:string;exitReserveWei:string;
  provenance:'owned_fork_allocated_lifecycle_v1';syntheticNativeFunding:true}>;
 now?:()=>number;
},pinnedSource?:PaperOpenFrame['source']){
 const now=deps.now??Date.now;
 let wallet:RangeKeeperLiveSetupWallet|null;
 try{wallet=await deps.serverWallet();}catch{return unavailable(input,'server_wallet_unavailable');}
 if(!wallet||!/^0x[0-9a-fA-F]{40}$/.test(wallet.address)||!wallet.id)return unavailable(input,'server_wallet_unavailable');
 let registered:PaperSetupProfile|null;
 try{registered=await deps.loadProfile(input.profileId);}catch{return unavailable(input,'registered_market_profile_unavailable');}
 if(!registered||registered.id!==input.profileId)return unavailable(input,'registered_market_profile_unavailable');
 const parsed=marketProfileSchema.safeParse(registered.profile);
 if(!parsed.success||contentHash(parsed.data)!==registered.profileHash)return unavailable(input,'registered_market_profile_integrity');
 const profile=parsed.data,p=profile.pool;
 let frame:PaperOpenFrame;
 try{frame=await deps.readFrame(profile,pinnedSource);}catch{return unavailable(input,'fresh_canonical_pool_frame_unavailable');}
 if(pinnedSource&&(frame.source.block!==pinnedSource.block||
  frame.source.hash.toLowerCase()!==pinnedSource.hash.toLowerCase()||frame.source.timestamp!==pinnedSource.timestamp))
  return unavailable(input,'reviewed_source_replay_mismatch');
 if(!/^(0|[1-9][0-9]*)$/.test(frame.source.block)||!/^0x[0-9a-fA-F]{64}$/.test(frame.source.hash)||
  !Number.isSafeInteger(frame.source.timestamp)||!Number.isSafeInteger(frame.tick)||frame.sqrtPriceX96<=0n||frame.poolLiquidity<0n)
  return unavailable(input,'canonical_pool_frame_malformed');
 const age=now()-frame.source.timestamp*1000;
 if(age<0||age>180_000)return unavailable(input,'fresh_source_stale');
 try{if(!frame.referenceEligible||!frame.referenceProof||frame.price0===null||frame.price1===null||frame.nativePrice===null||
  frame.price0<=0n||frame.price1<=0n||frame.nativePrice<=0n||referenceProofHash(frame.referenceProof)!==frame.referenceProofHash)
  return unavailable(input,'independent_reference_unavailable');}
 catch{return unavailable(input,'independent_reference_proof_invalid');}
 const price0=frame.price0!,price1=frame.price1!,nativePrice=frame.nativePrice!;
 let poolPrice1:bigint;
 try{poolPrice1=((1n<<192n)*10n**BigInt(p.decimals1)*price0)/
  (frame.sqrtPriceX96*frame.sqrtPriceX96*10n**BigInt(p.decimals0));}
 catch{return unavailable(input,'pool_price_unavailable');}
 const deviation=poolPrice1>price1?poolPrice1-price1:price1-poolPrice1;
 if(deviation*1_000_000n>price1*BigInt(profile.referencePolicy.maxPoolDeviationPpm))
  return unavailable(input,'pool_independent_reference_deviation');
 let snapshot:RangeKeeperLiveSetupSnapshot;
 try{snapshot=await deps.readWalletSnapshot(profile,wallet);}catch{return unavailable(input,'live_wallet_snapshot_unavailable');}
 if(snapshot.status!=='available'||snapshot.blockers.length)return unavailable(input,snapshot.blockers[0]??'live_wallet_commitments_unavailable');
 if(!snapshot.canonical||snapshot.nonce===null||!/^(0|[1-9][0-9]*)$/.test(snapshot.nonce))
  return unavailable(input,'complete_live_wallet_custody_or_nonce_unavailable');
 if(snapshot.nftCustody.status!=='available'||!snapshot.nftCustody.enumerationComplete||!snapshot.nftCustody.tokenIds)
  return unavailable(input,'complete_nft_custody_unavailable');
 if(snapshot.nftCustody.tokenIds.some(id=>typeof id!=='string'||!/^[1-9][0-9]*$/.test(id))||
  new Set(snapshot.nftCustody.tokenIds).size!==snapshot.nftCustody.tokenIds.length)
  return unavailable(input,'complete_nft_custody_malformed');
 if(snapshot.source.block!==frame.source.block||snapshot.source.hash.toLowerCase()!==frame.source.hash.toLowerCase()||
  snapshot.source.timestamp!==frame.source.timestamp)
  return unavailable(input,'wallet_snapshot_source_mismatch');
 const token0=snapshot.tokens.find(t=>t.address.toLowerCase()===p.token0.toLowerCase());
 const token1=snapshot.tokens.find(t=>t.address.toLowerCase()===p.token1.toLowerCase());
 if(!token0||!token1||token0.decimals!==p.decimals0||token1.decimals!==p.decimals1||
  typeof token0.availableRaw!=='string'||typeof token1.availableRaw!=='string'||
  typeof snapshot.native.availableWei!=='string')
  return unavailable(input,'wallet_token_inventory_unavailable');
 let free0:bigint,free1:bigint,nativeFree:bigint;
 try{const amount=(value:string|null)=>{if(value===null||!/^(0|[1-9][0-9]*)$/.test(value))throw Error('invalid_inventory');return BigInt(value);};
  free0=amount(token0.availableRaw);free1=amount(token1.availableRaw);nativeFree=amount(snapshot.native.availableWei);
  if(amount(token0.balanceRaw)-amount(token0.allocatedRaw)-amount(token0.pendingRaw)!==free0||
   amount(token1.balanceRaw)-amount(token1.allocatedRaw)-amount(token1.pendingRaw)!==free1||
   amount(snapshot.native.balanceWei)-amount(snapshot.native.allocatedWei)-amount(snapshot.native.pendingWei)-
    amount(snapshot.native.exitReserveWei)!==nativeFree)throw Error('inconsistent_inventory');}
 catch{return unavailable(input,'live_wallet_inventory_malformed');}
 const quotePrice=p.quoteToken===0?price0:price1,quoteDecimals=p.quoteToken===0?p.decimals0:p.decimals1;
 const budget=BigInt(input.capitalQuoteRaw),budgetUsdX18=budget*quotePrice/10n**BigInt(quoteDecimals);
 const selected=allocateQuoteBudget({free0,free1,price0,price1,
  decimals0:p.decimals0,decimals1:p.decimals1,quotePrice,quoteDecimals,budget});
 const initial0=selected.amount0,initial1=selected.amount1;
 if(initial0===0n&&initial1===0n)return unavailable(input,'wallet_strategy_inventory_empty');
 const strategyValueUsdX18=rawValue(initial0,price0,p.decimals0)+rawValue(initial1,price1,p.decimals1);
 const budgetLimitValue=strategyValueUsdX18<budgetUsdX18?strategyValueUsdX18:budgetUsdX18;
 if(!/^[a-f0-9]{64}$/.test(deps.buildId))return unavailable(input,'rangekeeper_runtime_build_identity_unavailable');
 if(input.limits.expiryAt)return unavailable(input,'rangekeeper_expiry_management_not_supported_by_open_kernel');
 const {minDeploymentValue:_minimumValue,expiryAt:_expiryAt,...kernelLimits}=input.limits;
 const submittedLimits={...kernelLimits,fullWidthSpacings:input.fullWidthSpacings,
  maxDeploymentValue:(BigInt(input.limits.maxDeploymentValue)<budgetLimitValue?BigInt(input.limits.maxDeploymentValue):budgetLimitValue).toString(),
  maxSwapInputValue:(BigInt(input.limits.maxSwapInputValue)<budgetLimitValue?BigInt(input.limits.maxSwapInputValue):budgetLimitValue).toString()};
 // Frozen into the kernel config (and so its hash, the binding and the review hash) and into the campaign parameters.
 const campaignScope=input.campaignScope??RANGEKEEPER_LIVE_LEGACY_CAMPAIGN_SCOPE;
 const configInput={schemaVersion:1 as const,policyId:'rangekeeper_v1' as const,strategyVersion:'1.0.0' as const,
  broadcastEnabled:false,operator:getAddress(wallet.address),pool:p,limits:submittedLimits,
  signer:null,walletCode:wallet.walletCode??{kind:'eoa' as const},zeroAllowances:[],legacyRetiredTokenIds:[],
  campaignScope,referencePolicy:profile.referencePolicy,
  campaignValue:String(strategyValueUsdX18+rawValue(nativeFree,nativePrice,18)),
  strategyFundingValue:String(strategyValueUsdX18),nativeFundingValue:String(rawValue(nativeFree,nativePrice,18))};
 let config;
 try{config=parseRangeKeeperConfig(configInput);}
 catch{return unavailable(input,'rangekeeper_live_limits_or_policy_invalid');}
 const limits:RangeKeeperLimits=config.limits;
 const kernelFloor=limits.maxDeploymentValue*BigInt(limits.minDeploymentPpm)/1_000_000n;
 if(BigInt(input.limits.minDeploymentValue)>kernelFloor)
  return unavailable(input,'rangekeeper_min_deployment_value_not_enforced_by_kernel');
 const configHash=rangeKeeperConfigHash({...config,limits});
 let range:{tickLower:number;tickUpper:number};
 try{range=rangeKeeperRange(frame.tick,p.tickSpacing,input.fullWidthSpacings);}
 catch{return unavailable(input,'rangekeeper_range_unavailable_on_pool_grid');}
 const availableQuote=quoteValue(free0,price0,p.decimals0,quotePrice,quoteDecimals)+
  quoteValue(free1,price1,p.decimals1,quotePrice,quoteDecimals);
 const nativeReserved=BigInt(input.limits.exitReserveWei);
 if(availableQuote===0n)return unavailable(input,'wallet_strategy_inventory_empty');
 const state={schemaVersion:1 as const,policyId:'rangekeeper_v1' as const,strategyVersion:'1.0.0' as const,
  configHash,buildId:deps.buildId,lastEligible:null,exit:null,confirmation:null};
 const observation={block:BigInt(frame.source.block),hash:frame.source.hash as `0x${string}`,
  timestamp:frame.source.timestamp,tick:frame.tick,sqrtPriceX96:frame.sqrtPriceX96,continuity:'canonical' as const,
  wallet0:initial0,wallet1:initial1,released0:0n,released1:0n,nativeWei:nativeFree,
  requiredExitReserveWei:nativeReserved,price0,price1,nativePrice,
  position:null,pending:false,entryAllowed:true,safeExitRequired:false,executionReady:true,liquiditySharePpm:0,
  actionCost:limits.maxActionCost,actionGasWei:0n,reservedCost:0n,rollingSpentCost:0n,campaignSpentCost:0n,
  campaignStartValue:rawValue(initial0,price0,p.decimals0)+rawValue(initial1,price1,p.decimals1),
  highWaterValue:rawValue(initial0,price0,p.decimals0)+rawValue(initial1,price1,p.decimals1),recenters:0};
 let first;
 try{first=await planRangeKeeper({state,observation,limits,spacing:p.tickSpacing,decimals0:p.decimals0,
  decimals1:p.decimals1,quoteToken:p.quoteToken,maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,
  quote:async(token,amount)=>deps.quote(token,amount),simulate:async()=>true});}
 catch{return unavailable(input,'rangekeeper_candidate_construction_failed');}
 if(!first.candidate)return unavailable(input,`rangekeeper_candidate_unavailable:${first.reason}`);
 const candidate=first.candidate;
 const required0=initial0,required1=initial1,requiredQuote=selected.value;
 const share=candidate.liquidity*1_000_000n/(frame.poolLiquidity+candidate.liquidity);
 if(share>BigInt(limits.maxLiquiditySharePpm))return unavailable(input,'rangekeeper_liquidity_share_limit');
 let gas;
 try{gas=await deps.readGasPrice();}catch{return unavailable(input,'fresh_gas_price_unavailable');}
 if(gas.baseFeePerGasWei<=0n||gas.marketGasPriceWei<=0n)return unavailable(input,'fresh_gas_price_unavailable');
 const preliminaryAllocation={token0Raw:String(required0),token1Raw:String(required1),nativeWei:String(nativeFree)};
 let fork:Awaited<ReturnType<typeof deps.simulateCandidate>>;
 try{fork=await deps.simulateCandidate({profile,source:frame.source,operator:getAddress(wallet.address),candidate,
  allocation:preliminaryAllocation,limits,prices:{price0,price1,nativePrice},
  baseFeePerGasWei:gas.baseFeePerGasWei,marketGasPriceWei:gas.marketGasPriceWei});}
 catch{return unavailable(input,'owned_fork_feasibility_unavailable');}
 const simulationAllocationHash=contentHash(preliminaryAllocation),limitsHash=liveSetupEvidenceHash(limits);
 const candidateHash=liveSetupEvidenceHash(candidate);
 if(fork.status!=='success'||fork.candidateHash!==candidateHash||fork.profileHash!==registered.profileHash||
  fork.allocationHash!==simulationAllocationHash||fork.limitsHash!==limitsHash||fork.source.block!==frame.source.block||
  fork.source.hash.toLowerCase()!==frame.source.hash.toLowerCase()||fork.source.timestamp!==frame.source.timestamp||
  fork.provenance!=='owned_fork_allocated_lifecycle_v1'||
  fork.syntheticNativeFunding!==true||!/^[a-f0-9]{64}$/.test(fork.sequenceHash))
  return unavailable(input,'owned_fork_evidence_binding_mismatch');
 let actionGasWei:bigint,exitGasWei:bigint,exitReserveWei:bigint,actionCostValue:bigint;
 let maxFeePerGasWei:bigint;
 try{actionGasWei=BigInt(fork.actionGasWei);exitGasWei=BigInt(fork.completeExitGasWei);
  exitReserveWei=BigInt(fork.exitReserveWei);actionCostValue=BigInt(fork.estimatedCostValue);
  maxFeePerGasWei=BigInt(fork.maxFeePerGasWei);}
 catch{return unavailable(input,'owned_fork_cost_evidence_malformed');}
 const positiveEvidence=[actionGasWei,exitGasWei,exitReserveWei,actionCostValue,maxFeePerGasWei];
 if(positiveEvidence.some(value=>value<=0n)||exitReserveWei<exitGasWei||exitReserveWei<BigInt(limits.exitReserveWei))
  return unavailable(input,'owned_fork_cost_evidence_malformed');
 const expectedMaxFee=ceil((gas.baseFeePerGasWei>gas.marketGasPriceWei?gas.baseFeePerGasWei:gas.marketGasPriceWei)*5n,4n);
 if(maxFeePerGasWei!==expectedMaxFee)return unavailable(input,'owned_fork_cost_evidence_malformed');
 const paddedUnits=(phase:'entry'|'exit')=>fork.gasByStage.filter(stage=>stage.phase===phase).reduce((sum,stage)=>{
  if(!/^[1-9][0-9]*$/.test(stage.gasUsed)||!/^[1-9][0-9]*$/.test(stage.gasUnitsBound))throw Error('invalid_stage_gas');
  if(stage.estimatedGas!==undefined&&!/^[1-9][0-9]*$/.test(stage.estimatedGas))throw Error('invalid_stage_estimate');
  const gasUsed=BigInt(stage.gasUsed),estimate=BigInt(stage.estimatedGas??stage.gasUsed),bound=BigInt(stage.gasUnitsBound);
  if(bound!==ceil((estimate>gasUsed?estimate:gasUsed)*13n,10n))throw Error('invalid_stage_gas_bound');return sum+bound;},0n);
 let entryUnits:bigint,exitUnits:bigint;
 try{entryUnits=paddedUnits('entry');exitUnits=paddedUnits('exit');}
 catch{return unavailable(input,'owned_fork_stage_gas_evidence_malformed');}
 if(!fork.gasByStage.some(stage=>stage.phase==='entry'&&stage.kind==='mint')||
  !fork.gasByStage.some(stage=>stage.phase==='exit'&&stage.kind==='withdraw')||
  actionGasWei!==entryUnits*maxFeePerGasWei||exitGasWei!==exitUnits*maxFeePerGasWei||
  exitReserveWei!==(exitGasWei>BigInt(limits.exitReserveWei)?exitGasWei:BigInt(limits.exitReserveWei)))
  return unavailable(input,'owned_fork_stage_gas_evidence_malformed');
 const expectedActionCost=ceil(actionGasWei*nativePrice,10n**18n)+
  (candidate.swap?candidate.swap.feeValue+candidate.swap.shortfallValue:0n);
 if(actionCostValue!==expectedActionCost)return unavailable(input,'owned_fork_cost_evidence_malformed');
 // Reserve management gas inside this campaign before opening. Future stages
 // still require their own exact fork proof and the approved cost caps. A zero
 // count limit is unlimited; its initial finite allocation funds one management
 // bundle and never grants access to another campaign's native balance.
 const fundedManagementBundles=limits.maxRecenters===0?1n:BigInt(limits.maxRecenters);
 const managementGasReserveWei=(actionGasWei+exitGasWei)*fundedManagementBundles;
 const nativeAllocationWei=actionGasWei+managementGasReserveWei+exitReserveWei;
 if(nativeFree<nativeAllocationWei)return unavailable(input,'native_gas_allocation_shortfall');
 if(now()>candidate.expiresAt*1000)return unavailable(input,'owned_fork_candidate_confirmation_expired');
 const allocation={amount0:required0,amount1:required1,nativeWei:nativeAllocationWei};
 const finalAllocation={token0Raw:String(required0),token1Raw:String(required1),nativeWei:String(allocation.nativeWei)};
 const finalAllocationHash=contentHash(finalAllocation);
 const finalStrategyValue=rawValue(required0,price0,p.decimals0)+rawValue(required1,price1,p.decimals1);
 const finalConfig={...config,campaignValue:finalStrategyValue+rawValue(allocation.nativeWei,nativePrice,18),
  strategyFundingValue:finalStrategyValue,nativeFundingValue:rawValue(allocation.nativeWei,nativePrice,18),
  broadcastEnabled:false as const,signer:null};
 const finalLimits:RangeKeeperLimits=finalConfig.limits,finalConfigHash=rangeKeeperConfigHash(finalConfig);
 const policyConfig=JSON.parse(JSON.stringify(finalConfig,(_,value)=>typeof value==='bigint'?String(value):value)) as Record<string,unknown>;
 const parameters={fullWidthSpacings:input.fullWidthSpacings,limits:input.limits,campaignScope};
 const finalState={...state,configHash:finalConfigHash};
 const finalObservation={...observation,nativeWei:allocation.nativeWei,liquiditySharePpm:Number(share),
  actionCost:actionCostValue,actionGasWei,requiredExitReserveWei:exitReserveWei};
 let finalDecision;
 try{finalDecision=await planRangeKeeper({state:finalState,observation:finalObservation,limits:finalLimits,spacing:p.tickSpacing,
  decimals0:p.decimals0,decimals1:p.decimals1,quoteToken:p.quoteToken,
  maxPoolDeviationPpm:profile.referencePolicy.maxPoolDeviationPpm,quote:async(token,amount)=>deps.quote(token,amount),
  simulate:async()=>true});}
 catch{return unavailable(input,'rangekeeper_measured_cost_admission_failed');}
 if(!finalDecision.candidate)return unavailable(input,`rangekeeper_measured_cost_admission_failed:${finalDecision.reason}`);
 if(contentHash(serialCandidate(finalDecision.candidate))!==contentHash(serialCandidate(candidate)))
  return unavailable(input,'rangekeeper_candidate_changed_after_cost_admission');
 try{await deps.verifyCanonical(p.chainId,frame.source);}catch{return unavailable(input,'fresh_source_not_canonical');}
 if(now()-frame.source.timestamp*1000<0||now()-frame.source.timestamp*1000>180_000)
  return unavailable(input,'fresh_source_stale');
 let funding;
 try{funding=allocateRangeKeeperFunding(finalConfig,
  {wallet0:free0,wallet1:free1,nativeWei:nativeFree,price0,price1,nativePrice},allocation);}
 catch{return unavailable(input,'campaign_allocation_funding_infeasible');}
 const quoteResidual=budget-requiredQuote;
 const fundingShortfall=budget>availableQuote?budget-availableQuote:0n;
 const candidateOut=serialCandidate(candidate);
 const requirements={token0Raw:String(required0),token1Raw:String(required1),nativeWei:String(allocation.nativeWei),
  quoteValueRaw:String(requiredQuote),freeQuoteRaw:String(availableQuote),shortfallQuoteRaw:String(fundingShortfall),
  budgetResidualQuoteRaw:String(quoteResidual),strategyAllocationValueUsdX18:String(funding.bookedStrategyValue),
  freeToken0Raw:String(free0-required0),freeToken1Raw:String(free1-required1)};
 const costs={status:'estimated' as const,provenance:fork.provenance,feasibility:'owned_fork_success' as const,
  scope:'entry_action_only_exit_gas_reserve_only' as const,actionCostScope:'entry_action_only' as const,
  exitEconomics:'unavailable' as const,syntheticNativeFunding:fork.syntheticNativeFunding,
  actionGasWei:String(actionGasWei),actionCostValue:String(actionCostValue),
  managementGasReserveWei:String(managementGasReserveWei),fundedManagementBundles:String(fundedManagementBundles),
  completeExitGasWei:String(exitGasWei),exitReserveWei:String(exitReserveWei),source:frame.source,
  baseFeePerGasWei:String(gas.baseFeePerGasWei),marketGasPriceWei:String(gas.marketGasPriceWei),
  maxFeePerGasWei:String(maxFeePerGasWei),
  stages:fork.gasByStage.map(s=>({phase:s.phase,kind:s.kind,gasUsed:s.gasUsed,
   ...(s.estimatedGas===undefined?{}:{estimatedGas:s.estimatedGas}),gasUnitsBound:s.gasUnitsBound}))};
 const bindingBase={buildId:deps.buildId,walletId:wallet.id,walletAddress:wallet.address,
  profileHash:registered.profileHash,configHash:finalConfigHash.slice(2),source:frame.source,
  referenceProofHash:frame.referenceProofHash,commitmentsHash:snapshot.commitmentsHash,candidateHash,
  simulationAllocationHash,finalAllocationHash,requirementsHash:contentHash(requirements),limitsHash,
  costsHash:contentHash(costs),sequenceHash:fork.sequenceHash};
 const binding={...bindingBase,reviewHash:contentHash(bindingBase)};
 return {schemaVersion:1 as const,kind:'rangekeeper_live_setup_preflight' as const,mode:'live' as const,
  strategyId:'rangekeeper_v1' as const,status:'indicative' as const,profileId:registered.id,profileHash:registered.profileHash,
  input:{capitalQuoteRaw:input.capitalQuoteRaw,fullWidthSpacings:input.fullWidthSpacings,limits:input.limits,campaignScope},
  profile:{pool:p.pool,fee:p.fee,tickSpacing:p.tickSpacing,token0:p.token0,token1:p.token1,
   quoteToken:p.quoteToken,decimals0:p.decimals0,decimals1:p.decimals1},source:frame.source,
  wallet:{id:wallet.id,address:wallet.address,source:snapshot.source,nonce:snapshot.nonce,
   nftTokenIds:snapshot.nftCustody.tokenIds,
   token0:{balanceRaw:token0.balanceRaw,allocatedRaw:token0.allocatedRaw,pendingRaw:token0.pendingRaw,freeRaw:token0.availableRaw},
   token1:{balanceRaw:token1.balanceRaw,allocatedRaw:token1.allocatedRaw,pendingRaw:token1.pendingRaw,freeRaw:token1.availableRaw},
   native:{balanceWei:snapshot.native.balanceWei,allocatedWei:snapshot.native.allocatedWei,
    pendingWei:snapshot.native.pendingWei,exitReserveWei:snapshot.native.exitReserveWei,freeWei:snapshot.native.availableWei},
   commitmentsHash:snapshot.commitmentsHash,
   ...(snapshot.allowancePolicy?{allowancePolicy:snapshot.allowancePolicy}:{})},
  requirements,
  range:{tickLower:range.tickLower,tickUpper:range.tickUpper,centerTick:frame.tick,fullWidthSpacings:input.fullWidthSpacings},
  candidate:candidateOut,references:{price0:String(price0),price1:String(price1),nativePrice:String(nativePrice),
   proofHash:frame.referenceProofHash,semanticProofHash:rangeKeeperPinnedSemanticIdentity({
    profileHash:registered.profileHash,source:frame.source,
    references:{price0:String(price0),price1:String(price1),nativePrice:String(nativePrice)},
    referenceProof:frame.referenceProof})},
  policy:{config:policyConfig,configHash:finalConfigHash.slice(2),parameters,
   parametersHash:contentHash(parameters),broadcastEnabled:false,signer:null},
  costs,binding,missing:[],
  reason:'rangekeeper_live_execution_unavailable',actionAvailable:false,draftCreationAvailable:false,
  operationAcceptanceAvailable:false,executionEligible:false};
}
