import {getAddress,isAddress} from 'viem';
import {z} from 'zod';
import {allocationSchema,contentHash,rangeKeeperParameters,staticManualParameters} from './contracts.js';
import {marketProfileSchema,type MarketProfile} from './market-profile.js';
import {isCanonicalPositiveReferenceAmount} from './live-independent-reference-evidence.js';

const strategyIds=['static_manual_v1','rangekeeper_v1'] as const;
type StrategyId=typeof strategyIds[number];
type Check={name:string;status:'matched'|'mismatch'|'unavailable'|'not_applicable';reason?:string};
const raw=z.string().regex(/^(0|[1-9][0-9]*)$/);
const address=z.string().refine(isAddress);
const inputSchema=z.object({draft:z.object({id:z.string().min(1),revision:z.number().int().positive(),
 mode:z.enum(['paper','live']),strategyId:z.enum(strategyIds),wallet:address,chainId:z.number().int().positive(),
 profile: z.unknown(),profileHash:z.string().regex(/^[0-9a-f]{64}$/),config:z.unknown(),
 configHash:z.string().regex(/^[0-9a-f]{64}$/),allocation:allocationSchema}).strict(),
 custodySnapshot:z.unknown(),nftCustodyEnumeration:z.unknown().optional(),poolRuntimeIdentity:z.unknown().optional(),
 independentReferenceEvidence:z.unknown().optional(),journalDiagnostic:z.unknown()}).strict();

function record(value:unknown):Record<string,unknown>|null{
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function check(name: string,status:Check['status'],reason?:string):Check{return {name,status,...(reason?{reason}:{})};}
function arrayField<T=Record<string,unknown>>(value:unknown):T[]{return Array.isArray(value)?value as T[]:[];}
function fieldAvailable(value:unknown):value is {status:'available';value:unknown}{
 const row=record(value);return row?.status==='available'&&'value'in row;
}
function completeNftEnumerationMatches(value:unknown,strategy:StrategyId,operator:string,manager:string|null,
 source:Record<string,unknown>|null,snapshotCount:unknown):boolean{
 const row=record(value),boundSource=record(row?.source),count=record(row?.balanceOfCount),coverage=record(row?.indexedTransferCoverage);
 const snapshotCountField=record(snapshotCount);
 if(!row||row.kind!=='complete_position_manager_nft_custody'||row.status!=='available'||
  row.enumerationComplete!==true||row.actionAvailable!==false||row.executionEligible!==false||
  row.targetStrategyId!==strategy||typeof row.operator!=='string'||!same(row.operator,operator)||
  !manager||typeof row.positionManager!=='string'||!same(row.positionManager,manager)||
  boundSource?.confirmed!==true||source?.confirmed!==true||boundSource.block!==source.block||
  typeof boundSource.hash!=='string'||typeof source.hash!=='string'||!same(boundSource.hash,source.hash)||
  boundSource.timestamp!==source.timestamp||count?.status!=='available'||typeof count.value!=='string'||
  !raw.safeParse(count.value).success||coverage?.status!=='available'||coverage.startBlock!=='0'||
  typeof coverage.coveredThroughBlock!=='string'||!raw.safeParse(coverage.coveredThroughBlock).success||
  BigInt(coverage.coveredThroughBlock)<BigInt(String(source.block??'0'))||
  typeof coverage.sourceCheckpointHash!=='string'||!same(coverage.sourceCheckpointHash,source.hash)||
  !Number.isSafeInteger(coverage.transferCount)||Number(coverage.transferCount)<0||
  !Number.isSafeInteger(coverage.checkpointBlockCount)||Number(coverage.checkpointBlockCount)<1||
  !Array.isArray(row.tokenIds)||!Array.isArray(row.knownOwners)||row.missing!==undefined&&
  (!Array.isArray(row.missing)||row.missing.length!==0)||snapshotCountField?.status!=='available'||
  typeof snapshotCountField.value!=='string'||snapshotCountField.value!==count.value)return false;
 const tokenIds=row.tokenIds as unknown[],owners=row.knownOwners as unknown[];
 if(tokenIds.some(id=>typeof id!=='string'||!raw.safeParse(id).success)||
  new Set(tokenIds).size!==tokenIds.length||owners.length!==tokenIds.length||
  BigInt(count.value)!==BigInt(tokenIds.length))return false;
 const ownerById=new Map<string,string>();
 for(const item of owners){const ownerRow=record(item),owner=record(ownerRow?.owner);
  if(typeof ownerRow?.tokenId!=='string'||owner?.status!=='available'||typeof owner.value!=='string'||
   !isAddress(owner.value)||!same(owner.value,operator)||ownerById.has(ownerRow.tokenId))return false;
  ownerById.set(ownerRow.tokenId,owner.value);
 }
 return tokenIds.every(id=>typeof id==='string'&&ownerById.has(id));
}
function poolRuntimeIdentityMatches(value:unknown,strategy:StrategyId,profileHash:string,
 profile:MarketProfile,source:Record<string,unknown>|null):boolean{
 const row=record(value),runtimeSource=record(row?.source),hashes=record(row?.contractHashes);
 const pool=profile.pool;
 return Boolean(row?.kind==='live_pool_runtime_identity'&&row.status==='available'&&
  row.targetStrategyId===strategy&&row.profileHash===profileHash&&row.actionAvailable===false&&
  Array.isArray(row.missing)&&row.missing.length===0&&runtimeSource?.confirmed===true&&
  source?.confirmed===true&&runtimeSource.block===source.block&&typeof runtimeSource.hash==='string'&&
  typeof source.hash==='string'&&same(runtimeSource.hash,source.hash)&&runtimeSource.timestamp===source.timestamp&&
  hashes&&typeof hashes.poolCodeHash==='string'&&same(hashes.poolCodeHash,pool.poolCodeHash)&&
  typeof hashes.token0CodeHash==='string'&&same(hashes.token0CodeHash,pool.token0CodeHash)&&
  typeof hashes.token1CodeHash==='string'&&same(hashes.token1CodeHash,pool.token1CodeHash)&&
  typeof hashes.managerCodeHash==='string'&&same(hashes.managerCodeHash,pool.managerCodeHash)&&
  typeof hashes.quoterCodeHash==='string'&&same(hashes.quoterCodeHash,pool.quoterCodeHash));
}
function independentReferenceMatches(value:unknown,strategy:StrategyId,profileHash:string,
 profile:MarketProfile,source:Record<string,unknown>|null):boolean{
 const row=record(value),boundSource=record(row?.source),references=record(row?.references);
 const policyHash=contentHash(profile.referencePolicy);
 return Boolean(row?.kind==='live_independent_reference_evidence'&&row.status==='available'&&
  row.targetStrategyId===strategy&&row.profileHash===profileHash&&row.referencePolicyHash===policyHash&&
  row.actionAvailable===false&&Array.isArray(row.reasons)&&row.reasons.length===0&&
  Array.isArray(row.missing)&&row.missing.length===0&&boundSource?.confirmed===true&&source?.confirmed===true&&
  boundSource.block===source.block&&typeof boundSource.hash==='string'&&typeof source.hash==='string'&&
  same(boundSource.hash,source.hash)&&boundSource.timestamp===source.timestamp&&
  Number.isSafeInteger(row.validUntil)&&typeof row.validUntil==='number'&&row.validUntil>Date.now()/1000&&
  typeof source.timestamp==='number'&&row.validUntil<=source.timestamp+180&&
  references&&isCanonicalPositiveReferenceAmount(references.token0)&&
  isCanonicalPositiveReferenceAmount(references.token1)&&isCanonicalPositiveReferenceAmount(references.native)&&
  references.reference0===profile.pool.reference0&&references.reference1===profile.pool.reference1&&
  references.nativeReference===profile.pool.nativeReference&&references.numeraire===profile.pool.numeraire&&
  typeof references.proofHash==='string'&&/^[0-9a-f]{64}$/.test(references.proofHash));
}

/** Join a saved deployment identity with custody and legacy-journal evidence.
 * This is a diagnostic composer only: it never evaluates strategy admission,
 * creates intents, loads a signer, or enables an action. */
export function composeLiveStrategyPreflightEvidence(input:unknown){
 const parsed=inputSchema.safeParse(input);
 if(!parsed.success)return {kind:'live_strategy_preflight_evidence' as const,status:'unavailable' as const,
  strategyId:null,campaignId:null,revision:null,checks:[],journal:{status:'unavailable',blockers:[]},
  missing:['saved_strategy_binding_invalid'],actionAvailable:false as const,executionEligible:false as const};
 const {draft,custodySnapshot:rawSnapshot,journalDiagnostic:rawJournal,nftCustodyEnumeration,poolRuntimeIdentity,
  independentReferenceEvidence}=parsed.data;
 const strategyId=draft.strategyId as StrategyId,poolProfile=marketProfileSchema.safeParse(draft.profile),
  allocation=allocationSchema.safeParse(draft.allocation);
 const checks:Check[]=[],missing:string[]=[];
 const addMissing=(reason:string)=>{if(!missing.includes(reason))missing.push(reason);};
 let profileHashValid=false,configHashValid=false,limitsValid=false;
 if(!poolProfile.success){checks.push(check('saved_profile','mismatch','saved_profile_schema_invalid'));addMissing('saved_profile_schema_invalid');}
 else if(contentHash(poolProfile.data)!==draft.profileHash){
  checks.push(check('saved_profile','mismatch','saved_profile_hash_mismatch'));addMissing('saved_profile_hash_mismatch');
 }else{profileHashValid=true;checks.push(check('saved_profile','matched'));}
 const parameters=strategyId==='static_manual_v1'?staticManualParameters.safeParse(draft.config):
  rangeKeeperParameters.safeParse(draft.config);
 if(!parameters.success){
  checks.push(check('saved_strategy_config','mismatch','saved_strategy_config_invalid'));
  addMissing('saved_strategy_config_invalid');
 }else{
  const normalized={...parameters.data,strategyId,strategyVersion:'1.0.0',stateSchemaVersion:1};
  if(contentHash(normalized)!==draft.configHash){
   checks.push(check('saved_strategy_config','mismatch','saved_strategy_config_hash_mismatch'));
   addMissing('saved_strategy_config_hash_mismatch');
  }else{configHashValid=true;checks.push(check('saved_strategy_config','matched'));}
  const limits=record(parameters.data.limits);
  limitsValid=Boolean(limits&&Object.keys(limits).length>0);
  if(limitsValid)checks.push(check('saved_strategy_limits','matched'));
  else{checks.push(check('saved_strategy_limits','unavailable','saved_strategy_limits_missing'));
   addMissing('saved_strategy_limits_missing');}
 }
 if(!poolProfile.success){
  for(const name of ['chain','pool_identity','manager_identity','token_scope','allowance_scope','independent_reference_source'])
   checks.push(check(name,'unavailable','profile_unavailable'));
 }else{
  const p=poolProfile.data.pool;
  checks.push(check('chain',p.chainId===draft.chainId&&draft.chainId===4663?'matched':'mismatch',
   p.chainId===draft.chainId&&draft.chainId===4663?undefined:'saved_chain_identity_mismatch'));
  if(p.chainId!==draft.chainId||draft.chainId!==4663)addMissing('saved_chain_identity_mismatch');
  checks.push(check('pool_identity',profileHashValid?'matched':'mismatch',
   profileHashValid?undefined:'saved_profile_not_integrity_bound'));
  checks.push(check('manager_identity',profileHashValid?'matched':'mismatch',
   profileHashValid?undefined:'saved_manager_profile_not_integrity_bound'));
  const runtime=poolRuntimeIdentity??record(rawSnapshot)?.poolRuntimeIdentity;
  const runtimeMatches=poolRuntimeIdentityMatches(runtime,strategyId,draft.profileHash,poolProfile.data,
   record(rawSnapshot)?.source?record(record(rawSnapshot)?.source):null);
  checks.push(check('pool_runtime_identity',runtimeMatches?'matched':'unavailable',
   runtimeMatches?undefined:'pool_code_and_factory_relations_not_rechecked_at_snapshot_source'));
  if(!runtimeMatches){
   addMissing('pool_code_and_factory_relations_not_rechecked_at_snapshot_source');
   const runtimeMissing=record(runtime)?.missing;
   if(Array.isArray(runtimeMissing))for(const reason of runtimeMissing)
    if(typeof reason==='string')addMissing(reason);
  }
  const independent=independentReferenceEvidence??record(rawSnapshot)?.independentReferenceEvidence;
  const referenceMatches=independentReferenceMatches(independent,strategyId,draft.profileHash,poolProfile.data,
   record(record(rawSnapshot)?.source));
  checks.push(check('independent_reference_source',referenceMatches?'matched':'unavailable',
   referenceMatches?undefined:'independent_reference_policy_not_verified_at_snapshot_source'));
  if(!referenceMatches){
   addMissing('independent_reference_policy_not_verified_at_snapshot_source');
   const referenceMissing=record(independent)?.missing;
   if(Array.isArray(referenceMissing))for(const reason of referenceMissing)
    if(typeof reason==='string')addMissing(reason);
  }
 }
 const snapshot=record(rawSnapshot),journal=record(rawJournal);
 const operator=getAddress(draft.wallet),profile=poolProfile.success?poolProfile.data:null;
 if(!snapshot){
  for(const name of ['snapshot_strategy','snapshot_operator','snapshot_chain','snapshot_source','token_balances',
   'allowances','nft_custody'])checks.push(check(name,'unavailable','custody_snapshot_missing'));
  addMissing('custody_snapshot_missing');
 }else{
  const snapshotIntegrity=snapshot.kind==='live_custody_snapshot'&&snapshot.status==='snapshot_partial'&&
   snapshot.actionAvailable===false&&snapshot.executionEligible===false;
  checks.push(check('snapshot_integrity',snapshotIntegrity?'matched':'mismatch',
   snapshotIntegrity?undefined:'custody_snapshot_shape_or_safety_flags_invalid'));
  if(!snapshotIntegrity)addMissing('custody_snapshot_shape_or_safety_flags_invalid');
  const snapshotStrategy=snapshot.targetStrategyId;
  checks.push(check('snapshot_strategy',snapshotStrategy===strategyId?'matched':'mismatch',
   snapshotStrategy===strategyId?undefined:'custody_snapshot_strategy_mismatch'));
  if(snapshotStrategy!==strategyId)addMissing('custody_snapshot_strategy_mismatch');
  checks.push(check('snapshot_operator',typeof snapshot.operator==='string'&&same(snapshot.operator,operator)?'matched':'mismatch',
   typeof snapshot.operator==='string'&&same(snapshot.operator,operator)?undefined:'custody_snapshot_wallet_mismatch'));
  if(typeof snapshot.operator!=='string'||!same(snapshot.operator,operator))addMissing('custody_snapshot_wallet_mismatch');
  const chainField=record(snapshot.chainId),chainValue=fieldAvailable(chainField)?chainField.value:null;
  const chainMatches=chainValue===draft.chainId&&draft.chainId===4663;
  checks.push(check('snapshot_chain',chainMatches?'matched':'mismatch',chainMatches?undefined:'custody_snapshot_chain_mismatch'));
  if(!chainMatches)addMissing('custody_snapshot_chain_mismatch');
  const source=record(snapshot.source),sourceBound=source?.confirmed===true&&typeof source.hash==='string'&&
   /^0x[0-9a-f]{64}$/i.test(source.hash)&&typeof source.block==='string'&&raw.safeParse(source.block).success;
  checks.push(check('snapshot_source',sourceBound?'matched':'unavailable',sourceBound?undefined:'custody_snapshot_source_unconfirmed'));
  if(!sourceBound)addMissing('custody_snapshot_source_unconfirmed');
  if(profile){
   const expectedTokens=[profile.pool.token0,profile.pool.token1].map(x=>x.toLowerCase()).sort();
   const observedTokens=arrayField(snapshot.tokenBalances).map(item=>{
    const value=record(item);return typeof value?.token==='string'&&isAddress(value.token)?value.token.toLowerCase():null;
   });
   const tokenSetValid=observedTokens.length===2&&observedTokens.every(Boolean)&&
    [...observedTokens].sort().join('|')===expectedTokens.join('|')&&new Set(observedTokens).size===2;
   checks.push(check('token_scope',tokenSetValid?'matched':'mismatch',tokenSetValid?undefined:'custody_token_scope_mismatch'));
   if(!tokenSetValid)addMissing('custody_token_scope_mismatch');
   else for(const item of arrayField(snapshot.tokenBalances)){
    const value=record(item),rawValue=record(value?.raw);
    if(!fieldAvailable(rawValue)||typeof rawValue.value!=='string'||!raw.safeParse(rawValue.value).success)
     addMissing(`token_balance_unavailable:${String(value?.symbol??value?.token)}`);
   }
   const extraTargets=strategyId==='rangekeeper_v1'&&Array.isArray(record(draft.config)?.zeroAllowances)?
    arrayField<{token:unknown;spender:unknown}>(record(draft.config)?.zeroAllowances):[];
   const expectedPairs=new Set<string>();
   for(const token of [profile.pool.token0,profile.pool.token1])
    for(const spender of [profile.pool.router,profile.pool.positionManager])
     expectedPairs.add(`${token.toLowerCase()}:${spender.toLowerCase()}`);
   let extraValid=true;
   for(const pair of extraTargets){
    if(typeof pair.token!=='string'||!isAddress(pair.token)||typeof pair.spender!=='string'||!isAddress(pair.spender)){
     extraValid=false;continue;
    }
    expectedPairs.add(`${pair.token.toLowerCase()}:${pair.spender.toLowerCase()}`);
   }
   const observedPairs=arrayField(snapshot.allowances).map(item=>{
    const value=record(item);
    return typeof value?.token==='string'&&isAddress(value.token)&&typeof value.spender==='string'&&isAddress(value.spender)?
     `${value.token.toLowerCase()}:${value.spender.toLowerCase()}`:null;
   });
   const allowanceSetValid=extraValid&&observedPairs.length===expectedPairs.size&&observedPairs.every(Boolean)&&
    new Set(observedPairs).size===observedPairs.length&&[...expectedPairs].every(pair=>observedPairs.includes(pair));
   checks.push(check('allowance_scope',allowanceSetValid?'matched':'mismatch',
    allowanceSetValid?undefined:'custody_allowance_scope_mismatch'));
   if(!allowanceSetValid)addMissing('custody_allowance_scope_mismatch');
   else for(const item of arrayField(snapshot.allowances)){
    const value=record(item),rawValue=record(value?.raw);
    if(!fieldAvailable(rawValue)||typeof rawValue.value!=='string'||!raw.safeParse(rawValue.value).success)
     addMissing('scoped_allowance_read_unavailable');
    else if(BigInt(rawValue.value)!==0n)addMissing('nonzero_scoped_allowance_requires_reconciliation');
   }
   const managerMatches=typeof snapshot.positionManager==='string'&&same(snapshot.positionManager,profile.pool.positionManager);
   // The custody reader does not infer a manager from an ERC-721 count. If a
   // future snapshot includes this explicit binding, compare it exactly.
   checks.push(check('manager_snapshot_binding',managerMatches?'matched':'unavailable',
    managerMatches?undefined:'custody_snapshot_does_not_report_manager_binding'));
   if(!managerMatches)addMissing('custody_snapshot_does_not_report_manager_binding');
  }else{
   checks.push(check('token_scope','unavailable','saved_profile_unavailable'));
   checks.push(check('allowance_scope','unavailable','saved_profile_unavailable'));
  }
  const enumeration=nftCustodyEnumeration??snapshot.nftEnumeration;
  const manager=profile?.pool.positionManager??null;
  const enumerationMatches=completeNftEnumerationMatches(enumeration,strategyId,operator,manager,source,snapshot.nftCount);
  checks.push(check('nft_custody',enumerationMatches?'matched':'unavailable',
   enumerationMatches?undefined:'nft_enumeration_and_full_position_identity_unavailable'));
  if(!enumerationMatches){
   addMissing('nft_enumeration_and_full_position_identity_unavailable');
   const enumerationMissing=record(enumeration)?.missing;
   if(Array.isArray(enumerationMissing))for(const reason of enumerationMissing)
    if(typeof reason==='string')addMissing(reason);
  }
  const nftCount=record(snapshot.nftCount);
  if(!fieldAvailable(nftCount)||typeof nftCount.value!=='string'||!raw.safeParse(nftCount.value).success)
   addMissing('nft_count_unavailable');
  else if(BigInt(nftCount.value)>0n&&!enumerationMatches)addMissing('owned_nfts_require_full_identity_reconciliation');
  const native=record(snapshot.nativeBalanceWei);
  if(!fieldAvailable(native)||typeof native.value!=='string'||!raw.safeParse(native.value).success)
   addMissing('native_balance_unavailable');
  if(draft.mode==='live'&&allocation.success){
   const tokenValues=new Map(arrayField(snapshot.tokenBalances).map(item=>{
    const value=record(item),rawValue=record(value?.raw);
    return [typeof value?.token==='string'?value.token.toLowerCase():'',
     fieldAvailable(rawValue)&&typeof rawValue.value==='string'&&raw.safeParse(rawValue.value).success?
      BigInt(rawValue.value):null] as const;
   }));
   const token0=tokenValues.get(profile?.pool.token0.toLowerCase()??''),
    token1=tokenValues.get(profile?.pool.token1.toLowerCase()??''),
    nativeValue=fieldAvailable(native)&&typeof native.value==='string'&&raw.safeParse(native.value).success?BigInt(native.value):null;
   const funded=token0!==null&&token0!==undefined&&token1!==null&&token1!==undefined&&nativeValue!==null&&
    token0>=BigInt(allocation.data.token0Raw)&&token1>=BigInt(allocation.data.token1Raw)&&
    nativeValue>=BigInt(allocation.data.nativeWei);
   checks.push(check('current_balance_covers_saved_live_allocation',funded?'matched':'unavailable',
    funded?undefined:'live_allocation_balance_coverage_unavailable_or_insufficient'));
   if(!funded)addMissing('live_allocation_balance_coverage_unavailable_or_insufficient');
  }else checks.push(check('current_balance_covers_saved_live_allocation','not_applicable','saved_draft_is_not_live'));
 }
 if(!journal){
  checks.push(check('legacy_intent_journal','unavailable','legacy_journal_diagnostic_missing'));
  addMissing('legacy_journal_diagnostic_missing');
 }else{
  const journalIntegrity=journal.kind==='live_intent_receipt_journal_evidence'&&journal.status==='unavailable'&&
   journal.actionAvailable===false&&journal.executionEligible===false;
  checks.push(check('journal_diagnostic_integrity',journalIntegrity?'matched':'mismatch',
   journalIntegrity?undefined:'legacy_journal_diagnostic_shape_invalid'));
  if(!journalIntegrity)addMissing('legacy_journal_diagnostic_shape_invalid');
  const journalStrategy=journal.targetStrategyId,journalOperator=journal.operator,
   journalStatus=journal.journalStatus;
  const journalBinding=journalStrategy===strategyId&&typeof journalOperator==='string'&&same(journalOperator,operator);
  checks.push(check('legacy_intent_journal_binding',journalBinding?'matched':'mismatch',
   journalBinding?undefined:'legacy_journal_not_bound_to_saved_strategy_or_wallet'));
  if(!journalBinding)addMissing('legacy_journal_not_bound_to_saved_strategy_or_wallet');
  checks.push(check('legacy_intent_journal_state',journalStatus==='coherent'?'matched':'unavailable',
   journalStatus==='coherent'?undefined:`legacy_journal_state_${String(journalStatus??'missing')}`));
  if(journalStatus!=='coherent')addMissing(`legacy_journal_state_${String(journalStatus??'missing')}`);
  addMissing('legacy_journal_is_not_current_strategy_custody_proof');
 }
 if(draft.mode==='paper')addMissing('saved_draft_is_paper_mode_not_live_authorization');
 addMissing('live_intent_construction_review_and_signer_custody_not_implemented');
 addMissing('strategy_live_admission_and_executable_costs_not_evaluated');
 return {kind:'live_strategy_preflight_evidence' as const,status:'unavailable' as const,
  strategyId,campaignId:draft.id,revision:draft.revision,wallet:operator,chainId:draft.chainId,
  profileHash:draft.profileHash,configHash:draft.configHash,
  limitsBinding:limitsValid&&configHashValid?'bound_to_saved_config' as const:'unavailable' as const,
  checks,journal:{status:typeof journal?.journalStatus==='string'?journal.journalStatus:'unavailable',
   blockers:arrayField<string>(journal?.journalBlockers)},missing:[...new Set(missing)],
  actionAvailable:false as const,executionEligible:false as const};
}
