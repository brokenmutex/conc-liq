// Owned-fork qualification of the automatic RangeKeeper management paths of the shared-wallet live stack: automatic
// recenter, stale re-plan after a confirmed withdrawal, retained-exit priority and recenter-to-exit conversion, operator
// retained close, restart recovery and sibling isolation. The real composed runtime (createRangeKeeperLiveRuntime with
// managementEnabled and persisted reviews), the real planner, the real command server (HTTP admission and retain routes)
// and the real owned-fork stage proofs run against one branded loopback Anvil fork of canonical chain state.
//
// Safety: the signer is a throwaway key; the only publisher is the fork-branded hook (assertOwnedPaperFork before every
// sign and publish); the upstream archive is a read-only pinned-read transport. Production, its database and its signer
// are never touched. Time is real: the planner's 300 s outside-range persistence, 30 s decision interval and 90 s
// two-confirmation window elapse in wall-clock time because every canonical source must be recent (see helpers/chain).
//
// Usage: node --import tsx test/integration/rangekeeper-live-management-fork.mjs <fork-env-file>
//   [--scenarios=1,2,3,4,5,6,7] [--archive-env=RH_ARCHIVE_RPC_URL] [--tick-seconds=20] [--liquidity-share-ppm=200000] [--print-plan]
// --archive-env names the env-file key that holds the read-only archive URL (a replacement endpoint can use another key).
// Requires TEST_DATABASE_URL (disposable database; one isolated schema is created and dropped).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rangeKeeperLiveSetupPreflightInput} from '../../src/deployments/rangekeeper-live-setup-preflight.ts';
import {liveWalletCommitmentFingerprint} from '../../src/deployments/live-wallet-commitment-projection.ts';
import {isRangeKeeperAwaitingReplan,isRangeKeeperRetainedExit} from '../../src/deployments/rangekeeper-live-campaign.ts';
import {RANGEKEEPER_ALLOWANCE_POLICY,RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE,assertAllowancesWithinCaps,assertWalletAllowancesInPolicy}
 from '../../src/strategy/rangekeeper/allowance-policy.ts';
import {buildWalletAllowanceScope,readRangeKeeperWalletAllowanceUses} from '../../src/deployments/live-wallet-allowance-scope.ts';
import {marketProfileSchema} from '../../src/deployments/market-profile.ts';
import {bootstrapManagementFork,UpstreamBlockedError} from './helpers/management-fork-bootstrap.mjs';
import {createInspector,decodeBigints} from './helpers/management-fork-inspect.mjs';
import {createManagementRuntimeFactory,createExecutionStats,createDriver,jsonSafe} from './helpers/management-fork-runtime.mjs';
import {readAllowancePairs,readNft,readSlot0,setPoolLocked,sleep} from './helpers/management-fork-chain.mjs';

const args=process.argv.slice(2);
const flag=(name,fallback)=>{const found=args.find(a=>a.startsWith(`--${name}=`));return found?found.slice(name.length+3):fallback;};
const envFile=args.find(a=>!a.startsWith('--'))??'/root/conc-liq/data/fork-qualification.env';
const selected=new Set(flag('scenarios','1,2,3,4,5,6,7').split(',').map(Number));
const archiveEnvName=flag('archive-env','RH_ARCHIVE_RPC_URL');
const tickSeconds=Number(flag('tick-seconds','20'));
const liquiditySharePpm=Number(flag('liquidity-share-ppm','200000'));
const buildId='e'.repeat(64);
const startedAt=Date.now();
const log=(event,data={})=>console.error(JSON.stringify({t:new Date().toISOString(),event,...jsonSafe(data)}));

// ------------------------------------------------------------------------------------------ outcome bookkeeping
const names={1:'open campaigns via HTTP admission, worker executes to holding',2:'automatic recenter (persistence, two confirmations, change_range job)',
 3:'stale candidate after a confirmed withdraw: re-plan, withdraw never repeated',4:'safety exit: recenter-to-exit conversion',
 5:'operator retained close via HTTP preview/operation; retained exit outranks a blocked recenter; replay returns the same job',
 6:'restart recovery mid-recenter: lost publish acknowledgement, exact bytes, stale lease',7:'sibling isolation and shared-wallet allowance behaviour'};
// A scenario passes only when every assertion block it owns has run.
const blocks={1:1,2:3,3:2,4:1,5:1,6:1,7:1};
const outcome=new Map(Object.keys(names).map(n=>[Number(n),{name:names[n],status:selected.has(Number(n))?'NOT_REACHED':'SKIPPED',blocksDone:0,evidence:{}}]));
const evidence=n=>outcome.get(n).evidence;
/** Run one block of a scenario's assertions. Blocks always run (flows need their side effects) but only selected scenarios
 * are recorded. A failing block marks its scenario FAIL and aborts the enclosing flow, whose later steps depend on it. */
const scenario=async(n,fn)=>{
 const o=outcome.get(n),started=Date.now();
 try{
  await fn(selected.has(n)?o.evidence:{});
  if(selected.has(n)&&o.status!=='FAIL'){o.blocksDone++;if(o.blocksDone>=blocks[n])o.status='PASS';
   o.seconds=(o.seconds??0)+Math.round((Date.now()-started)/1000);log('scenario_block_ok',{scenario:n,done:o.blocksDone,of:blocks[n]});}
 }catch(error){
  if(selected.has(n)){o.status='FAIL';o.error=String(error?.stack??error).replace(/https?:\/\/\S+/gi,'[redacted-url]').slice(0,1500);log('scenario_fail',{scenario:n,error:o.error});}
  throw error;
 }
};

let ctx,inspector,factory,driver,stats,faults;
const runtimeNow=()=>ctx.runtimeRef.current;
const campaigns={};
const post=async(path,body)=>{
 const response=await fetch(ctx.commandUrl+path,{method:'POST',headers:ctx.commandHeaders,body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
};
const poolOf=row=>row.profile.pool;
const kindsOf=stages=>stages.map(s=>s.kind);

// ------------------------------------------------------------------------------------------ allowance policy
/** EVERY allowance/approval-specific expectation of this qualification lives in this one helper. POLICY persistent_capped_v1
 * (src/strategy/rangekeeper/allowance-policy.ts): approvals persist between stages and are capped at CAP_MULTIPLE x the
 * largest exposure; there is no per-stage zero cleanup; a close zeroes only the non-zero pairs no other active campaign uses
 * (beside a same-token sibling it only withdraws; the last user withdraws and zeroes each non-zero pair). Invariant: every
 * allowance is zero, or on a registered token+spender pair used by an active campaign, and within its cap. */
const ALLOWANCE_POLICY={name:RANGEKEEPER_ALLOWANCE_POLICY,capMultiple:String(RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE),
 siblingExitZeroesOtherCampaignAllowance:false};
const pairLabel=(token,spender)=>`${token}:${spender}`.toLowerCase();
async function allowanceChecks(kind,input={}){
 const pairs=new Map();
 for(const row of [ctx.p500,ctx.p3000])for(const pair of await readAllowancePairs(ctx.local,ctx.wallet,poolOf(row)))
  pairs.set(pairLabel(pair.token,pair.spender),{...pair,key:pairLabel(pair.token,pair.spender),label:pair.key});
 const observed=[...pairs.values()],nonZero=observed.filter(p=>p.amount>0n);
 const summary=rows=>rows.map(p=>({key:p.key,label:p.label,amount:String(p.amount)}));
 if(kind==='observe')return {policy:ALLOWANCE_POLICY.name,pairsChecked:observed.length,nonZero:summary(nonZero)};
 if(kind==='all_zero'){
  assert.equal(nonZero.length,0,`${input.when}: an allowance survived the last user's close (${JSON.stringify(jsonSafe(summary(nonZero)))})`);
  return {policy:ALLOWANCE_POLICY.name,pairsChecked:observed.length,allZero:true};
 }
 if(kind==='in_policy'){
  const uses=await readRangeKeeperWalletAllowanceUses(ctx.db,ctx.wallet);
  const scope=buildWalletAllowanceScope(uses,ctx.profileRows.map(r=>marketProfileSchema.parse(r.profile)));
  assertWalletAllowancesInPolicy(observed.map(({token,spender,amount})=>({token,spender,amount})),scope);
  // Independent cap check from the raw per-campaign exposure (not the product's own ceiling map).
  const exposure=new Map();
  for(const use of uses)[use.pool.token0,use.pool.token1].forEach((token,i)=>{
   const key=token.toLowerCase(),prior=exposure.get(key)??0n;if(use.exposure[i]>prior)exposure.set(key,use.exposure[i]);});
  for(const p of nonZero)assert(p.amount<=RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE*(exposure.get(p.token.toLowerCase())??0n),
   `${input.when}: allowance ${p.label} exceeds ${RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE}x its exposure`);
  const unusedNonZero=nonZero.filter(p=>!scope.used.has(p.key));
  assert.equal(unusedNonZero.length,0,`${input.when}: non-zero allowance on a pair no active campaign uses`);
  return {policy:ALLOWANCE_POLICY.name,pairsChecked:observed.length,nonZero:summary(nonZero),activeCampaigns:uses.filter(u=>u.lifecycle!=='closed').length};
 }
 if(kind==='job_cleanup_proof'){
  const final=input.stages.filter(s=>s.status==='confirmed').at(-1),proof=final?.allowance_cleanup_json;
  assert(proof&&proof.verified===true&&proof.noPendingAction===true,`${input.when}: the final stage lacks a verified cleanup proof`);
  assert.equal(proof.allowancePolicy?.kind,RANGEKEEPER_ALLOWANCE_POLICY,`${input.when}: the cleanup proof carries no ${RANGEKEEPER_ALLOWANCE_POLICY} policy`);
  assert(proof.allowances.length>0,`${input.when}: the cleanup proof lists no allowance identity`);
  assertAllowancesWithinCaps(proof.allowances,proof.allowancePolicy.caps);
  if(input.expectAllZero)assert(proof.allowances.every(a=>BigInt(a.amount)===0n),`${input.when}: the last user's close left a non-zero allowance`);
  return {cleanupAllowanceIdentities:proof.allowances.length,cappedPairs:proof.allowancePolicy.caps.length,
   nonZeroAtCleanup:proof.allowances.filter(a=>BigInt(a.amount)>0n).length,custodyState:proof.custodyState};
 }
 if(kind==='stage_pattern'){
  const plans=input.stages.filter(s=>s.status==='confirmed').map(s=>s.plan),kinds=plans.map(p=>p.kind);
  const approves=plans.filter(p=>p.kind==='approve'),core=kinds.filter(k=>k!=='approve');
  const label=p=>`${p.token}:${p.spender}`;
  const result={job:input.job,kinds,approvals:approves.length};
  if(input.job==='open_fresh_wallet'){
   assert.deepEqual(kinds,['approve','approve','approve','swap','mint'],`${input.when}: unexpected fresh-wallet open ${kinds}`);
   assert.deepEqual(approves.map(label),['0:positionManager','1:positionManager','0:router'],`${input.when}: unexpected first approvals`);
  }else if(input.job==='open_shared_pair'){
   assert.deepEqual(core,['swap','mint'],`${input.when}: unexpected open ${kinds}`);
   if(input.strict)assert.equal(approves.length,0,`${input.when}: a sibling pair open must reuse the persisted allowances`);
   assert(approves.length<=2,`${input.when}: too many top-up approvals ${kinds}`);
  }else if(input.job==='recenter'){
   assert.deepEqual(core,['withdraw','swap','mint'],`${input.when}: unexpected recenter ${kinds}`);
   assert(approves.length<=1,`${input.when}: more than one top-up approval ${kinds}`);
  }else if(input.job==='close_beside_sibling'){
   assert.deepEqual(kinds,['withdraw'],`${input.when}: a close beside a sibling must only withdraw ${kinds}`);
  }else if(input.job==='close_last_user'){
   assert.equal(kinds[0],'withdraw');
   assert(plans.slice(1).every(p=>p.kind==='approve'&&p.amount===0n),`${input.when}: the last close does more than zero the pairs ${kinds}`);
   assert.equal(approves.length,input.nonZeroBefore,`${input.when}: expected one zero approval per non-zero pair`);
  }else throw Error(`Unknown stage pattern ${input.job}`);
  // Every approval grants a positive finite amount (never the maximum sentinel); only a last-user close approves zero.
  for(const a of approves)assert(input.job==='close_last_user'?a.amount===0n:a.amount>0n&&a.amount<(1n<<255n),`${input.when}: unexpected approval amount ${a.amount}`);
  return {...result,approvalAmounts:approves.map(a=>`${label(a)}=${a.amount}`)};
 }
 if(kind==='sibling_probe'){
  const {before,after}=input;
  assert(before.length>0,'The probe needs the other campaign to hold persisted allowances');
  const unchanged=before.every(b=>after.some(a=>a.key===b.key&&a.amount===b.amount))&&after.length===before.length;
  const result={policy:ALLOWANCE_POLICY.name,beforeSiblingExit:before.map(b=>`${b.label}=${b.amount}`),afterSiblingExit:after.map(a=>`${a.label}=${a.amount}`),
   siblingExitLeftOtherCampaignAllowancesUntouched:unchanged};
  assert.equal(!unchanged,ALLOWANCE_POLICY.siblingExitZeroesOtherCampaignAllowance,
   `Observed cross-campaign exit behaviour differs from policy ${ALLOWANCE_POLICY.name}: ${JSON.stringify(result)}`);
  return result;
 }
 throw Error(`Unknown allowance check ${kind}`);
}

// ------------------------------------------------------------------------------------------ campaign helpers
const baseLimits=()=>{
 const l=ctx.operatorConfig.limits;
 return {maxDeploymentValue:String(l.maxDeploymentValue),minDeploymentValue:'1',minDeploymentPpm:l.minDeploymentPpm,maxSwapInputValue:String(l.maxSwapInputValue),
  maxSwapInputPpm:l.maxSwapInputPpm,maxSwapShortfallValue:String(l.maxSwapShortfallValue),maxRecenters:l.maxRecenters,maxLiquiditySharePpm:liquiditySharePpm,
  maxObservationGapSeconds:90,maxExposurePpm:l.maxExposurePpm,maxLossValue:String(l.maxLossValue),maxDrawdownPpm:l.maxDrawdownPpm,
  maxActionCost:String(l.maxActionCost),maxRollingCost:String(l.maxRollingCost),maxCampaignCost:String(l.maxCampaignCost),
  exitReserveWei:String(l.exitReserveWei),maxSlippageBps:l.maxSlippageBps};
};

/** Open one campaign through the real HTTP preflight and admission routes (with exact replay), without running the worker. */
async function admitCampaign(label,{row,capitalQuoteRaw,fullWidthSpacings=4}){
 const input=rangeKeeperLiveSetupPreflightInput.parse({profileId:row.id,capitalQuoteRaw,fullWidthSpacings,limits:baseLimits()});
 let preflight=null,detail=null;
 for(let attempt=0;attempt<3&&!preflight;attempt++){
  await ctx.clock.tick();
  const response=await post('/api/deployments/rangekeeper/live-setup-preflight',input);
  if(response.status===200&&response.body.status==='indicative'&&response.body.reviewPersistence?.status==='persisted'&&response.body.admissionAvailable===true)
   preflight=response.body;
  else{detail={http:response.status,status:response.body.status,missing:response.body.missing,persistence:response.body.reviewPersistence};
   log('admit_preflight_retry',{label,attempt,detail});await sleep(5000);}
 }
 assert(preflight,`Live setup preflight for ${label} produced no persisted review: ${JSON.stringify(detail)}`);
 assert.equal(preflight.executionEligible,false);
 const persisted=preflight.reviewPersistence;
 const body={reviewId:persisted.reviewId,reviewHash:persisted.reviewHash,requestId:randomUUID()};
 const first=await post('/api/deployments/rangekeeper/live-setup-admit',body);
 assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(first.body.status,'queued',JSON.stringify(first.body));
 const replay=await post('/api/deployments/rangekeeper/live-setup-admit',body);
 assert.equal(replay.status,200);assert.deepEqual(replay.body,{...first.body,replayed:true});
 const c={label,row,input,campaignId:first.body.campaignId,jobId:first.body.jobId,allocationId:first.body.allocationId,range:preflight.range};
 campaigns[label]=c;
 log('campaign_admitted',{label,campaignId:c.campaignId,jobId:c.jobId,range:preflight.range});
 return c;
}
async function runOpenToHolding(c){
 await driver.driveUntil(`open ${c.label} to holding`,async()=>{
  const job=await inspector.jobRow(c.jobId);
  if(job?.status!=='succeeded')return false;
  const cp=await inspector.campaign(c.campaignId);
  return cp.status==='active'&&cp.state?.phase==='holding'?cp:false;
 },{timeoutSec:1800,tickSeconds:30});
}
/** Cost attribution: every confirmed receipt of the campaign is charged exactly once (unique hashes, set equality). */
async function assertCostsAttributedOnce(c,when){
 const {state}=await inspector.stateOf(c.campaignId);
 const hashes=[];
 for(const job of await inspector.jobsOf(c.campaignId))for(const stage of await inspector.confirmedStagesOf(job.id))hashes.push(String(stage.signed_raw_hash).toLowerCase());
 const costs=state.costEvents.map(e=>String(e.hash).toLowerCase());
 assert.equal(new Set(costs).size,costs.length,`${when}: receipt economics were replayed more than once`);
 assert.equal(costs.length,hashes.length,`${when}: ${costs.length} cost events for ${hashes.length} confirmed receipts`);
 assert.deepEqual(new Set(costs),new Set(hashes),`${when}: cost events differ from confirmed receipts`);
 return {costEvents:costs.length};
}
async function verifyHolding(c,when){
 const cp=await inspector.campaign(c.campaignId),s=cp.state,pool=poolOf(c.row);
 assert.equal(cp.status,'active');assert.equal(s.phase,'holding');assert(s.activeTokenId!==null,`${when}: no active NFT`);
 const nft=await readNft(ctx.local,pool.positionManager,s.activeTokenId);
 assert.equal(nft.owner,ctx.wallet,`${when}: the NFT is not held by the shared wallet`);assert(nft.liquidity>0n,`${when}: the NFT has no liquidity`);
 const active=(await inspector.custodyOf(c.campaignId)).filter(n=>n.status==='active');
 assert.equal(active.length,1);assert.equal(active[0].tokenId,String(s.activeTokenId));assert.equal(active[0].liquidity,String(nft.liquidity));
 assert.equal((await inspector.allocationRow(c.campaignId)).state,'active');
 return {nft,state:s};
}
async function verifyOpened(c,{job,strict=false}){
 const {nft,state}=await verifyHolding(c,`open ${c.label}`);
 assert.equal((await inspector.jobRow(c.jobId)).status,'succeeded');
 const stages=await inspector.stagesOf(c.jobId);
 assert(stages.length>=2,`Expected at least swap and mint stages, got ${kindsOf(stages)}`);
 assert(stages.every(r=>r.status==='confirmed'&&r.canonical_receipt_json&&r.effect_evidence_json),'Every opening stage needs canonical receipt evidence');
 assert.equal(new Set(stages.map(r=>r.signed_raw_hash)).size,stages.length,'Opening transaction hashes must be unique');
 assert(kindsOf(stages).includes('mint'));
 assert.equal(state.economicActions,1);assert.equal(state.recenters,0);assert.deepEqual(state.retiredTokenIds,[]);
 const costs=await assertCostsAttributedOnce(c,`open ${c.label}`);
 const pattern=await allowanceChecks('stage_pattern',{when:`open ${c.label}`,stages,job,strict});
 const allowances=await allowanceChecks('in_policy',{when:`open ${c.label}`});
 const cleanup=await allowanceChecks('job_cleanup_proof',{when:`open ${c.label}`,stages});
 return {campaignId:c.campaignId,jobId:c.jobId,pool:poolOf(c.row).pool,fee:poolOf(c.row).fee,tokenId:String(state.activeTokenId),
  range:{tickLower:nft.tickLower,tickUpper:nft.tickUpper},liquidity:String(nft.liquidity),stageKinds:kindsOf(stages),
  txCount:stages.length,approvals:pattern.approvals,approvalAmounts:pattern.approvalAmounts,...costs,allowances,cleanup};
}

// ------------------------------------------------------------------------------------------ sibling isolation
let siblingBaseline=null;
const siblingChecks=[];
async function captureSibling(c){
 const fingerprint=await inspector.strategicFingerprint(c.campaignId);
 const tokenId=String((await inspector.campaign(c.campaignId)).state.activeTokenId);
 const nft=await readNft(ctx.local,poolOf(c.row).positionManager,tokenId);
 siblingBaseline={campaign:c,fingerprint,tokenId,nft:nft.raw,sequence:await inspector.lastSequence(c.campaignId)};
}
/** Sibling B must be untouched by every other campaign's receipts, cleanups, observations and exits. Planner and valuation
 * marks legitimately rewrite its observation fields, so we compare its strategic fingerprint, its on-chain NFT position and
 * require that only 'mark' events were appended since the baseline. */
async function checkSibling(when){
 try{
  const b=siblingBaseline;assert(b,'The sibling baseline was not captured');
  const now=await inspector.strategicFingerprint(b.campaign.campaignId);
  assert.deepEqual(now,b.fingerprint,`${when}: sibling strategic state, allocation, custody or job set changed`);
  const nft=await readNft(ctx.local,poolOf(b.campaign.row).positionManager,b.tokenId);
  assert.deepEqual(nft.raw,b.nft,`${when}: the sibling NFT position changed on chain`);
  const events=await inspector.eventsOf(b.campaign.campaignId,b.sequence);
  assert(events.every(e=>e.kind==='mark'),`${when}: the sibling received a non-observation event: ${events.map(e=>e.kind)}`);
  const allowances=await allowanceChecks('in_policy',{when:`${when} (every allowance is zero or within policy)`});
  const entry={when,marksSinceBaseline:events.length,tokenId:b.tokenId,liquidity:nft.raw[7],allowances};
  siblingChecks.push(entry);log('sibling_checked',entry);return entry;
 }catch(error){
  const o=outcome.get(7);
  if(selected.has(7)){o.status='FAIL';o.error=String(error?.stack??error).slice(0,1500);}
  throw error;
 }
}

// ------------------------------------------------------------------------------------------ chain-driven conditions
async function driftBelowRange(c,{margin=15}={}){
 const pool=poolOf(c.row),cp=await inspector.campaign(c.campaignId);
 const nft=await readNft(ctx.local,pool.positionManager,cp.state.activeTokenId);
 const before=await readSlot0(ctx.local,pool.pool);
 assert(before.tick>=nft.tickLower&&before.tick<nft.tickUpper,`${c.label}: pool tick ${before.tick} is not inside the held range`);
 const move=await ctx.mover.moveTickDownTo(pool,nft.tickLower-margin);
 await ctx.clock.tick();
 return {move,range:{tickLower:nft.tickLower,tickUpper:nft.tickUpper},tokenId:String(cp.state.activeTokenId)};
}
/** Wait for the real planner to enqueue a job of this kind; returns the live job, the frozen review and the observation trail.
 * A job rejected before its first stage (an expired frozen review) is recorded and waited past: the planner re-plans. */
async function waitForManagementJob(c,kind,{timeoutSec=1500}={}){
 const seq0=await inspector.lastSequence(c.campaignId),rejected=[];
 const job=await driver.driveUntil(`${kind} queued for ${c.label}`,async()=>{
  const jobs=await inspector.jobsOf(c.campaignId,kind);
  for(const j of jobs)if(['rejected','cancelled'].includes(j.status)&&!rejected.includes(j.id)){rejected.push(j.id);log('management_job_rejected',{label:c.label,jobId:j.id,status:j.status});}
  return jobs.filter(j=>!['rejected','cancelled'].includes(j.status)).at(-1)??false;
 },{timeoutSec,tickSeconds});
 const events=await inspector.eventsOf(c.campaignId,seq0);
 const review=await inspector.reviewOf((await inspector.jobRow(job.id)).review_id);
 return {job,events,payload:decodeBigints(review.payload),rejectedJobs:rejected};
}
const observationTrail=events=>events.filter(e=>e.payloadKind==='rangekeeper_live_management_observation_v1')
 .map(e=>({sequence:e.sequence,decision:e.decision,reason:e.reason,timestamp:e.sourceTimestamp}));
const driveJobUntil=(jobId,label,predicate,{timeoutSec=1500}={})=>driver.driveUntil(label,async()=>{
 const job=await inspector.jobRow(jobId);
 if(['rejected','cancelled'].includes(job?.status))throw new Error(`${label}: job ${jobId} is ${job.status}`);
 return predicate(job);
},{timeoutSec,tickSeconds:30});
const jobSucceeded=async job=>job?.status==='succeeded';
const confirmedKind=(jobId,kind)=>async()=>(await inspector.confirmedStagesOf(jobId)).some(s=>s.kind===kind);

/** Move the pool so the recenter candidate's swap no longer fits its approved range, re-anchor the persisted wallet snapshot
 * to that canonical state (the same re-anchor the worker maintenance performs) and let the real worker plan the next stage. */
async function induceStaleCandidate(c,jobId,label){
 const cp=await inspector.campaign(c.campaignId),candidate=cp.state.candidate,pool=poolOf(c.row);
 assert(candidate?.swap,`${label}: the frozen candidate has no swap, a price move cannot make it stale`);
 assert(cp.state.withdrawDone&&cp.state.activeTokenId===null&&!cp.state.swapDone,`${label}: stale induction requires a confirmed withdrawal and no swap yet`);
 assert.equal((await inspector.confirmedStagesOf(jobId)).filter(s=>s.kind==='withdraw').length,1);
 const before=await readSlot0(ctx.local,pool.pool);
 const move=await ctx.mover.moveTickDownTo(pool,Math.min(candidate.range.tickLower-15,before.tick-1));
 await ctx.clock.tick();
 await runtimeNow().observer.refreshWallet();
 const result=await driver.step(`${label}: stale step`);
 assert.equal(result.status,'blocked',JSON.stringify(result));
 assert.equal(result.reason,'stale_recenter_replan',JSON.stringify(result));
 const after=await inspector.campaign(c.campaignId);
 assert.equal(isRangeKeeperAwaitingReplan(after.state),true,`${label}: the campaign is not awaiting a re-plan`);
 assert.equal(after.state.candidate,null);assert.equal(after.state.withdrawDone,true);
 assert.equal((await inspector.confirmedStagesOf(jobId)).filter(s=>s.kind==='withdraw').length,1,`${label}: the confirmed withdrawal was repeated`);
 assert.equal((await inspector.jobRow(jobId)).status,'blocked');
 const events=await inspector.eventsOf(c.campaignId,0);
 assert(events.some(e=>e.payloadKind==='rangekeeper_live_management_settle_v1'&&e.action==='replan'),`${label}: no persisted replan settlement`);
 return {move,staleCandidateRange:candidate.range,poolTickBefore:before.tick,costEventsAtStale:after.state.costEvents.length,
  retiredAtStale:after.state.retiredTokenIds};
}
/** Passes until the real planner has re-planned a stale recenter from fresh observations (two confirmations). */
async function driveToReplan(c,label,{timeoutSec=900}={}){
 const seq0=await inspector.lastSequence(c.campaignId),firstPass=stats.plannerPasses.length;
 await driver.driveUntil(`${label}: planner re-plans`,async()=>{
  const events=await inspector.eventsOf(c.campaignId,seq0);
  if(events.some(e=>e.payloadKind==='rangekeeper_live_management_replan_v1'))return true;
  const recent=stats.plannerPasses.slice(Math.max(firstPass,stats.plannerPasses.length-8));
  if(recent.length>=8&&recent.every(p=>JSON.stringify(p.result??'').includes('source_gap')))
   throw Error(`${label}: the planner reports source_gap on every pass: a blocked recenter whose last campaign snapshot is older than maxObservationGapSeconds can no longer be re-planned or exited`);
  return false;
 },{timeoutSec,tickSeconds:15});
 const events=await inspector.eventsOf(c.campaignId,seq0);
 return {observations:observationTrail(events),replanEventSequence:events.find(e=>e.payloadKind==='rangekeeper_live_management_replan_v1')?.sequence};
}
async function closedCampaignChecks(c,jobId,{retired,when}){
 const {lifecycle,state}=await inspector.stateOf(c.campaignId);
 assert.equal(lifecycle,'closed',`${when}: the campaign is not closed`);
 assert.equal(state.phase,'closed');assert.equal(state.activeTokenId,null);
 assert.equal((await inspector.allocationRow(c.campaignId)).state,'released',`${when}: the allocation was not released`);
 assert.deepEqual(state.retiredTokenIds,retired,`${when}: retired NFTs are not recorded`);
 const custody=await inspector.custodyOf(c.campaignId);
 assert(custody.length>0&&custody.every(n=>n.status==='retired_empty'&&n.liquidity==='0'),`${when}: custody still lists a non-empty NFT`);
 for(const id of retired)assert.equal((await readNft(ctx.local,poolOf(c.row).positionManager,id)).liquidity,0n);
 const stages=await inspector.stagesOf(jobId);
 await assertCostsAttributedOnce(c,when);
 return {state,stages,custody};
}

// ------------------------------------------------------------------------------------------ flows
async function flowOpen(){
 await scenario(1,async ev=>{
  const B=await admitCampaign('B',{row:ctx.p3000,capitalQuoteRaw:'30000000'});
  await runOpenToHolding(B);
  ev.B=await verifyOpened(B,{job:'open_fresh_wallet'});
  await captureSibling(B);
  const A=await admitCampaign('A',{row:ctx.p500,capitalQuoteRaw:'50000000'});
  await runOpenToHolding(A);
  ev.A=await verifyOpened(A,{job:'open_shared_pair',strict:true});
  await checkSibling('after A opened');
  ev.httpAdmission={preflightPersisted:true,admission:'202',exactReplay:'200 identical result',executionEligible:false};
 });
}

/** Automatic recenter of A (scenario 2) with a lost publish acknowledgement and runtime restart mid-recenter (scenario 6),
 * then the action-budget safety exit that follows the second economic action. */
async function flowAutomaticRecenter(){
 const A=campaigns.A,pool=poolOf(A.row);
 const before=await inspector.strategicFingerprint(A.campaignId);
 const beforeState=(await inspector.campaign(A.campaignId)).state;
 const tokenBefore=String(beforeState.activeTokenId),allocationBefore=await inspector.allocationRow(A.campaignId);
 const liquidBefore=await inspector.allocationTokens(A.campaignId);
 let queued,drift,newTokenId;
 await scenario(2,async ev=>{
  drift=await driftBelowRange(A);ev.drift=drift;
  queued=await waitForManagementJob(A,'change_range');
  const {job,events,payload}=queued,trail=observationTrail(events);
  assert(String(job.idempotency_key).startsWith('rk-auto-recenter:'),`unexpected idempotency key ${job.idempotency_key}`);
  assert.equal(payload.operationKind,'change_range');assert.equal(payload.decision.reason,'two_confirmations');
  const exitSince=payload.policy.exit?.since;assert(Number.isSafeInteger(exitSince),'The frozen policy carries no outside-range persistence anchor');
  assert(payload.source.timestamp-exitSince>=300,`Outside-range persistence was only ${payload.source.timestamp-exitSince}s`);
  const confirm=events.filter(e=>e.decision==='confirm'&&e.reason==='first_confirmation').at(-1);
  assert(confirm,`No first confirmation was recorded: ${JSON.stringify(trail)}`);
  assert(Number(confirm.sourceBlock)<Number(payload.source.block),'The second confirmation did not use a later canonical observation');
  const spacing=payload.source.timestamp-confirm.sourceTimestamp;
  assert(spacing>=30&&spacing<=90,`The two confirmations are ${spacing}s apart, outside the 30-90 s window`);
  const tickAtDecision=payload.snapshot.tick;
  assert(payload.candidate.kind==='recenter'&&tickAtDecision>=payload.candidate.range.tickLower&&tickAtDecision<payload.candidate.range.tickUpper);
  assert.notEqual(payload.candidate.range.tickLower,drift.range.tickLower,'The recenter candidate kept the old range');
  Object.assign(ev,{jobId:job.id,plannerReasons:trail.map(t=>t.reason),persistenceSeconds:payload.source.timestamp-exitSince,
   confirmationSpacingSeconds:spacing,candidateRange:payload.candidate.range,candidateHasSwap:Boolean(payload.candidate.swap),
   idempotencyKey:job.idempotency_key});
 });
 const jobId=queued.job.id;
 if(selected.has(6))await scenario(6,async ev=>{
  faults.dropAckOnKind='mint';
  const mark=driver.trace.length;
  await driver.driveUntil('A recenter until the mint publish acknowledgement is lost',async()=>
   driver.trace.slice(mark).find(e=>e.jobId===jobId&&e.status==='blocked'&&/injected_owned_fork_publish_ack_loss/.test(e.reason??''))??false,
   {timeoutSec:1500,tickSeconds:30});
  const signed=(await inspector.stagesOf(jobId)).find(s=>s.status==='signed');
  assert(signed&&signed.kind==='mint'&&signed.signed_raw,'The lost acknowledgement did not leave the exact signed mint bytes durable');
  const signerBefore=stats.signerCalls,publishBefore=stats.publishCalls,walletBefore=await inspector.walletRow();
  // Process crash after the publisher accepted the bytes: a fresh composed runtime, the dead worker's fenced lease expired.
  factory.create('restart');
  await ctx.db.query(`UPDATE deployment_live_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='blocked'`,[jobId]);
  const recovered=await driver.step('A restart recovery');
  assert.equal(recovered.status,'reconciled',JSON.stringify(recovered));assert.equal(recovered.stage,signed.stage);
  const after=(await inspector.stagesOf(jobId)).find(s=>s.stage===signed.stage);
  assert.equal(after.signed_raw,signed.signed_raw,'Restart changed the signed bytes');assert.equal(after.signed_raw_hash,signed.signed_raw_hash);
  assert.equal(after.status,'confirmed');
  assert.equal(stats.signerCalls,signerBefore,'Restart signed a second transaction instead of recovering the exact bytes');
  assert.equal(stats.publishCalls,publishBefore,'A mined transaction was republished after restart');
  const receipt=await ctx.local.getTransactionReceipt({hash:signed.signed_raw_hash});
  assert.equal(receipt.status,'success');assert.equal(receipt.transactionHash.toLowerCase(),signed.signed_raw_hash.toLowerCase());
  const nonces=(await inspector.allOutbox()).filter(o=>o.status!=='cancelled').map(o=>o.nonce);
  assert.equal(new Set(nonces).size,nonces.length,'Wallet-wide transaction nonces collided');
  assert.deepEqual([...nonces].sort((a,b)=>a-b),nonces.map((_,i)=>ctx.baseNonce+i),'Wallet nonces are not contiguous from the wallet start nonce');
  const walletAfter=await inspector.walletRow();
  assert(Number(walletAfter.nonce)===Number(walletBefore.nonce)+1,'The wallet nonce did not advance exactly once for the recovered stage');
  Object.assign(ev,{walletStartNonce:ctx.baseNonce,lostStage:signed.stage,mintNonce:signed.nonce,signedHash:signed.signed_raw_hash,signerCallsUnchanged:true,
   publishCallsUnchanged:true,reconciledBlock:String(receipt.blockNumber),walletTransactions:nonces.length,
   staleLeaseRecovered:true,ackLosses:stats.ackLosses});
 });
 await scenario(2,async ev=>{
  await driveJobUntil(jobId,'A recenter job completes',jobSucceeded,{timeoutSec:1500});
  // Assert the post-recenter holding state before any further worker pass can queue the action-budget exit.
  const cp=await inspector.campaign(A.campaignId),s=cp.state;
  assert.equal(s.phase,'holding');assert(s.activeTokenId!==null);
  const stages=await inspector.stagesOf(jobId);
  assert(stages.every(r=>r.status==='confirmed'&&r.canonical_receipt_json&&r.effect_evidence_json),'A recenter stage lacks canonical receipt evidence');
  assert.equal(new Set(stages.map(r=>r.signed_raw_hash)).size,stages.length);
  const kinds=kindsOf(stages);
  assert.equal(kinds[0],'withdraw');assert.equal(kinds.filter(k=>k==='withdraw').length,1);
  const pattern=await allowanceChecks('stage_pattern',{when:'A recenter',stages,job:'recenter'});
  const cleanup=await allowanceChecks('job_cleanup_proof',{when:'A recenter',stages});
  const allowances=await allowanceChecks('in_policy',{when:'A recenter'});
  assert.notEqual(String(s.activeTokenId),tokenBefore,'The recenter reused the old NFT');
  newTokenId=String(s.activeTokenId);
  assert.equal(s.recenters,beforeState.recenters+1,'The campaign epoch did not advance by exactly one');
  assert.equal(s.economicActions,beforeState.economicActions+1);
  assert.deepEqual(s.retiredTokenIds,[tokenBefore],'The retired NFT is not recorded');
  assert.equal(s.candidate,null);assert.equal(s.swapDone,false);assert.equal(s.withdrawDone,false);assert.equal(s.reservedActionCost,0n);
  const oldNft=await readNft(ctx.local,pool.positionManager,tokenBefore),newNft=await readNft(ctx.local,pool.positionManager,s.activeTokenId);
  assert.equal(oldNft.liquidity,0n);assert.equal(oldNft.tokensOwed0,0n);assert.equal(oldNft.tokensOwed1,0n);
  assert.equal(newNft.owner,ctx.wallet);assert(newNft.liquidity>0n);
  const slot=await readSlot0(ctx.local,pool.pool);
  assert(slot.tick>=newNft.tickLower&&slot.tick<newNft.tickUpper,`Pool tick ${slot.tick} is outside the new range ${newNft.tickLower}..${newNft.tickUpper}`);
  assert.notDeepEqual([newNft.tickLower,newNft.tickUpper],[drift.range.tickLower,drift.range.tickUpper]);
  assert.deepEqual(cp.allocation.nftTokenIds,[String(s.activeTokenId)],'The allocation does not point at the new NFT only');
  const custody=await inspector.custodyOf(A.campaignId);
  assert.deepEqual(custody.map(n=>[n.tokenId,n.status]).sort(),[[tokenBefore,'retired_empty'],[String(s.activeTokenId),'active']].sort());
  assert.equal(custody.find(n=>n.tokenId===String(s.activeTokenId)).liquidity,String(newNft.liquidity));
  const allocationAfter=await inspector.allocationRow(A.campaignId);
  assert.notEqual(allocationAfter.allocation_hash,allocationBefore.allocation_hash,'The allocation hash did not change with the recenter');
  assert(Number(allocationAfter.source_generation)>Number(allocationBefore.source_generation));
  assert.notDeepEqual(await inspector.allocationTokens(A.campaignId),liquidBefore,'The allocation inventory did not settle the recenter');
  assert.equal(allocationAfter.state,'active');
  const costs=await assertCostsAttributedOnce(A,'A recenter');
  assert.equal(s.costEvents.length,before.state.costEvents.length+stages.length,'The recenter receipts were not each charged exactly once');
  assert.equal((await inspector.walletRow()).commitments_hash,liveWalletCommitmentFingerprint(await inspector.commitments()),'The wallet commitments fingerprint is stale');
  Object.assign(ev,{jobId,stageKinds:kinds,txCount:stages.length,oldTokenId:tokenBefore,newTokenId:String(s.activeTokenId),epoch:s.recenters,
   retiredTokenIds:s.retiredTokenIds,newRange:{tickLower:newNft.tickLower,tickUpper:newNft.tickUpper},newLiquidity:String(newNft.liquidity),
   poolTickAfter:slot.tick,costEventsTotal:costs.costEvents,allocationHashChanged:true,approvals:pattern.approvals,approvalAmounts:pattern.approvalAmounts,cleanup,allowances});
 });
 await checkSibling('after A recenter');
 // The campaign is now at its economic-action budget (open + one recenter): the planner exits it with a retained close.
 await scenario(2,async ev=>{
  const exitSeq=await inspector.lastSequence(A.campaignId);
  await driver.driveUntil('A action-budget safety exit closes',async()=>(await inspector.lifecycleOf(A.campaignId))==='closed',{timeoutSec:1500,tickSeconds});
  const closeJobs=await inspector.jobsOf(A.campaignId,'close_retain');
  assert.equal(closeJobs.length,1);
  const closed=await closedCampaignChecks(A,closeJobs[0].id,{retired:[tokenBefore,newTokenId],when:'A action-budget exit'});
  const exitPattern=await allowanceChecks('stage_pattern',{when:'A action-budget exit',stages:closed.stages,job:'close_beside_sibling'});
  await allowanceChecks('in_policy',{when:'A action-budget exit'});
  ev.actionBudgetExit={jobId:closeJobs[0].id,idempotencyKey:closeJobs[0].idempotency_key,stageKinds:kindsOf(closed.stages),siblingsKeptAllowances:exitPattern,
   observations:observationTrail(await inspector.eventsOf(A.campaignId,exitSeq)),retiredTokenIds:closed.state.retiredTokenIds,allocationReleased:true};
 });
 await checkSibling('after A closed');
}

/** Scenario 4: a recenter whose candidate goes stale after the confirmed withdraw is converted by the real planner into a
 * retained exit when a safety condition appears (the pool reentrancy lock, read from canonical slot0), then closes. */
async function flowConversion(){
 const X=await admitCampaign('X',{row:ctx.p500,capitalQuoteRaw:'50000000'});
 await runOpenToHolding(X);await verifyOpened(X,{job:'open_shared_pair'});
 const pool=poolOf(X.row);
 const tokenBefore=String((await inspector.campaign(X.campaignId)).state.activeTokenId);
 await scenario(4,async ev=>{
  const drift=await driftBelowRange(X);
  const queued=await waitForManagementJob(X,'change_range');
  const jobId=queued.job.id;
  await driveJobUntil(jobId,'X recenter until the withdraw is confirmed',confirmedKind(jobId,'withdraw'));
  ev.stale=await induceStaleCandidate(X,jobId,'X');
  const stateAtStale=(await inspector.campaign(X.campaignId)).state;
  await setPoolLocked(ctx.fork,ctx.local,pool.pool,true);
  let result=null;const attempts=[];
  try{
   await ctx.clock.tick();
   await runtimeNow().observer.refreshWallet();
   for(let attempt=0;attempt<3&&!result?.converted;attempt++){
    result=await runtimeNow().planner.planCampaign(X.campaignId);
    attempts.push({status:result.status,reason:result.reason,converted:result.converted??false});
    if(!result.converted){await ctx.clock.tick();await runtimeNow().observer.refreshWallet();}
   }
  }finally{await setPoolLocked(ctx.fork,ctx.local,pool.pool,false);}
  assert(result?.converted===true,`The planner did not convert the recenter to a retained exit: ${JSON.stringify(attempts)}`);
  assert.equal(result.reason,'recenter_converted_to_retain_exit');
  await ctx.clock.tick();
  const converted=(await inspector.campaign(X.campaignId)).state;
  assert.equal(isRangeKeeperRetainedExit(converted),true,'A safety exit must outrank the recenter in progress');
  assert.equal(converted.activeTokenId,null);assert.equal(converted.candidate,null);assert.deepEqual(converted.retiredTokenIds,[tokenBefore]);
  assert.equal(converted.costEvents.length,stateAtStale.costEvents.length,'The conversion changed attributed costs');
  assert((await inspector.eventsOf(X.campaignId,0)).some(e=>e.payloadKind==='rangekeeper_live_management_exit_conversion_v1'),
   'The conversion was not persisted as a campaign event');
  await driveJobUntil(jobId,'X converted exit completes',jobSucceeded);
  await driver.driveUntil('X closed',async()=>(await inspector.lifecycleOf(X.campaignId))==='closed',{timeoutSec:600,tickSeconds});
  const closed=await closedCampaignChecks(X,jobId,{retired:[tokenBefore],when:'X converted exit'});
  assert.equal(kindsOf(closed.stages).filter(k=>k==='withdraw').length,1,'The converted exit repeated the withdrawal');
  assert(!kindsOf(closed.stages).includes('swap')&&!kindsOf(closed.stages).includes('mint'),'The converted exit traded or minted');
  const exitPattern=await allowanceChecks('stage_pattern',{when:'X converted exit',stages:closed.stages,job:'close_beside_sibling'});
  const allowances=await allowanceChecks('in_policy',{when:'X converted exit'});
  const cleanup=await allowanceChecks('job_cleanup_proof',{when:'X converted exit',stages:closed.stages});
  assert.equal((await inspector.jobRow(jobId)).status,'succeeded');
  Object.assign(ev,{conversion:{jobId,attempts,stageKinds:kindsOf(closed.stages),retired:closed.state.retiredTokenIds,allocationReleased:true,
   condition:'pool_reentrancy_lock_read_from_slot0',lockRestored:(await readSlot0(ctx.local,pool.pool)).unlocked,siblingKeptAllowances:exitPattern},drift,allowances,cleanup});
 });
 await checkSibling('after X converted');
}

/** Scenarios 3 and 5 (and the scenario-7 allowance probe): S goes stale after its confirmed withdraw and stays blocked while the
 * operator retains sibling B through the HTTP routes; B's exit outranks the blocked recenter and, beside a same-token sibling,
 * only withdraws, leaving every persisted allowance untouched. S then re-plans from fresh observations (the planner's
 * continuity anchor was re-established after the long sibling job) and completes; its close, as the last user of the token
 * pairs, withdraws and zeroes each non-zero pair. */
async function flowStaleReplan(){
 const S=await admitCampaign('S',{row:ctx.p500,capitalQuoteRaw:'50000000'});
 await runOpenToHolding(S);await verifyOpened(S,{job:'open_shared_pair'});
 const B=campaigns.B,pool=poolOf(S.row);
 const tokenBefore=String((await inspector.campaign(S.campaignId)).state.activeTokenId);
 let jobId,probeBefore=null;
 await scenario(3,async ev=>{
  const drift=await driftBelowRange(S);
  const queued=await waitForManagementJob(S,'change_range');
  jobId=queued.job.id;
  await driveJobUntil(jobId,'S recenter until the withdraw is confirmed',confirmedKind(jobId,'withdraw'));
  const costsAtWithdraw=(await inspector.campaign(S.campaignId)).state.costEvents.length;
  ev.stale=await induceStaleCandidate(S,jobId,'S stale');
  assert.equal(ev.stale.costEventsAtStale,costsAtWithdraw,'A stale settlement changed attributed costs');
  probeBefore=(await allowanceChecks('observe')).nonZero;
  assert(probeBefore.length>0,'The wallet must hold persisted allowances while S is blocked');
  Object.assign(ev,{drift,jobId,persistedAllowancesWhileBlocked:probeBefore.map(p=>`${p.label}=${p.amount}`)});
 });
 // Operator retain of B while S is blocked: HTTP preview, operation, exact replay, exit priority over the blocked recenter.
 const beforeS=await inspector.strategicFingerprint(S.campaignId);
 await scenario(5,async ev=>{
  await checkSibling('before operator retain');
  await ctx.clock.tick();
  const preview=await post(`/api/deployments/${B.campaignId}/live/retain-preview`,{});
  assert.equal(preview.status,200);assert.equal(preview.body.status,'indicative',JSON.stringify(preview.body));
  assert.equal(preview.body.actionAvailable,true);assert.equal(preview.body.executionEligible,false);
  const input={previewId:preview.body.previewId,contentDigest:preview.body.contentDigest,expectedRevision:preview.body.expectedRevision,idempotencyKey:randomUUID()};
  const path=`/api/deployments/${B.campaignId}/live/retain-operations`;
  const accepted=await post(path,input);assert.equal(accepted.status,202,JSON.stringify(accepted.body));
  const bJobId=accepted.body.jobId;
  const replay=await post(path,input);assert.equal(replay.status,200);assert.equal(replay.body.jobId,bJobId,'Exact replay did not return the same job');
  const sStagesBefore=(await inspector.stagesOf(jobId)).length,mark=driver.trace.length;
  await driveJobUntil(bJobId,'B operator retain completes',jobSucceeded);
  assert(driver.trace.slice(mark).every(e=>e.jobId===null||e.jobId===bJobId),'The retained exit did not run ahead of the blocked recenter');
  assert.equal((await inspector.stagesOf(jobId)).length,sStagesBefore,'The blocked recenter advanced while the exit held the wallet');
  await driver.driveUntil('B closed',async()=>(await inspector.lifecycleOf(B.campaignId))==='closed',{timeoutSec:600,tickSeconds});
  const {state:bState,stages:bStages}=await closedCampaignChecks(B,bJobId,{retired:[siblingBaseline.tokenId],when:'B operator retain'});
  assert(bStages.length>=1&&bStages.every(r=>r.status==='confirmed'),'Retain receipts are incomplete');
  const pattern=await allowanceChecks('stage_pattern',{when:'B operator retain',stages:bStages,job:'close_beside_sibling'});
  assert.equal(bState.costEvents.length,(await inspector.confirmedStagesOf(B.jobId)).length+bStages.length,'Retain receipt costs were omitted or duplicated');
  const replayAfter=await post(path,input);assert.equal(replayAfter.status,200);assert.equal(replayAfter.body.jobId,bJobId,'A closed campaign retry created a new job');
  await allowanceChecks('in_policy',{when:'after B operator retain'});
  const probe=await allowanceChecks('sibling_probe',{before:probeBefore,after:(await allowanceChecks('observe')).nonZero});
  Object.assign(ev,{previewId:input.previewId,jobId:bJobId,stageKinds:kindsOf(bStages),txCount:bStages.length,closed:true,allocationReleased:true,
   replayBeforeCompletion:true,replayAfterClosure:true,retiredTokenIds:bState.retiredTokenIds,approvals:pattern.approvals,
   retainedExitRanAheadOfBlockedRecenter:true,blockedRecenterStageCountUnchanged:true,allowanceProbe:probe});
  evidence(7).allowanceProbe=probe;
 });
 let nonZeroBeforeLastClose=0;
 await scenario(3,async ev=>{
  const afterS=await inspector.strategicFingerprint(S.campaignId);
  assert.deepEqual(afterS.state,beforeS.state,"The sibling's exit changed the blocked recenter's campaign state");
  ev.replan=await driveToReplan(S,'S replan');
  await driveJobUntil(jobId,'S recenter job completes',jobSucceeded,{timeoutSec:1500});
  const cp=await inspector.campaign(S.campaignId),s=cp.state,stages=await inspector.stagesOf(jobId);
  assert.equal(s.phase,'holding');assert(s.activeTokenId!==null);assert.notEqual(String(s.activeTokenId),tokenBefore);
  assert.equal(kindsOf(stages).filter(k=>k==='withdraw').length,1,'The confirmed withdrawal was repeated');
  assert(stages.every(r=>r.status==='confirmed'),'Every stage of the re-planned recenter needs a confirmed receipt');
  const pattern=await allowanceChecks('stage_pattern',{when:'S recenter',stages,job:'recenter'});
  assert.equal(s.recenters,1);assert.deepEqual(s.retiredTokenIds,[tokenBefore]);
  assert.equal(s.candidate,null);assert.equal(s.withdrawDone,false);assert.equal(s.swapDone,false);
  const events=await inspector.eventsOf(S.campaignId,0);
  assert.equal(events.filter(e=>e.payloadKind==='rangekeeper_live_management_replan_v1').length,1,'Expected exactly one persisted re-plan');
  assert.equal(events.filter(e=>e.payloadKind==='rangekeeper_live_management_settle_v1'&&e.action==='replan').length,1);
  const nft=await readNft(ctx.local,pool.positionManager,s.activeTokenId);
  assert.equal(nft.owner,ctx.wallet);assert(nft.liquidity>0n);
  const costs=await assertCostsAttributedOnce(S,'S recenter');
  const cleanup=await allowanceChecks('job_cleanup_proof',{when:'S recenter',stages});
  const allowances=await allowanceChecks('in_policy',{when:'S recenter'});
  nonZeroBeforeLastClose=allowances.nonZero.length;
  Object.assign(ev,{stageKinds:kindsOf(stages),txCount:stages.length,newTokenId:String(s.activeTokenId),retired:s.retiredTokenIds,epoch:s.recenters,
   withdrawStages:1,approvals:pattern.approvals,approvalAmounts:pattern.approvalAmounts,costEvents:costs.costEvents,cleanup,allowances});
 });
 // S is now the last active user of the shared token/router/manager pairs: its action-budget exit withdraws and zeroes each non-zero pair.
 const lastExitSeq=await inspector.lastSequence(S.campaignId);
 await driver.driveUntil('S action-budget safety exit closes',async()=>(await inspector.lifecycleOf(S.campaignId))==='closed',{timeoutSec:1500,tickSeconds});
 const closeJobs=await inspector.jobsOf(S.campaignId,'close_retain');
 assert.equal(closeJobs.length,1);
 const lastClose=await closedCampaignChecks(S,closeJobs[0].id,{retired:[tokenBefore,String((await inspector.stateOf(S.campaignId)).state.retiredTokenIds[1])],when:'S last-user close'});
 const lastPattern=await allowanceChecks('stage_pattern',{when:'S last-user close',stages:lastClose.stages,job:'close_last_user',nonZeroBefore:nonZeroBeforeLastClose});
 await allowanceChecks('job_cleanup_proof',{when:'S last-user close',stages:lastClose.stages,expectAllZero:true});
 await allowanceChecks('all_zero',{when:'S last-user close'});
 evidence(7).lastUserClose={jobId:closeJobs[0].id,stageKinds:kindsOf(lastClose.stages),zeroApprovals:lastPattern.approvals,nonZeroBefore:nonZeroBeforeLastClose,
  observations:observationTrail(await inspector.eventsOf(S.campaignId,lastExitSeq))};
}

async function finalChecks(){
 await scenario(7,async ev=>{
  Object.assign(ev,{siblingChecks});
  assert(siblingChecks.length>=3,'Too few sibling checkpoints were recorded');
  const outbox=await inspector.allOutbox(),nonces=outbox.filter(o=>o.status!=='cancelled').map(o=>o.nonce);
  assert.equal(new Set(nonces).size,nonces.length);assert.deepEqual([...nonces].sort((a,b)=>a-b),nonces.map((_,i)=>ctx.baseNonce+i));
  assert(outbox.every(o=>o.status==='confirmed'||o.status==='cancelled'),'Unresolved stage rows remain');
  const wallet=await inspector.walletRow();
  assert.equal(wallet.nonce,String(ctx.baseNonce+nonces.length));assert.equal(wallet.pending_nonce,wallet.nonce);
  const commitments=await inspector.commitments();
  assert.equal(wallet.commitments_hash,liveWalletCommitmentFingerprint(commitments));
  assert.equal(commitments.allocations.length,0,'An allocation remains reserved after every campaign closed');
  ev.finalAllowances=await allowanceChecks('all_zero',{when:'final (every campaign is closed)'});
  ev.walletTransactions=nonces.length;
  assert(ev.allowanceProbe,'The allowance probe did not run');
 });
}

// ------------------------------------------------------------------------------------------ main
/** `--print-plan` needs no network, database or fork: it prints what a run would do so the plan can be reviewed offline. */
function printPlan(){
 const flows=[['open',[1,2,3,4,5,6,7],'B (AAPL fee 3000, 30 USDG) then A (AAPL fee 500, 50 USDG): HTTP preflight + admission + replay, worker to holding'],
  ['recenter',[2,6],'drift A below its range, real planner persistence (>=300 s) and two confirmations (30-90 s apart), change_range job; lost mint publish ack + runtime rebuild + expired lease; action-budget retained exit'],
  ['conversion',[4],'open X (fee 500); stale candidate after the confirmed withdraw; pool lock read from slot0; planner converts the recenter to a retained exit; closes'],
  ['stale',[3,5,7],'open S (fee 500); stale after the confirmed withdraw; operator HTTP retain of B outranks the blocked recenter and leaves S\'s persisted allowances untouched; S re-plans and completes; its last-user close zeroes each non-zero pair']];
 console.log(JSON.stringify({event:'rangekeeper_management_fork_plan',selectedScenarios:[...selected],tickSeconds,liquiditySharePpm,archiveEnvName,
  timeModel:'wall clock (every canonical source must be recent); expect roughly 60-90 minutes for all scenarios',
  flows:flows.filter(([,scenarios])=>scenarios.some(n=>selected.has(n))).map(([flow,scenarios,does])=>({flow,scenarios,does})),
  allowancePolicy:ALLOWANCE_POLICY,
  safety:{signer:'throwaway key, never production',publisher:'branded owned fork only (assertOwnedPaperFork before every sign/publish)',upstream:'read-only pinned reads',database:'isolated schema in TEST_DATABASE_URL only'}},null,1));
}
async function main(){
 if(args.includes('--print-plan')){printPlan();return;}
 try{
  ctx=await bootstrapManagementFork({envFile,testUrl:process.env.TEST_DATABASE_URL,archiveEnvName,buildId,log,
   operatorConfigPath:'config/rangekeeper-v1-aapl-disabled.json'});
 }catch(error){
  if(error instanceof UpstreamBlockedError){
   console.log(JSON.stringify({event:'rangekeeper_management_fork_blocked',blocked:true,reason:error.message,detail:error.detail,
    scenarios:Object.fromEntries([...outcome].map(([n,o])=>[n,{name:o.name,status:selected.has(n)?'BLOCKED':'SKIPPED'}]))}));
   process.exitCode=2;return;
  }
  throw error;
 }
 let aborted=null;
 try{
  inspector=createInspector({db:ctx.db,wallet:ctx.wallet});
  stats=createExecutionStats();faults={dropAckOnKind:null};
  factory=createManagementRuntimeFactory({ctx,stats,faults,log});
  factory.create('primary');
  driver=createDriver({clock:ctx.clock,getRuntime:runtimeNow,log,defaultTickSeconds:tickSeconds});
  log('bootstrapped',{wallet:ctx.wallet,schema:ctx.schema,funding:ctx.funding,source:ctx.source,localSource:ctx.localSource});
  const flows=[['open',flowOpen,[1,2,3,4,5,6,7]],['recenter',flowAutomaticRecenter,[2,6]],['conversion',flowConversion,[4]],['stale',flowStaleReplan,[3,5,7]]];
  for(const [flowName,flow,scenarios] of flows){
   if(aborted||!scenarios.some(n=>selected.has(n)))continue;
   try{await flow();}catch(error){aborted={flowName,error};log('flow_aborted',{flow:flowName,error:String(error?.stack??error).slice(0,1500)});}
  }
  if(!aborted&&selected.has(7))await finalChecks().catch(error=>{aborted={flowName:'final',error};});
 }catch(error){aborted={flowName:'harness',error};log('harness_error',{error:String(error?.stack??error).slice(0,2000)});}
 finally{
  if(aborted)for(const [,o] of outcome)if(o.status==='NOT_REACHED')o.error=`not reached: ${aborted.flowName} aborted (${String(aborted.error?.message??aborted.error).slice(0,300)})`;
  const report={event:'rangekeeper_management_fork_report',chainId:4663,wallet:ctx?.wallet,schema:ctx?.schema,
   elapsedSeconds:Math.round((Date.now()-startedAt)/1000),scenarios:Object.fromEntries([...outcome].map(([n,o])=>[n,o])),
   allowancePolicy:ALLOWANCE_POLICY,execution:{signerCalls:stats?.signerCalls,publishCalls:stats?.publishCalls,ackLosses:stats?.ackLosses,
    signedTransactions:stats?.signed.length,publishedTransactions:stats?.published.length},
   plannerPasses:stats?.plannerPasses.length,workerSteps:driver?.trace.length,
   upstream:{forkReads:ctx?.fork?.budget,diagnostics:ctx?.fork?.diagnostics,archiveClientRequests:ctx?.counters.archive,
    publicClientRequests:ctx?.counters.public,upstreamMutations:0,
    boundary:{signer:'synthetic_local_account_only',publisher:'branded_owned_fork_only',upstreamClient:'read_only'}},
   funding:ctx?.funding,campaigns:Object.fromEntries(Object.entries(campaigns).map(([k,c])=>[k,{campaignId:c.campaignId,jobId:c.jobId,
    pool:poolOf(c.row).pool,fee:poolOf(c.row).fee}]))};
  console.log(JSON.stringify(jsonSafe(report)));
  if([...outcome.values()].some(o=>o.status==='FAIL'||o.status==='NOT_REACHED'))process.exitCode=1;
  if(ctx)await ctx.close();
 }
}
await main();
