import assert from 'node:assert/strict';
import {z} from 'zod';
import {getAddress,isAddress,type Address} from 'viem';

const address=z.string().refine(isAddress).transform(v=>getAddress(v));
const MAX=(1n<<256n)-1n;
const amount=z.string().max(78).regex(/^[1-9][0-9]*$/).refine(v=>/^[1-9][0-9]*$/.test(v)&&BigInt(v)<MAX,'Allowance must be finite, below the maximum sentinel');
export const allowancePolicySchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('exact_v1')}).strict(),
 z.object({kind:z.literal('persistent_finite_v1'),grants:z.array(z.object({token:address,spender:address,amountRaw:amount}).strict()).min(1).max(64)}).strict(),
]).superRefine((p,ctx)=>{
 if(p.kind==='persistent_finite_v1'){
  const keys=p.grants.map(g=>allowanceKey(g.token,g.spender));
  if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',message:'Duplicate token/spender allowance budget'});
 }
});
export type AllowancePolicy=z.infer<typeof allowancePolicySchema>;
export type AllowancePair={token:Address;spender:Address};
export const allowanceKey=(token:string,spender:string)=>`${token.toLowerCase()}:${spender.toLowerCase()}`;
export function canonicalAllowancePolicy(policy?:AllowancePolicy):AllowancePolicy {
 const p=allowancePolicySchema.parse(policy??{kind:'exact_v1'});
 return p.kind==='exact_v1'?p:{...p,grants:[...p.grants].sort((a,b)=>allowanceKey(a.token,a.spender).localeCompare(allowanceKey(b.token,b.spender)))};
}
export function assertAllowancePolicyMatches(saved:AllowancePolicy|undefined,configured:AllowancePolicy|undefined) {
 assert.deepEqual(canonicalAllowancePolicy(saved),canonicalAllowancePolicy(configured),'Allowance policy differs from saved campaign');
}
/** Market adapters supply independently verified pairs. Policy cannot add a spender or asset. */
export function assertAllowancePairs(policy:AllowancePolicy|undefined,pairs:readonly AllowancePair[]) {
 const p=canonicalAllowancePolicy(policy);
 if(p.kind==='persistent_finite_v1')assert.deepEqual(p.grants.map(g=>allowanceKey(g.token,g.spender)),
  pairs.map(g=>allowanceKey(g.token,g.spender)).sort(),'Allowance budgets must cover exactly the verified token/spender pairs');
}
function budget(policy:AllowancePolicy|undefined,token:Address,spender:Address):bigint|null {
 const p=canonicalAllowancePolicy(policy);if(p.kind==='exact_v1')return null;
 const grant=p.grants.find(g=>allowanceKey(g.token,g.spender)===allowanceKey(token,spender));
 assert(grant,'Token/spender has no allowance budget');return BigInt(grant.amountRaw);
}
/** All quantities are raw token units. Available inventory excludes any reserve. */
export function planAllowance(input:AllowancePair&{policy?:AllowancePolicy;required:bigint;available:bigint;allowance:bigint}):bigint|null {
 const {required,available,allowance}=input;
 assert(required>=0n&&available>=required&&allowance>=0n&&allowance<=MAX,'Allowance request exceeds managed inventory or has invalid amounts');
 const cap=budget(input.policy,input.token,input.spender);
 if(cap!==null)assert(required<=cap,'Required spend exceeds configured allowance budget');
 if(allowance>=required)return null;
 return cap??required;
}
/** Approval permission and actual trade funding are separate checks. Zero always permits cleanup. */
export function authorizeAllowance(input:AllowancePair&{policy?:AllowancePolicy;amount:bigint;available:bigint}) {
 assert(input.available>=0n&&input.amount>=0n,'Invalid approval amount');
 const cap=budget(input.policy,input.token,input.spender);
 if(input.amount===0n)return;
 if(cap===null)assert(input.amount<=input.available,'Approval exceeds managed inventory');
 else assert.equal(input.amount,cap,'Approval must equal configured finite budget');
}
