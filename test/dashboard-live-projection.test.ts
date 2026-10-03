import assert from 'node:assert/strict';
import {test} from 'node:test';
import {marketProfileSchema} from '../src/deployments/market-profile.js';
import {contentHash} from '../src/deployments/contracts.js';
import {rangeKeeperJson} from '../src/strategy/rangekeeper/live-domain.js';
import {NONFUNGIBLE_POSITION_MANAGER,UNISWAP_V3_FACTORY} from '../src/constants.js';
import {PAPER_QUOTER,PAPER_ROUTER} from '../src/paper/execution-abi.js';
import {deploymentPosition,deriveLiveLifecycle,liveStageKind,readDeploymentRows,readLiveActivity}
 from '../src/dashboard/deployment-position.js';

const address=(digit:string)=>`0x${digit.repeat(40)}`,hash=`0x${'a'.repeat(64)}`;
const profile=marketProfileSchema.parse({pool:{chainId:4663,factory:UNISWAP_V3_FACTORY,pool:address('1'),
 token0:address('2'),token1:address('3'),quoteToken:0,decimals0:6,decimals1:18,fee:3000,tickSpacing:60,
 positionManager:NONFUNGIBLE_POSITION_MANAGER,router:PAPER_ROUTER,quoter:PAPER_QUOTER,poolCodeHash:hash,
 token0CodeHash:hash,token1CodeHash:hash,managerCodeHash:hash,quoterCodeHash:hash,
 reference0:'USDG/USD',reference1:'AAPL/USD',nativeReference:'ETH/USD',numeraire:'USD'},
 referencePolicy:{token0:{kind:'stablecoin',maxAgeSeconds:180,session:'verified_24_7',corporateAction:'reject_pending'},
  token1:{kind:'stock_token',maxAgeSeconds:180,session:'latest_equity_session',corporateAction:'reject_pending'},
  nativeMaxAgeSeconds:180,maxPoolDeviationPpm:10_000}});
const campaignId='00000000-0000-4000-8000-000000000001',jobId='55555555-5555-4555-8555-555555555555';
const now=Math.floor(Date.now()/1000);

function runtimeState(extra:Record<string,unknown>={},last:Record<string,unknown>|null=null){
 const state:any={version:1,id:campaignId,operator:address('4'),configHash:`0x${'c'.repeat(64)}`,buildId:'test',
  phase:'holding',desired:'running',haltReason:null,createdAt:now-300,expiresAt:now+300,economicActions:1,recenters:2,
  policy:{},last:last??{source:{block:'100',hash:`0x${'b'.repeat(64)}`,timestamp:now-5},tick:10,
   position:{tokenId:1000n,tickLower:-60,tickUpper:60,liquidity:5n}},activeTokenId:1000n,retiredTokenIds:[],
  legacyNftCount:0n,gasSpentWei:1234n,costEvents:[],lastReason:'holding',closedAt:null,...extra};
 return state;
}
const json=(value:unknown)=>JSON.parse(rangeKeeperJson(value));
/** A live row as readDeploymentRows returns it: lifecycle and queue columns, no valuation mark. */
function liveRow(overrides:Record<string,unknown>={},state:any=null){
 return {id:campaignId,mode:'live',lifecycle:'active',range_state:'unknown',current_revision:1,
  created_at:new Date((now-600)*1000),closed_at:null,
  allocation:{token0Raw:'200000000',token1Raw:'340000000000000000',nativeWei:'6000000000000000'},
  runtime_identity:null,profile,strategy_id:'rangekeeper_v1',config:{},mark_id:null,mark_at:null,source_block:null,
  source_hash:null,inventory:null,economics:null,provenance:null,initial_value:null,
  operation_id:null,operation_kind:null,operation_status:null,operation_stage:null,operation_reason:null,
  operation_updated_at:null,accounting_snapshot:null,accounting_hash:null,rangekeeper_accounting_snapshot:null,
  rangekeeper_accounting_hash:null,conversion_accounting_snapshot:null,conversion_accounting_hash:null,
  accounting_invalidated_at:null,accounting_invalidation_reason:null,live_mark_payload:null,live_mark_payload_hash:null,
  live_mark_block:null,live_mark_hash:null,live_mark_timestamp:null,
  live_runtime_state:state?json(state):null,live_runtime_state_hash:state?contentHash(json(state)):null,
  live_runtime_revision:state?1:null,live_runtime_profile_hash:null,live_runtime_config_hash:null,live_profile_id:null,
  live_runtime_status:state?(state.phase==='closed'?'closed':state.phase==='halted'?'blocked':'active'):null,
  live_job_id:null,live_job_kind:null,live_job_status:null,live_job_resume_stage:null,live_job_attempt:null,
  live_job_created_at:null,live_job_updated_at:null,live_outbox_stage:null,live_outbox_nonce:null,
  live_outbox_hash:null,live_outbox_status:null,...overrides} as any;
}
const job=(kind:string,status:string,extra:Record<string,unknown>={})=>({live_job_id:jobId,live_job_kind:kind,
 live_job_status:status,live_job_attempt:1,live_job_created_at:new Date(),live_job_updated_at:new Date(),...extra});

test('derives the live lifecycle from the campaign, runtime phase and current queue job',()=>{
 const cases:[string,Parameters<typeof deriveLiveLifecycle>[0],string][]=[
  ['accepted open waits in the queue',{campaignLifecycle:'opening',job:{kind:'open',status:'queued'}},'queued'],
  ['claimed open is opening',{campaignLifecycle:'opening',job:{kind:'open',status:'executing'}},'opening'],
  ['reconciling open is still opening',{campaignLifecycle:'opening',job:{kind:'open',status:'reconciling'}},'opening'],
  ['succeeded open with no runtime event yet is opening',{campaignLifecycle:'opening',job:{kind:'open',status:'succeeded'}},'opening'],
  ['rejected open is blocked, never healthy progress',{campaignLifecycle:'opening',job:{kind:'open',status:'rejected'}},'blocked'],
  ['active campaign at rest is holding',{campaignLifecycle:'active',runtimeStatus:'active',phase:'holding',
   job:{kind:'open',status:'succeeded'}},'holding'],
  ['change_range in flight is recentering even while queued',{campaignLifecycle:'active',phase:'holding',
   job:{kind:'change_range',status:'queued'}},'recentering'],
  ['change_range executing is recentering',{campaignLifecycle:'active',job:{kind:'change_range',status:'executing'}},'recentering'],
  ['recenter runtime phase without a job is recentering',{campaignLifecycle:'active',phase:'recenter'},'recentering'],
  ['close_retain in flight is closing',{campaignLifecycle:'active',job:{kind:'close_retain',status:'confirming'}},'closing'],
  ['exit runtime phase is closing',{campaignLifecycle:'active',phase:'exit'},'closing'],
  ['closed campaign is closed',{campaignLifecycle:'closed',job:{kind:'close_retain',status:'succeeded'}},'closed'],
  ['closed runtime wins over a stale campaign row',{campaignLifecycle:'active',runtimeStatus:'closed'},'closed'],
  ['blocked campaign is blocked',{campaignLifecycle:'blocked'},'blocked'],
  ['halted runtime is blocked',{campaignLifecycle:'active',phase:'halted'},'blocked'],
  ['blocked job blocks the campaign',{campaignLifecycle:'active',phase:'holding',job:{kind:'change_range',status:'blocked'}},'blocked'],
  ['a finished recenter returns to holding',{campaignLifecycle:'active',phase:'holding',job:{kind:'change_range',status:'succeeded'}},'holding'],
  ['a cancelled recenter leaves the campaign holding',{campaignLifecycle:'active',phase:'holding',job:{kind:'change_range',status:'cancelled'}},'holding'],
 ];
 for(const [name,input,expected] of cases)assert.equal(deriveLiveLifecycle(input),expected,name);
 assert.equal(liveStageKind(`withdraw:${'a'.repeat(32)}`),'withdraw');
 assert.equal(liveStageKind('mint'),'mint');
 assert.equal(liveStageKind(null),null);
 assert.equal(liveStageKind('../etc'),null);
});

test('an admitted live campaign is a visible queued row with no invented economics',()=>{
 const position=deploymentPosition(liveRow({lifecycle:'opening',...job('open','queued')}));
 assert.equal(position.mode,'live');assert.equal(position.status,'waiting');assert.equal(position.history,false);
 const live=position.deployment.live!;
 assert.equal(live.lifecycle,'queued');assert.equal(live.job?.kind,'open');assert.equal(live.job?.status,'queued');
 assert.equal(live.job?.inFlight,true);assert.equal(live.job?.nonce,null);assert.equal(live.job?.txHash,null);
 assert.equal(live.nftId,null);assert.deepEqual(live.allocation,{token0Raw:'200000000',token1Raw:'340000000000000000',nativeWei:'6000000000000000'});
 for(const field of ['navQuote','holdQuote','feesQuote','gasQuote','swapQuote'] as const)
  assert.equal(position[field],null,`${field} stays unavailable instead of zero`);
 assert.equal(position.accounting,'unavailable');
 assert.deepEqual(position.reasons,[],'a queued campaign is not reported as having a missing first mark or stale source');
 assert.equal(position.deployment.operation.id,jobId);assert.equal(position.deployment.operation.kind,'open');
 assert.match(position.nextAction??'',/Live opening queued/);
 assert.doesNotThrow(()=>JSON.stringify(position));
});

test('a submitted opening stage exposes its nonce and transaction hash, and an unsigned stage exposes only the nonce',()=>{
 const signed=deploymentPosition(liveRow({lifecycle:'opening',...job('open','confirming',{live_job_resume_stage:`mint:${'f'.repeat(32)}`,
  live_outbox_stage:`mint:${'f'.repeat(32)}`,live_outbox_nonce:'12',live_outbox_hash:`0x${'9'.repeat(64)}`,live_outbox_status:'signed'})}));
 assert.equal(signed.deployment.live!.lifecycle,'opening');assert.equal(signed.status,'waiting');
 assert.equal(signed.deployment.live!.job?.stageKind,'mint');assert.equal(signed.deployment.live!.job?.nonce,'12');
 assert.equal(signed.deployment.live!.job?.txHash,`0x${'9'.repeat(64)}`);
 const prepared=deploymentPosition(liveRow({lifecycle:'opening',...job('open','executing',{live_outbox_stage:'approve:abc',
  live_outbox_nonce:'11',live_outbox_hash:null,live_outbox_status:'prepared'})}));
 assert.equal(prepared.deployment.live!.job?.txHash,null);assert.equal(prepared.deployment.live!.job?.nonce,'11');
 assert.equal(prepared.deployment.live!.job?.stageStatus,'prepared');
 const forged=deploymentPosition(liveRow({lifecycle:'opening',...job('open','executing',{live_outbox_stage:'approve:abc',
  live_outbox_nonce:'-1',live_outbox_hash:'not-a-hash',live_outbox_status:'signed'})}));
 assert.equal(forged.deployment.live!.job?.nonce,null,'a malformed nonce is dropped, not displayed');
 assert.equal(forged.deployment.live!.job?.txHash,null,'a malformed hash is dropped, not displayed');
});

test('holding rows take NFT id, range and in or out of range from the integrity-checked runtime when no valuation exists',()=>{
 const inside=deploymentPosition(liveRow({lifecycle:'active',...job('open','succeeded')},runtimeState()));
 assert.equal(inside.status,'open');assert.equal(inside.deployment.rangeState,'inside');
 assert.equal(inside.deployment.live!.lifecycle,'holding');assert.equal(inside.deployment.live!.nftId,'1000');
 assert.equal(inside.tokenId,'1000');assert.equal(inside.hasLiquidity,true);assert.equal(inside.history,false);
 assert.equal(inside.deployment.live!.recenters,2);assert.equal(inside.deployment.live!.paidGasWei,'1234');
 assert.equal(inside.range?.length,2);assert.equal(inside.navQuote,null);assert.equal(inside.accounting,'unavailable');
 assert(inside.reasons.includes('live_valuation_unavailable'),'missing valuation is stated, not hidden');
 const outside=deploymentPosition(liveRow({lifecycle:'active'},runtimeState({},{source:{block:'101',hash,timestamp:now-5},tick:61,
  position:{tokenId:999n,tickLower:-60,tickUpper:60,liquidity:5n}})));
 assert.equal(outside.status,'outside');assert.equal(outside.deployment.rangeState,'outside');
 assert.equal(outside.deployment.live!.nftId,'999');assert(outside.reasons.includes('outside_range_observed'));
 const edge=deploymentPosition(liveRow({lifecycle:'active'},runtimeState({},{source:{block:'101',hash,timestamp:now-5},tick:60,
  position:{tokenId:1001n,tickLower:-60,tickUpper:60,liquidity:5n}})));
 assert.equal(edge.deployment.rangeState,'outside','the upper tick is exclusive, matching the pool');
 // A runtime whose hash does not match is never trusted.
 const tampered=liveRow({lifecycle:'active'},runtimeState());tampered.live_runtime_state_hash='0'.repeat(64);
 const untrusted=deploymentPosition(tampered);
 assert.equal(untrusted.deployment.live!.nftId,null);assert.equal(untrusted.deployment.live!.runtimeVerified,false);
 assert.equal(untrusted.deployment.rangeState,'no_liquidity');
 const stale=liveRow({lifecycle:'active',live_runtime_revision:2},runtimeState());
 assert.equal(deploymentPosition(stale).deployment.live!.runtimeVerified,false,'a runtime from another revision is not trusted');
});

test('change_range progress renders as recentering with its stage, nonce 1000 and hash, ordered numerically after 999',()=>{
 const stage=`withdraw:${'e'.repeat(32)}`;
 const recentering=deploymentPosition(liveRow({lifecycle:'active',...job('change_range','executing',{live_job_resume_stage:stage,
  live_outbox_stage:stage,live_outbox_nonce:'1000',live_outbox_hash:`0x${'3'.repeat(64)}`,live_outbox_status:'signed'})},runtimeState()));
 assert.equal(recentering.status,'recentring');assert.equal(recentering.deployment.live!.lifecycle,'recentering');
 assert.equal(recentering.deployment.live!.job?.kind,'change_range');assert.equal(recentering.deployment.live!.job?.stageKind,'withdraw');
 assert.equal(recentering.deployment.live!.job?.nonce,'1000');assert.equal(recentering.deployment.operation.kind,'change_range');
 assert.equal(recentering.deployment.live!.nftId,'1000','the position being recentered stays visible');
 const queued=deploymentPosition(liveRow({lifecycle:'active',...job('change_range','queued')},runtimeState()));
 assert.equal(queued.deployment.live!.lifecycle,'recentering');assert.equal(queued.deployment.live!.job?.status,'queued');
 const done=deploymentPosition(liveRow({lifecycle:'active',...job('change_range','succeeded')},runtimeState({recenters:3})));
 assert.equal(done.deployment.live!.lifecycle,'holding');assert.equal(done.deployment.live!.recenters,3);
});

test('blocked live campaigns carry their recorded reason; closing and closed lifecycles are distinct',()=>{
 const halted=deploymentPosition(liveRow({lifecycle:'blocked',...job('open','blocked',{live_outbox_stage:'mint:abc',live_outbox_nonce:'12',
  live_outbox_status:'blocked'})},runtimeState({phase:'halted',haltReason:`transaction_reverted:${jobId}:mint:abc`})));
 assert.equal(halted.status,'blocked');assert.equal(halted.deployment.live!.lifecycle,'blocked');
 assert.equal(halted.deployment.live!.blockedReason,`transaction_reverted:${jobId}:mint:abc`);
 assert.equal(halted.deployment.operation.reason,halted.deployment.live!.blockedReason);
 assert(halted.reasons.includes('operation_blocked'));
 const jobBlocked=deploymentPosition(liveRow({lifecycle:'active',...job('change_range','blocked',{live_outbox_stage:'swap:abc',
  live_outbox_nonce:'7',live_outbox_status:'blocked'})},runtimeState()));
 assert.equal(jobBlocked.deployment.live!.lifecycle,'blocked');assert.equal(jobBlocked.deployment.live!.blockedReason,'job_blocked:swap');
 const rejected=deploymentPosition(liveRow({lifecycle:'opening',...job('open','rejected')}));
 assert.equal(rejected.deployment.live!.lifecycle,'blocked');assert.equal(rejected.deployment.live!.blockedReason,'job_rejected');
 const closing=deploymentPosition(liveRow({lifecycle:'active',...job('close_retain','executing',{live_outbox_stage:'withdraw:abc',
  live_outbox_nonce:'20',live_outbox_status:'prepared'})},runtimeState({phase:'exit',exitMode:'retain'})));
 assert.equal(closing.status,'exiting');assert.equal(closing.deployment.live!.lifecycle,'closing');assert.equal(closing.history,false);
 const closed=deploymentPosition(liveRow({lifecycle:'closed',closed_at:new Date(),...job('close_retain','succeeded')},
  runtimeState({phase:'closed',closedAt:now-1,last:{source:{block:'102',hash,timestamp:now-5},tick:0,position:null}})));
 assert.equal(closed.status,'closed');assert.equal(closed.history,true,'closed campaigns move to History');
 assert.equal(closed.deployment.live!.lifecycle,'closed');assert.equal(closed.hasLiquidity,false);
 assert.equal(closed.nextAction,null);
});

test('a v11 database without live tables yields rows without live columns and no error',async()=>{
 const queries:string[]=[];
 const present=new Set(['deployment_campaigns']);
 const db={query:async(sql:string)=>{
  queries.push(sql);
  const probe=/to_regclass\('([a-z_]+)'\)/.exec(sql);
  if(probe)return {rows:[{present:present.has(probe[1]!)?probe[1]:null}]};
  return {rows:[liveRow({lifecycle:'opening'})]};
 }} as any;
 const rows=await readDeploymentRows(db);
 const main=queries.at(-1)!;
 for(const table of ['deployment_live_jobs','deployment_live_stage_outbox','deployment_live_campaign_runtime','deployment_live_runtime_events'])
  assert(!main.includes(table),`v11 query must not reference ${table}`);
 assert(main.includes('NULL::text AS live_job_id'));
 const position=deploymentPosition(rows[0]!);
 assert.equal(position.deployment.live!.lifecycle,'opening');assert.equal(position.deployment.live!.job,null);
 assert.equal(position.status,'waiting');
 // With the v12-v14 tables present the same query joins the queue, outbox and runtime.
 for(const table of ['deployment_live_jobs','deployment_live_campaign_runtime','deployment_live_runtime_events'])present.add(table);
 queries.length=0;await readDeploymentRows(db);
 const full=queries.at(-1)!;
 assert(full.includes('deployment_live_stage_outbox')&&full.includes('FROM deployment_live_jobs j'));
 assert(full.includes('o.nonce::text AS outbox_nonce')&&full.includes('ORDER BY created_at DESC,nonce DESC'),
  'the latest stage is selected by typed numeric nonce, not by text');
 // No live rows at all is simply an empty live section.
 assert.deepEqual(await readDeploymentRows({query:async(sql:string)=>/to_regclass\('deployment_campaigns'\)/.test(sql)?{rows:[{present:null}]}:{rows:[]}} as any),[]);
});

test('live activity orders nonces and queue sequences numerically across the 999/1000 boundary and tolerates a missing queue',async()=>{
 const at=new Date('2026-10-03T12:00:00.000Z');
 const calls:string[]=[];
 const db={query:async(sql:string)=>{
  calls.push(sql);
  if(sql.includes('to_regclass'))return {rows:[{present:'deployment_live_jobs'}]};
  if(sql.includes('FROM deployment_live_jobs WHERE'))return {rows:[
   {id:'11111111-1111-4111-8111-111111111111',kind:'change_range',status:'succeeded',resume_stage:null,attempt:1,created_at:at,updated_at:at,sequence:'999'},
   {id:'22222222-2222-4222-8222-222222222222',kind:'change_range',status:'executing',resume_stage:'mint:abc',attempt:2,created_at:at,updated_at:at,sequence:'1000'}]};
  return {rows:[
   {job_id:'22222222-2222-4222-8222-222222222222',stage:'approve:aa',nonce:'999',hash:`0x${'1'.repeat(64)}`,status:'confirmed',created_at:at,kind:'change_range'},
   {job_id:'22222222-2222-4222-8222-222222222222',stage:'mint:bb',nonce:'1000',hash:`0x${'2'.repeat(64)}`,status:'signed',created_at:at,kind:'change_range'},
   {job_id:'22222222-2222-4222-8222-222222222222',stage:'swap:cc',nonce:'1001',hash:'bad',status:'prepared',created_at:at,kind:'change_range'}]};
 }} as any;
 const result=await readLiveActivity(db,campaignId,new Date(0));
 assert.deepEqual(result.events.filter(e=>e.kind==='stage').map(e=>e.nonce),['1001','1000','999']);
 assert.deepEqual(result.events.filter(e=>e.kind==='job').map(e=>e.sequence),['1000','999']);
 assert.equal(result.events.find(e=>e.nonce==='1001')?.hash,null,'a malformed hash is not displayed');
 assert.equal(result.events.find(e=>e.nonce==='1000')?.hash,`0x${'2'.repeat(64)}`);
 assert.equal(result.recenterAttempts,2);
 assert(calls.some(sql=>sql.includes('ORDER BY o.created_at DESC,o.nonce DESC')&&sql.includes('o.nonce::text')));
 assert.doesNotThrow(()=>JSON.stringify(result));
 const absent=await readLiveActivity({query:async()=>({rows:[{present:null}]})} as any,campaignId,new Date(0));
 assert.deepEqual(absent,{events:[],recenterAttempts:0,swaps:0});
});
