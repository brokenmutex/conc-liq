import {getAddress,isAddress} from 'viem';

type JournalQuery={query<T=unknown>(sql:string,values?:unknown[]):Promise<{rows:T[]}>};
type SupportedStrategy='static_manual_v1'|'rangekeeper_v1';
type JournalRow={campaignId:string|null;phase:string|null;desired:string|null;heartbeatAt:Date|string|null;
 actionId:string|null;nonce:string|null;intentOperator:string|null;chainId:string|null;action:string|null;
 actionStatus:string|null;transactionHash:string|null;receiptHash:string|null};
type ActionSummary={id:string;nonce:string;action:string;status:'prepared'|'signed'|'confirmed'|'reverted'|'cancelled';
 transactionHash:string|null;receiptHashBound:boolean};
const UINT=/^(0|[1-9][0-9]*)$/;
const HASH=/^0x[0-9a-f]{64}$/i;
const LIMIT=100;
const unsupportedCurrentEvidence=[
 'legacy_live_pilot_journal_not_bound_to_target_strategy_or_campaign',
 'canonical_wallet_nonce_not_observed',
 'token_and_native_balances_not_observed',
 'nft_ownership_and_allowances_not_checked',
 'current_strategy_profile_and_limits_not_checked',
 'live_operation_admission_and_signing_unavailable',
] as const;

function unavailable(reason:string,operator:string|null,targetStrategyId:unknown){
 return {kind:'live_intent_receipt_journal_evidence' as const,status:'unavailable' as const,
  journalStatus:'unavailable' as const,operator,
  targetStrategyId:targetStrategyId==='static_manual_v1'||targetStrategyId==='rangekeeper_v1'?targetStrategyId:null,
  campaign:null,actions:[] as ActionSummary[],journalBlockers:[] as string[],
  unavailableReasons:[reason,...unsupportedCurrentEvidence],actionAvailable:false as const,
  executionEligible:false as const};
}

/** Read-only summary of the legacy live intent/receipt journal. Journal status
 * describes only those saved records. It is never evidence that custody or a
 * deployment belonging to the requested strategy is currently ready. */
export async function readLiveIntentReceiptJournalEvidence(
 db:JournalQuery,rawOperator:unknown,targetStrategyId:unknown,
){
 if(targetStrategyId!=='static_manual_v1'&&targetStrategyId!=='rangekeeper_v1')
  return unavailable('target_strategy_unsupported',null,targetStrategyId);
 if(typeof rawOperator!=='string'||!isAddress(rawOperator))
  return unavailable('operator_address_invalid',null,targetStrategyId);
 const operator=getAddress(rawOperator),normalized=operator.toLowerCase();
 let rows:JournalRow[];
 try{
  rows=(await db.query<JournalRow>(`SELECT c.id::text AS "campaignId",
   c.state->>'phase' AS phase,c.state->>'desired' AS desired,c.heartbeat_at AS "heartbeatAt",
   a.id::text AS "actionId",a.nonce::text AS nonce,a.intent->>'operator' AS "intentOperator",
   a.intent->>'chainId' AS "chainId",a.intent->>'action' AS action,a.status AS "actionStatus",
   a.hash AS "transactionHash",a.receipt->'receipt'->>'transactionHash' AS "receiptHash"
  FROM live_pilot_v1.campaigns c LEFT JOIN live_pilot_v1.actions a ON a.campaign_id=c.id
  WHERE lower(c.operator)=lower($1) ORDER BY a.created_at,a.id LIMIT $2`,[operator,LIMIT+1])).rows;
 }catch{return unavailable('live_intent_receipt_journal_unavailable',operator,targetStrategyId);}
 if(rows.length>LIMIT)return unavailable('live_intent_journal_bound_exceeded',operator,targetStrategyId);
 const campaignIds=[...new Set(rows.map(row=>row.campaignId).filter((id):id is string=>Boolean(id)))];
 const first=rows[0],campaign=campaignIds.length===1&&first?.campaignId?{
  id:first.campaignId,phase:first.phase,desired:first.desired,
  heartbeatAt:first.heartbeatAt instanceof Date?first.heartbeatAt.toISOString():first.heartbeatAt,
 }:null;
 const actions:ActionSummary[]=[],unresolved:string[]=[],integrity:string[]=[];
 if(campaignIds.length>1)integrity.push('multiple_legacy_campaigns_for_operator');
 const seenNonces=new Set<string>();
 for(const row of rows){
  if(row.actionId===null)continue;
  const status=row.actionStatus;
  if(!row.nonce||!UINT.test(row.nonce)||!row.intentOperator||!isAddress(row.intentOperator)||
   getAddress(row.intentOperator).toLowerCase()!==normalized||row.chainId!=='4663'||
   !row.action||!['prepared','signed','confirmed','reverted','cancelled'].includes(status??'')){
   integrity.push('live_intent_journal_row_invalid');continue;
  }
  const nonceKey=`${row.campaignId}:${row.nonce}`;
  if(seenNonces.has(nonceKey))integrity.push('duplicate_campaign_nonce_records');
  seenNonces.add(nonceKey);
  const txHash=row.transactionHash;
  if(status==='prepared'){
   if(txHash!==null||row.receiptHash!==null)integrity.push('prepared_intent_has_signed_evidence');
   unresolved.push('unresolved_prepared_intent');
  }else if(status==='signed'){
   if(!txHash||!HASH.test(txHash)||row.receiptHash!==null)integrity.push('signed_intent_binding_invalid');
   unresolved.push('unresolved_signed_intent');
  }else if(status==='cancelled'){
   if(txHash!==null||row.receiptHash!==null)integrity.push('cancelled_intent_has_signed_evidence');
  }else if(!txHash||!HASH.test(txHash)||!row.receiptHash||!HASH.test(row.receiptHash)||
   txHash.toLowerCase()!==row.receiptHash.toLowerCase()){
   integrity.push('terminal_receipt_hash_mismatch');
  }
  actions.push({id:row.actionId,nonce:row.nonce,action:row.action,
   status:status as ActionSummary['status'],transactionHash:txHash,
   receiptHashBound:status==='confirmed'||status==='reverted'?Boolean(row.receiptHash&&txHash?.toLowerCase()===row.receiptHash.toLowerCase()):false});
 }
 const uniqueUnresolved=[...new Set(unresolved)],uniqueIntegrity=[...new Set(integrity)];
 const journalStatus=uniqueIntegrity.includes('multiple_legacy_campaigns_for_operator')||
  uniqueIntegrity.includes('duplicate_campaign_nonce_records')?'ambiguous' as const:
  uniqueIntegrity.length?'invalid' as const:uniqueUnresolved.length?'unresolved' as const:
  rows.length?'coherent' as const:'not_found' as const;
 return {kind:'live_intent_receipt_journal_evidence' as const,status:'unavailable' as const,journalStatus,
  operator,targetStrategyId:targetStrategyId as SupportedStrategy,campaign,actions,
  journalBlockers:uniqueIntegrity.length?uniqueIntegrity:uniqueUnresolved,
  unavailableReasons:[...unsupportedCurrentEvidence] as string[],
  actionAvailable:false as const,executionEligible:false as const};
}
