import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {zeroAddress,type Hex} from 'viem';
import {policyHash} from '../paper/engine.js';
import {assertRecenterPrice} from '../paper/execution-recenter.js';
import {USDG} from '../constants.js';
import {PAPER_NVDA} from '../paper/engine.js';
import {quoteValue} from '../simulator/math.js';
import type {LivePilotConfig} from './config.js';
import {PilotChain,authorizePilotPlan,encodePilotPlan} from './chain.js';
import {PilotGuardUnavailable,type PilotGuard} from './guard.js';
import {PilotStore,newPilotId} from './store.js';
import {pilotIntentSchema,verifyPilotSignature} from './journal.js';
import {pilotReceiptFacts,type PilotReceipt} from './receipt.js';
import {reconcilePilotAction} from './reconcile.js';
import {proveNativeCredit,type NativeCreditProof} from './native-credit.js';
import {proveMintSlippageTrace} from './mint-recovery.js';
import type {PilotAction,PilotSnapshot,PilotState} from './domain.js';
import type {loadPilotEnvSigner} from './signer.js';
import {assertAllowancePolicyMatches,canonicalAllowancePolicy} from '../execution/allowance-policy.js';
type Signer=ReturnType<typeof loadPilotEnvSigner>;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

export function assertPilotWalletContinuity(before:PilotSnapshot,after:PilotSnapshot) {
 for(const key of ['usdg','nvda','native','nonce','nftCount'] as const)assert.equal(after[key],before[key],`Unexplained wallet change: ${key}`);
 assert.deepEqual(after.allowances,before.allowances,'Unexplained allowance change');
 if(before.position&&BigInt(before.position.liquidity)>0n)assert.deepEqual(after.position,before.position,'NFT position changed outside the controller');
}
export class PilotController {
 constructor(readonly store:PilotStore,readonly chain:PilotChain,readonly config:LivePilotConfig,readonly signer:Signer,
  readonly guard:(db:PoolClient,state?:PilotState)=>Promise<PilotGuard>,
  readonly hook?:(at:'prepared'|'signed'|'broadcast'|'receipt',action:PilotAction)=>Promise<void>) {assert(config.operator&&same(config.operator,signer.address));}

 private assertAllowances(state:PilotState) {
  assertAllowancePolicyMatches(state.allowancePolicy,this.config.execution.allowancePolicy);
 }
 /** Explicit configuration adoption only at reconciled, permission-free cash custody.
  * This journals policy/config together and does not sign or broadcast. */
 async adoptAllowancePolicy() {
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;
   assert.equal(s.policyHash,policyHash(this.config.strategy),'Strategy differs from saved campaign');
   assert(s.phase==='closed'&&s.desired!=='running'&&!s.tokenId&&s.last.nvda==='0','Allowance adoption requires stopped, closed cash custody');
   assert(!(await this.store.pending(db,s.id)),'Unresolved transaction');
   assert(s.last.allowances.every(a=>a.amount==='0'),'Existing allowances must be cleared');
   assert(same((await this.chain.client.getBlock({blockNumber:BigInt(s.last.block)})).hash,s.last.hash),'Accepted state reorged');
   const guard=await this.guard(db,s);await this.chain.verify(guard.source);
   const current=await this.chain.snapshot(guard.source,null);assertPilotWalletContinuity(s.last,current);
   assert(!current.position&&current.allowances.every(a=>a.amount==='0'),'Unresolved position or allowance');
   assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),current.nonce,'Pending nonce changed');
   const next={...structuredClone(s),allowancePolicy:canonicalAllowancePolicy(this.config.execution.allowancePolicy),last:current};
   await db.query('BEGIN');try{
    await this.store.save(db,next,'operator_adopted_allowance_policy');
    // Preserve all other saved execution, signer and strategy configuration.
    const updated=await db.query(`UPDATE ${this.store.schema}.campaigns SET config=jsonb_set(config,'{execution,allowancePolicy}',$2::jsonb) WHERE id=$1`,[s.id,JSON.stringify(next.allowancePolicy)]);
    assert.equal(updated.rowCount,1);await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK');throw e;}
   return next;
  });
 }

 private async saveNativeCredit(db:PoolClient,state:PilotState,current:PilotSnapshot,proof:NativeCreditProof,reason:string) {
  const before=state.last;
  state.externalNativeCreditsWei=String(BigInt(state.externalNativeCreditsWei??'0')+BigInt(proof.totalWei));
  state.last=current;state.updatedAt=new Date().toISOString();
  await db.query('BEGIN');try{
   await this.store.save(db,state,reason);
   await this.store.mark(db,state.id,current.block,'native_credit',{proof,before,after:current,basis:'external_funding_excluded_from_strategy_pnl'});
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
 }
 /** Operator-authorized repair finishes the cash exit, then uses normal re-entry gates. */
 async recoverNativeCredit(hashes:Hex[]) {
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;this.assertAllowances(s);
   assert(s.phase==='halted'&&s.haltReason==='unexplained_wallet_or_nft_change','Recovery requires a wallet-continuity halt');
   assert.equal(s.policyHash,policyHash(this.config.strategy),'Recovery policy differs from saved campaign');
   assert(!(await this.store.pending(db,s.id)),'Unresolved transaction');
   assert(s.tokenId===null&&s.last.nvda==='0'&&(!s.last.position||s.last.position.liquidity==='0'),'Native credit recovery requires cash inventory');
   const guard=await this.guard(db,s),current=await this.chain.snapshot(guard.source,s.tokenId);
   assertPilotWalletContinuity({...s.last,native:current.native},current);
   assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),current.nonce);
   const proof=await proveNativeCredit(this.chain.client,s.last,current,0n,hashes);assert(proof,'No native credit to reconcile');
   s.phase='exit';delete s.haltReason;
   await this.saveNativeCredit(db,s,current,proof,'operator_reconciled_native_credit_to_exit');return s;
  });
 }

 async start(desired:'running'|'exit'='running') {
  return this.store.locked(this.signer.address,async db=>{
   assert(!(await this.store.current(db,this.signer.address)),'Pilot already exists; use its saved campaign');
   const guard=await this.guard(db);assert(guard.entryAllowed,`Entry gate: ${guard.reasons.join(',')}`);
   await this.chain.verify(guard.source);const s=await this.chain.snapshot(guard.source,null);
   assert(BigInt(s.usdg)>=BigInt(this.config.initialCapitalQuote)&&BigInt(s.native)>0n);assert.equal(s.nvda,'0');assert.equal(s.nftCount,'0');
   assert(s.allowances.every(a=>a.amount==='0'),'Existing allowances must be reconciled before starting');
   assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),s.nonce);
   const now=new Date().toISOString(),state:PilotState={version:1,id:newPilotId(),operator:s.operator,policyHash:policyHash(this.config.strategy),phase:'entry',desired,
    reserveUsdg:String(BigInt(s.usdg)-BigInt(this.config.initialCapitalQuote)),initialCapitalQuote:this.config.initialCapitalQuote,initialNative:s.native,tokenId:null,
    retiredTokenIds:[],range:null,swapDone:false,last:s,gasSpentWei:'0',gasSpentQuote:'0',collectedFee0:'0',collectedFee1:'0',createdAt:now,updatedAt:now,closedAt:null,benchmark:null,
    allowancePolicy:canonicalAllowancePolicy(this.config.execution.allowancePolicy)};
   await this.store.create(db,state,this.config);return state;
  });
 }
 async request(desired:'running'|'exit'|'stopped') {
  return this.store.locked(this.signer.address,async db=>{const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;
   this.assertAllowances(s);
   assert(s.phase!=='halted','A halted campaign requires an explicit reconciliation repair');s.desired=desired;
   if(desired!=='running'&&s.phase!=='closed')s.phase='exit';await this.store.save(db,s,`operator_requested_${desired}`);return s;});
 }
 /** Only a reconciled reverted receipt can be repaired into an exit operation.
  * Ambiguous signatures, wallet changes and accepted-state reorgs stay halted. */
 async recoverExit() {
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state;
   this.assertAllowances(s);
   assert(s.phase==='halted'&&s.haltReason?.startsWith('transaction_reverted:'),'Recovery requires a reconciled reverted receipt');
   assert(!(await this.store.pending(db,s.id)),'Unresolved signed transaction');
   const action=(await db.query(`SELECT status FROM ${this.store.schema}.actions WHERE id=$1 AND campaign_id=$2`,[s.haltReason!.split(':')[1],s.id])).rows[0];
   assert.equal(action?.status,'reverted');const guard=await this.guard(db,s);
   assert(same((await this.chain.client.getBlock({blockNumber:BigInt(s.last.block)})).hash,s.last.hash),'Reverted receipt block changed');
   const current=await this.chain.snapshot(guard.source,s.tokenId);assertPilotWalletContinuity(s.last,current);
   assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),current.nonce);
   s.phase='exit';s.desired='stopped';delete s.haltReason;s.last=current;
   await this.store.save(db,s,'operator_recovered_revert_to_exit');return s;
  });
 }
 /** Requote a completed mint failure; this does not broadcast or repeat a swap. */
 async recoverMint() {
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row);
   return this.recoverMintLocked(db,row.state);
  });
 }
 private async recoverMintLocked(db:PoolClient,s:PilotState) {
  this.assertAllowances(s);
  assert(s.phase==='halted'&&s.haltReason?.startsWith('transaction_reverted:'),'Recovery requires a reverted transaction halt');
  assert(s.desired==='running','Mint recovery requires running intent');
  assert.equal(s.policyHash,policyHash(this.config.strategy),'Recovery policy differs from saved campaign');
  const attempts=s.mintRecovery?.attempts??0;assert(Number.isInteger(attempts)&&attempts>=0&&attempts<3,'Mint retry limit reached');
  assert(!(await this.store.pending(db,s.id)),'Unresolved transaction');
  const a=await this.store.action(db,s.id,s.haltReason!.split(':')[1]!);
  assert(a&&a.campaignId===s.id&&a.plan.kind==='mint'&&a.status==='reverted'&&a.hash,'Recovery requires a reconciled mint');
  assert(a.phase==='entry'||a.phase==='recenter','Mint was not an entry or recenter');
  assert(s.tokenId===null&&s.last.position===null&&s.swapDone,'Mint recovery requires withdrawn inventory and completed balancing');
  const saved=a.receipt as {after:PilotSnapshot;nativeCredit?:unknown};
  assert(saved&&!saved.nativeCredit,'Mint receipt evidence unavailable');assert.deepEqual(saved.after,s.last,'Campaign has advanced beyond failed mint');
  const guard=await this.guard(db,s);assert(guard.entryAllowed&&!guard.holding?.paused&&!guard.holding?.exitReasons.length,'Mint recovery admission unavailable');
  const receipt=await this.chain.client.getTransactionReceipt({hash:a.hash});
  assert(receipt.status==='reverted'&&String(receipt.blockNumber)===s.last.block&&same(receipt.blockHash,s.last.hash),'Reverted receipt changed');
  assert(BigInt(guard.source.block)>=receipt.blockNumber,'Receipt confirmation depth unavailable');
  const block=await this.chain.client.getBlock({blockNumber:receipt.blockNumber});assert(same(block.hash,s.last.hash),'Reverted receipt block changed');
  // Re-run custody assertions without applying the already charged gas twice.
  reconcilePilotAction(s,a,receipt,s.last);
  const trace=await this.chain.client.request({method:'debug_traceTransaction' as never,params:[a.hash,{tracer:'callTracer',timeout:'10s'}] as never});
  const proof=proveMintSlippageTrace(a,trace as never);
  assert(same((await this.chain.client.getBlock({blockNumber:receipt.blockNumber})).hash,s.last.hash),'Trace source reorged');
  await this.chain.verify(guard.source);
  const current=await this.chain.snapshot(guard.source,null);assertPilotWalletContinuity(s.last,current);assert.equal(current.position,null);
  assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),current.nonce,'Pending nonce changed');
  const price=quoteValue({amount0:0n,amount1:10n**18n,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(current.sqrtPriceX96)})*10n**12n;
  assert(guard.referencePriceX18&&price*1000000n>=BigInt(guard.referencePriceX18)*950000n&&price*1000000n<=BigInt(guard.referencePriceX18)*1050000n,'Recovery true-price guard failed');
  const next=structuredClone(s);next.phase=a.phase;delete next.haltReason;next.last=current;next.holding=guard.holding;
  next.mintRecovery={attempts:attempts+1,lastActionId:a.id,phase:a.phase};next.updatedAt=new Date().toISOString();
  // Includes new funding/price/minimum bounds and the native recovery reserve.
  const plan=await this.chain.plan(next,current);assert(plan?.kind==='mint','Recovery must reprice the mint without another swap');
  await this.chain.envelope(next,current,plan);
  await db.query('BEGIN');try{
   await this.store.save(db,next,'recovered_mint_slippage');
   await this.store.mark(db,s.id,current.block,'mint_recovery',{proof,attempt:next.mintRecovery.attempts,before:s.last,after:current,plan});
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
  return next;
 }
 /** Explicit retry of a stranded approval only, at the identical hash/nonce.
  * Swap/mint/withdraw deadlines and unresolved economic orders are never reset. */
 async retryApproval(expectedHash?:string) {
  assert(this.config.broadcastEnabled,'Broadcast is disabled');
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row);const s=row.state,a=await this.store.pending(db,s.id);
   this.assertAllowances(s);
   assert(a?.status==='signed'&&a.raw&&a.hash&&a.plan.kind==='approve','Retry requires the existing signed approval');
   assert(!expectedHash||same(a.hash,expectedHash),'Bootstrap approval hash changed');
   assert.equal(await verifyPilotSignature(a.intent,a.raw),a.hash);
   assert(s.phase==='entry'&&s.desired==='running'&&s.tokenId===null&&s.last.nvda==='0','Approval retry requires unexposed entry inventory');
   try{await this.chain.client.getTransactionReceipt({hash:a.hash});return {phase:'receipt_already_present',hash:a.hash};}
   catch(e){assert(e instanceof Error&&e.name==='TransactionReceiptNotFoundError');}
   const guard=await this.guard(db,s);assert(guard.entryAllowed,'Fresh approval admission failed');
   const b=await this.chain.client.getBlock({blockTag:'latest'}),current=await this.chain.snapshot({block:String(b.number),hash:b.hash,timestamp:String(b.timestamp)},null);
   assertPilotWalletContinuity(a.before,current);assert.equal(await this.chain.client.getTransactionCount({address:s.operator,blockTag:'pending'}),a.intent.nonce);
   authorizePilotPlan(a.plan,s,current);const call=encodePilotPlan(a.plan,s.operator);
   assert(same(call.to,a.intent.to)&&same(call.data,a.intent.data));await this.chain.client.call({account:s.operator,...call,blockNumber:b.number});
   assert(b.baseFeePerGas!==null&&b.baseFeePerGas<=BigInt(a.intent.maxFeePerGas),'Signed approval fee is below current base fee');
   assert(await this.chain.client.estimateGas({account:s.operator,...call,blockNumber:b.number})<=BigInt(a.intent.gas),'Signed approval gas limit is no longer sufficient');
   assert(BigInt(current.native)>=BigInt(a.intent.gas)*BigInt(a.intent.maxFeePerGas));
   await this.store.mark(db,s.id,current.block,'approval_retry',{actionId:a.id,hash:a.hash,nonce:a.intent.nonce,source:current});
   const hash=await this.chain.broadcast(a.raw,a.before);assert(same(hash,a.hash));await this.store.attempted(db,a.id,null);
   return {phase:'approval_retried_same_hash',hash};
  });
 }
 private async beforeBroadcast(action:PilotAction,state:PilotState,guard:PilotGuard) {
  this.assertAllowances(state);
  const age=Date.now()/1000-Number(action.before.timestamp);assert(age>=0&&age<=90,'Transaction intent expired before broadcast');
  if(state.phase!=='exit')assert(guard.entryAllowed,'Current admission does not allow increasing LP exposure');
  assert(same((await this.chain.client.getBlock({blockNumber:BigInt(action.before.block)})).hash,action.before.hash),'Intent source reorged');
  authorizePilotPlan(action.plan,state,action.before);const encoded=encodePilotPlan(action.plan,state.operator);
  assert(same(encoded.to,action.intent.to)&&same(encoded.data,action.intent.data),'Calldata differs from authorized plan');
  const latest=await this.chain.client.getBlock({blockTag:'latest'}),s=await this.chain.snapshot({block:String(latest.number),hash:latest.hash,timestamp:String(latest.timestamp)},state.tokenId);
  assertPilotWalletContinuity(action.before,s);assert.equal(await this.chain.client.getTransactionCount({address:state.operator,blockTag:'pending'}),action.intent.nonce,'Pending nonce changed');
  assertRecenterPrice(BigInt(s.sqrtPriceX96),BigInt(action.before.sqrtPriceX96),50);assert(s.unlocked);
  if(state.phase!=='exit'){
   const price=quoteValue({amount0:0n,amount1:10n**18n,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(s.sqrtPriceX96)})*10n**12n;
   assert(guard.referencePriceX18&&price*1000000n>=BigInt(guard.referencePriceX18)*950000n&&price*1000000n<=BigInt(guard.referencePriceX18)*1050000n,'Latest true-price guard failed');
  }
  if(action.plan.kind==='mint')assert(s.tick>=action.plan.tickLower&&s.tick<action.plan.tickUpper,'Mint range crossed before submission');
  await this.chain.client.call({account:state.operator,to:encoded.to,data:encoded.data,blockNumber:latest.number});
 }
 private async pending(db:PoolClient,state:PilotState,action:PilotAction,guard:PilotGuard) {
  if(action.status==='prepared'){await this.store.cancel(db,action.id,'restart_before_signing_requote');return {phase:'requote',id:action.id};}
  assert(action.raw&&action.hash);
  let receipt:PilotReceipt|null=null;
  try{receipt=await this.chain.client.getTransactionReceipt({hash:action.hash});}
  catch(e){if(!(e instanceof Error)||e.name!=='TransactionReceiptNotFoundError')throw e;}
  if(receipt){
   if(BigInt(guard.source.block)<receipt.blockNumber){await this.store.monitor(db,state.id,['awaiting_receipt_confirmation_depth']);return {phase:'confirming',hash:action.hash};}
   const block=await this.chain.client.getBlock({blockNumber:receipt.blockNumber});
   if(!same(block.hash,receipt.blockHash)){await this.store.monitor(db,state.id,['receipt_reorged_unresolved']);return {phase:'reorg_wait'};}
   const facts=pilotReceiptFacts(receipt,state.operator),minted=facts.nfts.find(n=>same(n.from,zeroAddress)&&same(n.to,state.operator));
   const tokenId=action.plan.kind==='mint'&&receipt.status==='success'?minted?.tokenId:state.tokenId;
   if(action.plan.kind==='mint'&&receipt.status==='success')assert(tokenId,'Mint receipt has no owned NFT');
   const after=await this.chain.snapshot({block:String(block.number),hash:block.hash,timestamp:String(block.timestamp)},tokenId??null);
   const nativeCredit=await proveNativeCredit(this.chain.client,action.before,after,BigInt(facts.gasWei));
   const resolved=reconcilePilotAction(state,action,receipt,after,nativeCredit);
   let gasValuation:{quote:string;proof:unknown}|null=null;
   try{gasValuation=await this.chain.valueGas?.(after,resolved.facts.gasWei)??null;}catch{/* Receipt remains exact; unavailable conversion is explicit. */}
   resolved.state.gasSpentQuote=state.gasSpentQuote!==null&&gasValuation?String(BigInt(state.gasSpentQuote)+BigInt(gasValuation.quote)):null;
   await this.hook?.('receipt',action);
   await this.store.finish(db,action,resolved.state,{receipt,facts:resolved.facts,after,gasValuation,nativeCredit},resolved.status);
   const mark=await this.chain.mark(after,resolved.state);await this.store.mark(db,state.id,after.block,'mark',mark);
   return {phase:resolved.state.phase,hash:action.hash,status:resolved.status};
  }
  if(action.broadcastAt&&Date.now()-new Date(action.broadcastAt).getTime()<120000){await this.store.monitor(db,state.id,['awaiting_transaction_receipt']);return {phase:'pending',hash:action.hash};}
  try {await this.beforeBroadcast(action,state,guard);}
  catch {await this.store.monitor(db,state.id,['signed_transaction_unresolved_requires_reconciliation']);return {phase:'pending_guarded',hash:action.hash};}
  assert(this.config.broadcastEnabled,'Broadcast is disabled');
  try {const hash=await this.chain.broadcast(action.raw,action.before);assert(same(hash,action.hash));await this.store.attempted(db,action.id,null);}
  catch {await this.store.attempted(db,action.id,'broadcast_acknowledgement_unknown');}
  await this.hook?.('broadcast',action);return {phase:'submitted_or_ack_unknown',hash:action.hash};
 }
 async tick() {
  return this.store.locked(this.signer.address,async db=>{
   const row=await this.store.current(db,this.signer.address);assert(row,'Pilot has not been initialized');let state=row.state;
   this.assertAllowances(state);
   assert.equal(state.policyHash,policyHash(this.config.strategy),'Running policy differs from saved campaign');
   if(state.phase==='halted'){
    if(state.haltReason?.startsWith('transaction_reverted:')&&state.desired==='running'){
     try{const recovered=await this.recoverMintLocked(db,state);return {phase:'mint_requote',attempt:recovered.mintRecovery!.attempts};}
     catch(e){const reason=e instanceof Error?e.message.replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,160):'unavailable';
      await this.store.monitor(db,state.id,[state.haltReason,`mint_recovery_blocked:${reason}`]);return {phase:'halted',reason};}
    }
    await this.store.monitor(db,state.id,[state.haltReason??'halted']);return {phase:'halted'};
   }
   let guard:PilotGuard;
   try{guard=await this.guard(db,state);}catch(e){
    if(e instanceof PilotGuardUnavailable&&e.holding){state.holding=e.holding;if(state.phase!=='closed'&&e.holding.exitReasons.length)state.phase='exit';await this.store.save(db,state,'chain_observation_pause');}
    await this.store.monitor(db,state.id,['chain_or_reference_observation_unavailable']);return {phase:'guard_wait'};}

   const pending=await this.store.pending(db,state.id);if(pending)return this.pending(db,state,pending,guard);
   const previousBlock=await this.chain.client.getBlock({blockNumber:BigInt(state.last.block)});
   if(!same(previousBlock.hash,state.last.hash)){state.phase='halted';state.haltReason='accepted_state_reorged';await this.store.save(db,state,state.haltReason);return {phase:'halted'};}
   const s=await this.chain.snapshot(guard.source,state.tokenId);
   let nativeCredit:NativeCreditProof|null=null;
   try{
    assertPilotWalletContinuity({...state.last,native:s.native},s);
    nativeCredit=await proveNativeCredit(this.chain.client,state.last,s);
   }catch{state.phase='halted';state.haltReason='unexplained_wallet_or_nft_change';await this.store.save(db,state,state.haltReason);return {phase:'halted'};}
   if(nativeCredit)await this.saveNativeCredit(db,state,s,nativeCredit,'reconciled_native_credit');
   state.holding=guard.holding;
   const reference=guard.referencePriceX18;
   const price=quoteValue({amount0:0n,amount1:10n**18n,token0:USDG,token1:PAPER_NVDA,quoteToken:USDG,sqrtPriceX96:BigInt(s.sqrtPriceX96)})*10n**12n;
   const bandOkay=!!reference&&price*1000000n>=BigInt(reference)*950000n&&price*1000000n<=BigInt(reference)*1050000n;
   if(state.phase!=='closed'&&(state.desired!=='running'||state.holding?.exitReasons.length||(!bandOkay&&reference)))state.phase='exit';
   if(state.phase==='closed'){
    if(state.desired==='running'&&guard.entryAllowed&&state.closedAt&&Date.now()-Date.parse(state.closedAt)>=600000){state.phase='entry';state.holding=undefined;state.swapDone=false;state.range=null;delete state.mintRecovery;}
    else {await this.store.monitor(db,state.id,['closed']);return {phase:'closed'};}
   }
   if(state.holding?.paused){await this.store.save(db,state,'holding_pause');await this.store.monitor(db,state.id,state.holding.reasons);return {phase:'holding_pause'};}
   if(state.phase==='holding'){
    assert(s.position&&s.position.liquidity!=='0');if(s.tick<s.position.tickLower||s.tick>=s.position.tickUpper){state.phase='recenter';state.range=null;state.swapDone=false;}
    else {if(s.block!==state.last.block){const mark=await this.chain.mark(s,state);state.last=s;await this.store.save(db,state,'mark');await this.store.mark(db,state.id,s.block,'mark',mark);}else await this.store.monitor(db,state.id,[]);return {phase:'holding'};}
   }
   if(state.phase!=='exit'&&(!guard.entryAllowed||!bandOkay)){await this.store.save(db,state,'admission_wait');await this.store.monitor(db,state.id,guard.reasons);return {phase:'admission_wait'};}
   const plan=await this.chain.plan(state,s);state.last=s;await this.store.save(db,state,'management_plan');
   if(!plan){assert(state.phase==='exit'&&!state.tokenId&&s.nvda==='0');state.phase='closed';state.closedAt=new Date().toISOString();await this.store.save(db,state,'closed');return {phase:'closed'};}
   let envelope:Awaited<ReturnType<PilotChain['envelope']>>;
   try{envelope=await this.chain.envelope(state,s,plan);}catch(e){
    if(state.phase!=='exit'&&e instanceof Error&&e.message==='Insufficient ETH for action plus recovery reserve'){
     state.phase='exit';state.desired='stopped';await this.store.save(db,state,'gas_recovery_reserve_reached');return {phase:'exit',reason:'gas_recovery_reserve_reached'};
    }throw e;
   }
   const intent=pilotIntentSchema.parse({id:newPilotId(),chainId:4663,operator:state.operator,action:plan.kind,
    nonce:s.nonce,to:envelope.to,data:envelope.data,value:envelope.value,gas:envelope.gas,maxFeePerGas:envelope.maxFeePerGas,maxPriorityFeePerGas:envelope.maxPriorityFeePerGas,sourceBlock:s.block,sourceHash:s.hash});
   if(!this.config.broadcastEnabled){await this.store.monitor(db,state.id,['broadcast_disabled']);return {phase:'ready_disabled',plan};}
   let action=await this.store.prepare(db,state,intent,plan,s);await this.hook?.('prepared',action);
   const submissionGuard=await this.guard(db,state);
   await this.beforeBroadcast(action,state,submissionGuard);const signed=await this.signer.signIntent(intent);await this.store.signed(db,action,signed.raw);
   action={...action,status:'signed',raw:signed.raw,hash:signed.hash};await this.hook?.('signed',action);
   return this.pending(db,state,action,submissionGuard);
  });
 }
}
