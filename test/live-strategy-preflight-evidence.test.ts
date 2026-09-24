import assert from 'node:assert/strict';
import test from 'node:test';
import {contentHash} from '../src/deployments/contracts.js';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {composeLiveStrategyPreflightEvidence} from '../src/deployments/live-strategy-preflight-evidence.js';

const operator='0x1111111111111111111111111111111111111111';
const token0='0x2222222222222222222222222222222222222222';
const token1='0x3333333333333333333333333333333333333333';
const manager='0x4444444444444444444444444444444444444444';
const router='0x5555555555555555555555555555555555555555';
const hash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:'0x6666666666666666666666666666666666666666',
 pool:'0x7777777777777777777777777777777777777777',token0,token1,quoteToken:0,decimals0:18,decimals1:18,
 fee:3000,tickSpacing:60,positionManager:manager,router,quoter:'0x8888888888888888888888888888888888888888',
 poolCodeHash:hash,token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:'TOKEN0/USD',reference1:'TOKEN1/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:300,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:300,maxPoolDeviationPpm:50_000}});
const staticConfig={halfWidthTicks:60,limits:{maxDeploymentValue:'100000000000000000000',
 minDeploymentValue:'1000000000000000000',maxExposurePpm:1_000_000,maxLossValue:'10000000000000000000',
 maxDrawdownPpm:500_000,maxActionCost:'5000000000000000000',maxRollingCost:'8000000000000000000',
 maxCampaignCost:'10000000000000000000',exitReserveWei:'1000000000000000',maxSlippageBps:50}};
const rkConfig={fullWidthSpacings:20,limits:{maxDeploymentValue:'100000000000000000000',minDeploymentValue:'1000000000000000000',
 maxExposurePpm:1_000_000,maxLossValue:'10000000000000000000',maxDrawdownPpm:500_000,
 maxActionCost:'5000000000000000000',maxRollingCost:'8000000000000000000',maxCampaignCost:'10000000000000000000',
 exitReserveWei:'1000000000000000',maxSlippageBps:50,minDeploymentPpm:500_000,maxSwapInputValue:'50000000000000000000',
 maxSwapInputPpm:1_000_000,maxSwapShortfallValue:'1000000000000000000',maxRecenters:2,maxLiquiditySharePpm:20_000,
 maxObservationGapSeconds:60}};
const saved=(strategyId:'static_manual_v1'|'rangekeeper_v1'='static_manual_v1',overrides:Record<string,unknown>={})=>{
 const config=strategyId==='static_manual_v1'?staticConfig:rkConfig;
 return {id:'campaign-1',revision:1,mode:'live',strategyId,wallet:operator,chainId:4663,profile,
  profileHash:contentHash(profile),config,configHash:contentHash({...config,strategyId,strategyVersion:'1.0.0',stateSchemaVersion:1}),
  allocation:{token0Raw:'10',token1Raw:'20',nativeWei:'30'},...overrides};
};
const snapshot=(strategyId:'static_manual_v1'|'rangekeeper_v1'='static_manual_v1',overrides:Record<string,unknown>={})=>({
 kind:'live_custody_snapshot',status:'snapshot_partial',targetStrategyId:strategyId,operator,positionManager:manager,
 chainId:{status:'available',value:4663},source:{block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:1_790_000_000,confirmed:true},
 nonce:{status:'available',value:'7'},nativeBalanceWei:{status:'available',value:'100'},
 tokenBalances:[{token:token0,symbol:'A',raw:{status:'available',value:'100'}},
  {token:token1,symbol:'B',raw:{status:'available',value:'200'}}],
 allowances:[token0,token1].flatMap(token=>[router,manager].map(spender=>({token,spender,label:spender===router?'router':'manager',
  raw:{status:'available',value:'0'}}))),nftCount:{status:'available',value:'0'},knownNftOwnership:[],
 nftEnumeration:{status:'unavailable',reason:'standard_erc721_does_not_enumerate_owned_token_ids'},
 unavailableReasons:['standard_erc721_does_not_enumerate_owned_token_ids'],actionAvailable:false,executionEligible:false,
 ...overrides});
const journal=(strategyId:'static_manual_v1'|'rangekeeper_v1'='static_manual_v1',overrides:Record<string,unknown>={})=>({
 status:'unavailable',targetStrategyId:strategyId,operator,journalStatus:'coherent',journalBlockers:[],
 unavailableReasons:['legacy_live_pilot_journal_not_bound_to_target_strategy_or_campaign'],
 actionAvailable:false,executionEligible:false,...overrides});
const compose=(draft=saved(),custody=snapshot(),diagnostic=journal(),nftCustodyEnumeration?:unknown)=>
 composeLiveStrategyPreflightEvidence({draft,custodySnapshot:custody,journalDiagnostic:diagnostic,nftCustodyEnumeration});

test('static/manual evidence binds saved wallet, verified profile, limits, snapshot and expected allowance scope',()=>{
 const result=compose();
 assert.equal(result.status,'unavailable');assert.equal(result.strategyId,'static_manual_v1');
 assert.equal(result.limitsBinding,'bound_to_saved_config');
 for(const key of ['saved_profile','saved_strategy_config','saved_strategy_limits','snapshot_operator','snapshot_chain',
  'snapshot_source','token_scope','allowance_scope','manager_snapshot_binding'])
  assert.equal(result.checks.find(item=>item.name===key)?.status,'matched',key);
 assert.equal(result.actionAvailable,false);assert.equal(result.executionEligible,false);
 assert(result.missing.includes('nft_enumeration_and_full_position_identity_unavailable'));
 assert(result.missing.includes('legacy_journal_is_not_current_strategy_custody_proof'));
});

test('RangeKeeper profile/config binding uses the same evidence composer without legacy admission',()=>{
 const result=compose(saved('rangekeeper_v1'),snapshot('rangekeeper_v1'),journal('rangekeeper_v1'));
 assert.equal(result.strategyId,'rangekeeper_v1');assert.equal(result.limitsBinding,'bound_to_saved_config');
 assert.equal(result.checks.find(item=>item.name==='allowance_scope')?.status,'matched');
 assert.equal(result.status,'unavailable');assert.equal(result.actionAvailable,false);
});

test('mismatched wallet, chain, token, manager or spender binding is surfaced explicitly',()=>{
 const mismatched=compose(saved('static_manual_v1',{wallet:'0x9999999999999999999999999999999999999999'}),
  snapshot('static_manual_v1',{operator:'0x9999999999999999999999999999999999999999',
   positionManager:'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   chainId:{status:'available',value:1},tokenBalances:[{token:token0,symbol:'A',raw:{status:'available',value:'100'}}],
   allowances:[]}));
 assert(mismatched.missing.includes('custody_snapshot_chain_mismatch'));
 assert(mismatched.missing.includes('custody_token_scope_mismatch'));
 assert(mismatched.missing.includes('custody_allowance_scope_mismatch'));
 assert(mismatched.missing.includes('custody_snapshot_does_not_report_manager_binding'));
 const badWallet=compose(saved('static_manual_v1',{wallet:'0x9999999999999999999999999999999999999999'}));
 assert(badWallet.missing.includes('custody_snapshot_wallet_mismatch'));
});

test('bad hashes, missing limits, unresolved legacy intents and positive NFT count stay unavailable',()=>{
 const badHash=compose(saved('static_manual_v1',{profileHash:'0'.repeat(64)}));
 assert(badHash.missing.includes('saved_profile_hash_mismatch'));
 const noLimits=compose(saved('static_manual_v1',{config:{halfWidthTicks:60},
  configHash:contentHash({halfWidthTicks:60,strategyId:'static_manual_v1',strategyVersion:'1.0.0',stateSchemaVersion:1})}));
 assert(noLimits.missing.includes('saved_strategy_limits_missing'));
 const unresolved=compose(saved(),snapshot(),journal('static_manual_v1',{journalStatus:'unresolved',
  journalBlockers:['unresolved_signed_intent']}));
 assert(unresolved.missing.includes('legacy_journal_state_unresolved'));
 const nft=compose(saved(),snapshot('static_manual_v1',{nftCount:{status:'available',value:'2'}}));
 assert(nft.missing.includes('owned_nfts_require_full_identity_reconciliation'));
});

test('live allocation is only compared to observed raw balances and never changes action availability',()=>{
 const insufficient=snapshot('static_manual_v1',{tokenBalances:[
  {token:token0,symbol:'A',raw:{status:'available',value:'9'}},
  {token:token1,symbol:'B',raw:{status:'available',value:'20'}},
 ]});
 const result=compose(saved(),insufficient);
 assert(result.missing.includes('live_allocation_balance_coverage_unavailable_or_insufficient'));
 assert.equal(result.actionAvailable,false);
});

test('complete transfer-index custody can match the strategy composer but cannot enable action',()=>{
 const pinned=snapshot();
 const enumeration={kind:'complete_position_manager_nft_custody',status:'available',targetStrategyId:'static_manual_v1',
  operator,positionManager:manager,source:pinned.source,enumerationComplete:true,tokenIds:[],
  balanceOfCount:{status:'available',value:'0'},knownOwners:[],
  indexedTransferCoverage:{status:'available',startBlock:'0',coveredThroughBlock:'100',
   coveredThroughHash:pinned.source.hash,sourceCheckpointHash:pinned.source.hash,transferCount:0,checkpointBlockCount:1},
  missing:[],actionAvailable:false,executionEligible:false};
 const result=compose(saved(),pinned,journal(),enumeration);
 assert.equal(result.checks.find(item=>item.name==='nft_custody')?.status,'matched');
 assert.equal(result.status,'unavailable');assert.equal(result.actionAvailable,false);
 assert.equal(result.executionEligible,false);
 const wrongBinding=compose(saved(),pinned,journal(),{...enumeration,positionManager:router});
 assert.equal(wrongBinding.checks.find(item=>item.name==='nft_custody')?.status,'unavailable');
 assert(result.missing.includes('live_intent_construction_review_and_signer_custody_not_implemented'));
});

test('a source-bound runtime profile proof can satisfy identity check without enabling action',()=>{
 const pinned=snapshot(),runtime={kind:'live_pool_runtime_identity',status:'available',
  targetStrategyId:'static_manual_v1',profileHash:contentHash(profile),source:pinned.source,
  contractHashes:{poolCodeHash:profile.pool.poolCodeHash,token0CodeHash:profile.pool.token0CodeHash,
   token1CodeHash:profile.pool.token1CodeHash,managerCodeHash:profile.pool.managerCodeHash,
   quoterCodeHash:profile.pool.quoterCodeHash},missing:[],actionAvailable:false};
 const result=compose(saved(),pinned,journal(),undefined);
 const withRuntime=composeLiveStrategyPreflightEvidence({draft:saved(),custodySnapshot:pinned,
  journalDiagnostic:journal(),poolRuntimeIdentity:runtime});
 assert.equal(result.checks.find(item=>item.name==='pool_runtime_identity')?.status,'unavailable');
 assert.equal(withRuntime.checks.find(item=>item.name==='pool_runtime_identity')?.status,'matched');
 assert.equal(withRuntime.actionAvailable,false);assert.equal(withRuntime.executionEligible,false);
 const mismatched=composeLiveStrategyPreflightEvidence({draft:saved(),custodySnapshot:pinned,
  journalDiagnostic:journal(),poolRuntimeIdentity:{...runtime,source:{...pinned.source,block:'99'}}});
 assert.equal(mismatched.checks.find(item=>item.name==='pool_runtime_identity')?.status,'unavailable');
});
