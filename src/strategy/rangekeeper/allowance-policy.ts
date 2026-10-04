import assert from 'node:assert/strict';

/** Shared live wallet allowance policy. Approvals persist between stages and are capped; they are zeroed only when no
 * active campaign of the wallet uses the token/spender pair any more. The legacy CLI controller never selects it. */
export const RANGEKEEPER_ALLOWANCE_POLICY='persistent_capped_v1' as const;
/** A 5x cap captures ~96% of the infinite-allowance saving while staying finite (replayed NVDA audit). */
export const RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE=5n;
const MAX_UINT256=(1n<<256n)-1n;

export const allowancePairKey=(token:string,spender:string)=>`${token.toLowerCase()}:${spender.toLowerCase()}`;

export interface RangeKeeperAllowancePolicy {
 kind:typeof RANGEKEEPER_ALLOWANCE_POLICY;
 /** Initiating campaign's raw exposure per pool token (see `rangeKeeperAllowanceExposure`). */
 exposure:readonly [bigint,bigint];
 /** `token:spender` pairs another active campaign of the wallet still uses; a close never zeroes them. */
 retain?:ReadonlySet<string>;
}

/** Raw token amount a campaign can ever need approved: its allocation, and for a token it acquires by swap (so it holds none
 * yet) the deployment cap converted at the frozen review price. Only persisted, immutable inputs enter, so the planner cap
 * and the wallet integrity ceiling agree for the whole campaign life. */
export function rangeKeeperAllowanceExposure(input:{initial:readonly [bigint,bigint];maxDeploymentValue:bigint;
 decimals:readonly [number,number];prices:readonly [bigint,bigint]|null}):[bigint,bigint]{
 assert(input.initial.every(v=>v>=0n)&&input.maxDeploymentValue>=0n,'Allowance exposure inputs must be non-negative');
 const deployable=(i:0|1)=>{
  const price=input.prices?.[i];
  return price!==undefined&&price>0n?input.maxDeploymentValue*10n**BigInt(input.decimals[i])/price:0n;
 };
 return [0,1].map(i=>{const initial=input.initial[i]!,cap=deployable(i as 0|1);return initial>cap?initial:cap;}) as [bigint,bigint];
}
export const allowanceCeiling=(exposure:bigint)=>RANGEKEEPER_ALLOWANCE_CAP_MULTIPLE*exposure;

/** Approval amount for a stage that needs `needed` raw units pulled: none while the canonical allowance already covers it,
 * otherwise one approval straight to max(stage requirement, cap). Never the maximum sentinel. */
export function persistentAllowanceGrant(input:{current:bigint;needed:bigint;exposure:bigint}):bigint|null{
 assert(input.current>=0n&&input.needed>=0n&&input.exposure>=0n,'Allowance amounts must be non-negative');
 if(input.current>=input.needed)return null;
 const cap=allowanceCeiling(input.exposure),amount=input.needed>cap?input.needed:cap;
 assert(amount<MAX_UINT256,'Persistent allowance must stay finite');
 return amount;
}

/** Wallet-wide view used by every integrity check. Registered tokens/spenders, the pairs an active campaign uses, and the
 * per-token ceiling (the largest exposure of any wallet campaign, closed ones included so a close that leaves a sibling's
 * pair in place never strands an allowance above the remaining users' own cap). */
export interface WalletAllowanceScope {
 tokens:ReadonlySet<string>;spenders:ReadonlySet<string>;used:ReadonlySet<string>;ceiling:ReadonlyMap<string,bigint>;
}
export type WalletAllowanceViolation='unregistered_token'|'unregistered_spender'|'unused_pair'|'above_cap';
type ObservedAllowance={token:string;spender:string;amount:bigint};

/** Zero is always in policy (every pre-policy campaign leaves zero allowances). */
export function walletAllowanceViolation(a:ObservedAllowance,scope:WalletAllowanceScope):WalletAllowanceViolation|null{
 assert(a.amount>=0n,'Allowance amount must be non-negative');
 if(a.amount===0n)return null;
 const token=a.token.toLowerCase(),spender=a.spender.toLowerCase();
 if(!scope.tokens.has(token))return 'unregistered_token';
 if(!scope.spenders.has(spender))return 'unregistered_spender';
 if(!scope.used.has(allowancePairKey(token,spender)))return 'unused_pair';
 return a.amount>(scope.ceiling.get(token)??0n)?'above_cap':null;
}
export function assertWalletAllowancesInPolicy(allowances:readonly ObservedAllowance[],scope:WalletAllowanceScope):void{
 for(const a of allowances){
  const violation=walletAllowanceViolation(a,scope);
  assert(violation===null,`Wallet allowance is outside the ${RANGEKEEPER_ALLOWANCE_POLICY} policy: ${violation} ${allowancePairKey(a.token,a.spender)}`);
 }
}
/** Allowed non-zero pairs with their cap, as persisted in the cleanup proof so the queue can re-check independently. */
export function walletAllowanceCaps(scope:WalletAllowanceScope):{token:string;spender:string;cap:string}[]{
 return [...scope.used].sort().map(key=>{const [token,spender]=key.split(':') as [string,string];
  return {token,spender,cap:String(scope.ceiling.get(token)??0n)};});
}
/** Queue-side re-check of a cleanup proof: every observed allowance is zero or within its allowed pair's cap. */
export function assertAllowancesWithinCaps(allowances:readonly {token:string;spender:string;amount:string}[],
 caps:readonly {token:string;spender:string;cap:string}[]):void{
 const allowed=new Map(caps.map(c=>{assert(/^(0|[1-9][0-9]*)$/.test(c.cap),'Allowance cap is malformed');
  return [allowancePairKey(c.token,c.spender),BigInt(c.cap)] as const;}));
 for(const a of allowances){
  assert(/^(0|[1-9][0-9]*)$/.test(a.amount),'Allowance amount is malformed');
  const amount=BigInt(a.amount);if(amount===0n)continue;
  const cap=allowed.get(allowancePairKey(a.token,a.spender));
  assert(cap!==undefined,`Allowance remains on a pair no active campaign uses: ${allowancePairKey(a.token,a.spender)}`);
  assert(amount<=cap,`Allowance exceeds the ${RANGEKEEPER_ALLOWANCE_POLICY} cap: ${allowancePairKey(a.token,a.spender)}`);
 }
}
