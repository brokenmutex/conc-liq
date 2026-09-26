import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileEvidenceSchema,marketProfileSchema,referenceProofHash} from
 '../src/deployments/market-profile.js';
import {PAPER_CONVERSION_ACCOUNTING_POLICY_V3,paperConversionAccountingV3Schema} from
 '../src/deployments/paper-accounting.js';
import {PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1} from
 '../src/deployments/paper-close-convert-prestate-gas-profiles.js';
import {DeploymentConflict,DeploymentStore} from '../src/deployments/store.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY,USDG} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';

const campaignId='00000000-0000-4000-8000-000000000001';
const source={block:'120',hash:`0x${'1'.repeat(64)}`,timestamp:1020};
const prior={id:'2',block:'110',hash:`0x${'2'.repeat(64)}`};
const runtime={buildId:'a'.repeat(64),configHash:'b'.repeat(64),nodeVersion:'v22.0.0'};
const proof={fixture:'terminal-lineage'};
const codeHash=`0x${'3'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,
 pool:'0x8000000000000000000000000000000000000001',token0:'0x1000000000000000000000000000000000000001',
 token1:USDG,quoteToken:1,decimals0:18,decimals1:6,fee:3000,tickSpacing:60,
 positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,
 poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
 managerCodeHash:codeHash,quoterCodeHash:codeHash,reference0:'TOKEN/USD',reference1:'USDG/USD',
 nativeReference:'ETH/USD',numeraire:'USD'},referencePolicy:{
 token0:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
 token1:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
 nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10000}});
const profileEvidence=marketProfileEvidenceSchema.parse({verificationClass:
 'canonical_chain_and_independent_reference_v1',source:{block:'100',hash:`0x${'4'.repeat(64)}`,
 timestamp:1000},streamKey:'fixture-stream',indexerTargetSetHash:`0x${'5'.repeat(64)}`,
 contractHashes:{poolCodeHash:codeHash,token0CodeHash:codeHash,token1CodeHash:codeHash,
 managerCodeHash:codeHash,quoterCodeHash:codeHash},references:{price0:'100',price1:'100',nativePrice:'100',
 proofHash:referenceProofHash(proof)},referenceProof:proof});
const feeProof={kind:'paper_observed_flow_fee_interval_v1',pool:profile.pool.pool,
 token0Address:profile.pool.token0,token1Address:profile.pool.token1,fee:3000,tickSpacing:60,
 from:{block:prior.block,hash:prior.hash},to:{block:source.block,hash:source.hash},
 range:{tickLower:-60,tickUpper:60,fullWidthTicks:120,requestedLower:-60,requestedUpper:60,rounded:false},
 liquidity:'1000',
 token0:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 token1:{lowerRawQ128:'0',upperRawQ128:'0',lowerAmountRaw:'0',upperAmountRaw:'0'},
 events:0,segments:1,partialSegments:0,accounting:'modeled_hypothetical_fee_share',
 coverage:{stream:'fixture-stream',targetSetHash:profileEvidence.indexerTargetSetHash,
 completeThroughBlock:source.block,completeThroughHash:source.hash,chainAnchorRecheckRequired:false}};
const feeProofHash=contentHash(feeProof),carry='fixture-carry',feeCarryHash=contentHash(carry),
 previewId='00000000-0000-4000-8000-000000000002',markId='3',accountingId='4',feeId='5';
const gasProfileIds=Array.from({length:7},(_,i)=>
 `00000000-0000-4000-8000-${String(i+10).padStart(12,'0')}`);
const snapshot=paperConversionAccountingV3Schema.parse({policyVersion:PAPER_CONVERSION_ACCOUNTING_POLICY_V3,
 classification:'provisional_paper_scenario',campaignId,sourceMarkId:markId,markKind:'close_convert',source,
 reference:{price0:'100',price1:'100',nativePrice:'100'},profileHash:contentHash(profile),
 openModelHash:'c'.repeat(64),closeModelHash:'d'.repeat(64),runtimeIdentity:runtime,
 feeEvidence:{id:feeId,proofHash:feeProofHash,carryHash:feeCarryHash,upper0Raw:'0',upper1Raw:'0'},
 gasProfiles:gasProfileIds.map((id,i)=>({stage:`stage_${i}`,id,version:1,sourceHash:source.hash})),
 inventory:{token0Raw:'0',token1Raw:'1',nativeWei:'0',principal0Raw:'0',principal1Raw:'1',
 fee0Raw:'0',fee1Raw:'0',cumulativeGasWei:'1',hasLiquidity:false},
 economics:{initialCapitalQuote:'1',netNavQuote:'1',passiveQuote:'1',absolutePnlQuote:'0',alphaQuote:'0',
 cumulativeFeeValueQuote:'0',cumulativeGasExpenseQuote:'0',intervalFeeAccrualQuote:'0',markGasExpenseQuote:'0',
 cumulativeConversionCostQuote:'0',cumulativeSwapCostQuote:'0',modeledSwapExpectedProceedsQuote:'1',
 modeledSwapProceedsQuote:'1',modeledSwapCostQuote:'0'},
 conversion:{quoteHash:'e'.repeat(64),pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,
 source,fromAsset:'token0',toAsset:'token1',inputAmountRaw:'1',expectedOutputRaw:'1',minimumOutputRaw:'1',
 slippageBps:50,expectedProceedsQuote:'1',minimumProceedsQuote:'1',modeledSwapCostQuote:'0',
 expectedGasWei:'1',boundGasWei:'2',expectedGasCostQuote:'1',boundGasCostQuote:'2',
 gasEvidence:{kind:'candidate_prestate_gas_only',pathVersion:PAPER_STATIC_CONVERT_PRESTATE_GAS_PATH_V1,
 evidenceClass:'fork_estimated',paidGasAvailable:false,reportHash:'f'.repeat(64),scopeHash:'6'.repeat(64),
 sequenceHash:'7'.repeat(64),sizeBand:'fixture',profileIds:gasProfileIds}},
 flows:[],limitations:['fixed_observed_flow_counterfactual','lower_integer_allocation_point',
 'execution_delay_unmodeled','failure_expense_unmodeled','quote_to_execution_deviation_unmodeled',
 'prospective_prestate_gas_is_fork_estimated_not_paid','post_withdraw_inventory_is_simulated_not_custody',
 'final_custody_unobserved']});

function row(overrides:Record<string,unknown>={}){
 const provenance={classification:'paper_model_converted_close',operationId:'00000000-0000-4000-8000-000000000003',
  previewId,terminalModelHash:snapshot.closeModelHash,previousMarkId:prior.id,
  feeEvidenceId:feeId,feeIntervalHash:feeProofHash,feeCarryHash,
  source};
 return {accounting_id:accountingId,campaign_id:campaignId,source_mark_id:markId,snapshot,
  snapshot_hash:contentHash(snapshot),fee_evidence_id:feeId,mark_source_block:source.block,
  mark_source_hash:source.hash,mark_provenance:provenance,fee_id:feeId,fee_from_mark_id:prior.id,
  fee_to_mark_id:markId,fee_proof:feeProof,fee_proof_hash:feeProofHash,fee_carry:carry,
  fee_carry_hash:feeCarryHash,previous_source_block:prior.block,previous_source_hash:prior.hash,
  profile_evidence:profileEvidence,campaign_lifecycle:'closed',campaign_runtime:runtime,
  operation_status:'succeeded',operation_kind:'close_convert',operation_preview_id:previewId,
  ...overrides};
}

async function checkTerminal(input:Record<string,unknown>){
 const store=new DeploymentStore('postgresql://localhost/unused');
 (store as unknown as {readPool:{query:()=>Promise<{rows:unknown[]}>;end:()=>Promise<void>}}).readPool={
  query:async()=>({rows:[row(input)]}),end:async()=>{}};
 try{return await store.hasTrustedStaticPaperCloseConvertV3Terminal(campaignId);}
 finally{await store.close();}
}

test('trusted V3 terminal lineage requires campaign, source, interval, and runtime bindings',async()=>{
 assert.equal(paperConversionAccountingV3Schema.safeParse(snapshot).success,true);
 assert.equal(marketProfileEvidenceSchema.safeParse(profileEvidence).success,true);
 assert.equal(await checkTerminal({}),true);
 for(const mutated of [
  {snapshot:{...snapshot,campaignId:'00000000-0000-4000-8000-000000000099'}},
  {snapshot:{...snapshot,source:{...source,block:'121'}}},
  {campaign_runtime:{...runtime,buildId:'9'.repeat(64)}},
 ]){
  const saved=mutated.snapshot&&typeof mutated.snapshot==='object'?
   {...mutated,snapshot_hash:contentHash(mutated.snapshot)}:mutated;
  await assert.rejects(checkTerminal(saved),error=>error instanceof DeploymentConflict&&
   error.code==='paper_close_convert_v3_terminal_lineage_invalid');
 }
});
