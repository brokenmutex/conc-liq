// Offline receipt-reconciled counterfactual; no environment, RPC or signer.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {USDG,NONFUNGIBLE_POSITION_MANAGER} from '../src/constants.ts';
import {PAPER_NVDA} from '../src/paper/engine.ts';
import {PAPER_ROUTER} from '../src/paper/execution-abi.ts';
import {replayPersistentAllowances} from '../src/research/persistent-allowance.ts';

const [ledgerPath,proofPath,out]=process.argv.slice(2);assert(ledgerPath&&proofPath&&out,'Usage: LEDGER FORK_PROOF NEW_OUTPUT_DIRECTORY');assert(!existsSync(out));mkdirSync(out,{recursive:true});
const bytes=readFileSync(ledgerPath),ledger=JSON.parse(bytes);assert.equal(ledger.campaigns.length,1);
const state=ledger.campaigns[0].state,key=(t,s)=>`${t.toLowerCase()}:${s.toLowerCase()}`;
const map=s=>Object.fromEntries(s.allowances.map(a=>[key(a.token,a.spender),a.amount]));
const actions=ledger.actions.filter(a=>['confirmed','reverted'].includes(a.status)).sort((a,b)=>Number(a.nonce)-Number(b.nonce));
const normalized=actions.map(a=>{
 const p=a.plan,b=a.before_state,f=a.receipt.facts;
 const available=t=>t.toLowerCase()===USDG.toLowerCase()?String(BigInt(b.usdg)-BigInt(state.reserveUsdg)):b.nvda;
 return {id:a.id,nonce:Number(a.nonce),reverted:a.status==='reverted',before:map(b),after:map(a.receipt.after),gasQuote:a.receipt.gasValuation?.quote??null,
  ...(p.kind==='approve'?{approval:{key:key(p.token,p.spender),amount:p.amount,managedAvailable:available(p.token),swapRouter:p.spender.toLowerCase()===PAPER_ROUTER.toLowerCase()}}:{}),
  spends:a.status==='reverted'?[]:p.kind==='swap'?[{key:key(p.token===0?USDG:PAPER_NVDA,PAPER_ROUTER),amount:p.amountIn}]:p.kind==='mint'?
   [{key:key(USDG,NONFUNGIBLE_POSITION_MANAGER),amount:String(-BigInt(f.walletDeltas.usdg))},{key:key(PAPER_NVDA,NONFUNGIBLE_POSITION_MANAGER),amount:String(-BigInt(f.walletDeltas.nvda))}]:[]};
});
for(const t of ledger.transitions.filter(t=>t.state.phase==='closed'&&t.reason==='closed')){
 const index=actions.findLastIndex(a=>a.created_at<=t.at);assert(index>=0);normalized[index].clearAtBoundary=true;
}
const caps=(quote,rwa)=>Object.fromEntries([USDG,PAPER_NVDA].flatMap(t=>[PAPER_ROUTER,NONFUNGIBLE_POSITION_MANAGER].map(s=>[key(t,s),String(t===USDG?quote:rwa)])));
// Derive maximum behavior only from complete paired forks matching this ledger.
const proofBytes=readFileSync(proofPath),proof=JSON.parse(proofBytes),behaviors=new Map();
assert(proof.cases.length>=2);let identity;
for(const c of proof.cases){
 assert(!c.error&&c.overrideControlsPassed&&c.branches.length===3&&c.branches.every(b=>b.complete));
 const a=actions.find(a=>a.nonce===c.nonce);assert(a&&a.before_state.hash===c.source.hash);
 const base=c.branches.find(b=>b.mode==='exact');assert(base);
 assert.deepEqual(c.branches.map(b=>b.mode).sort(),['exact','finite','maximum']);
 for(const b of c.branches){
  if(identity)assert.deepEqual(b.codeHashes,identity);else identity=b.codeHashes;
  assert.equal(b.costed.amount0,base.costed.amount0);assert.equal(b.costed.amount1,base.costed.amount1);assert.equal(b.liquidity,base.liquidity);
  assert(Object.values(b.endingAllowances).every(v=>v==='0'));
  if(b.mode!=='exact')assert.equal(b.operationApprovalCount,0);
  for(const s of b.spends){
   const k=key(s.token,s.spender),before=BigInt(s.before),after=BigInt(s.after),amount=BigInt(s.amount);assert(amount>0n);
   if(b.mode==='maximum'){
    assert.equal(before,(1n<<256n)-1n);const behavior=after===before?'maximum_unchanged':after===before-amount?'decrements':'unexpected';
    assert.notEqual(behavior,'unexpected');if(behaviors.has(k))assert.equal(behavior,behaviors.get(k));behaviors.set(k,behavior);
   }else assert.equal(after,before-amount);
  }
 }
}
assert.deepEqual([...behaviors.keys()].sort(),Object.keys(caps(1n,1n)).sort());
const noDecrease=[...behaviors].filter(([,b])=>b==='maximum_unchanged').map(([k])=>k);
const lastExit=normalized.findLastIndex(a=>a.clearAtBoundary);assert(lastExit>=0&&lastExit<normalized.length-1);
const result={ledgerSha256:createHash('sha256').update(bytes).digest('hex'),forkProofSha256:createHash('sha256').update(proofBytes).digest('hex'),maximumBehavior:Object.fromEntries(behaviors),codeHashes:identity,executionEligible:false,mainnetTransactions:0,lastExitNonce:normalized[lastExit].nonce,scopes:[]};
for(const [name,scope] of [['whole_recorded_campaign',normalized],['latest_uninterrupted_session',normalized.slice(lastExit+1)]]){
 const cases=[];
 for(const [policyName,limits] of [['finite_250_USDG_1_NVDA',caps(250n*10n**6n,10n**18n)],['finite_1250_USDG_5_NVDA',caps(1250n*10n**6n,5n*10n**18n)],['finite_2500_USDG_10_NVDA',caps(2500n*10n**6n,10n*10n**18n)],['maximum',caps((1n<<256n)-1n,(1n<<256n)-1n)]])
  for(const preserveCashExitCleanup of name==='whole_recorded_campaign'?[true,false]:[true]){
   const replay=replayPersistentAllowances(scope,{caps:limits,maximumDoesNotDecrease:noDecrease,preserveCashExitCleanup});
   cases.push({policyName,...replay});console.log(JSON.stringify({scope:name,policyName,preserveCashExitCleanup,original:replay.originalApprovals,total:replay.totalApprovalTransactions,grants:replay.grants,revokes:replay.retainedRevocations,extraRevokes:replay.extraRevocations.length,omittedRecordedGasQuote:replay.omittedRecordedGasQuote}));
  }
 result.scopes.push({name,firstNonce:scope[0].nonce,lastNonce:scope.at(-1).nonce,cases});
}
writeFileSync(`${out}/results.json`,JSON.stringify(result,null,2)+'\n');
