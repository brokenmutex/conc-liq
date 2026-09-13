import assert from 'node:assert/strict';
import {encodeFunctionData,getAddress,toHex,type Address} from 'viem';
import {USDG} from '../constants.js';
import {paperTokenAbi} from './execution-abi.js';
import {prestateOverrides} from './execution-gas.js';
import type {PaperExecutionContext} from './execution.js';

/** Isolated funding account on owned Anvil only. It is never a real signer. */
export const PAPER_FIXTURE_DONOR=getAddress('0x00000000000000000000000000000000f17E0001');
export interface FixtureFundingProof {token:Address;account:Address;slot:string;amount:string;before:string;donorStorage:Record<string,string>;referenceStorage:Record<string,string>}
/** Find the per-account balance word from two getter traces, rather than assume
 * an ERC20 layout or proxy namespace. The displayed balance must match exactly. */
export async function fundLocalFixtureToken(context:PaperExecutionContext,token:Address,amount:bigint) {
 const {local,fork,market}=context;
 assert(context.policy.market,'Synthetic token funding requires an explicit paper market');
 assert([USDG,market.rwa].some(t=>t.toLowerCase()===token.toLowerCase()),'Unexpected fixture token');
 assert(amount>0n&&amount<(1n<<256n));
 const read=()=>local.readContract({address:token,abi:paperTokenAbi,functionName:'balanceOf',args:[PAPER_FIXTURE_DONOR]});
 const before=await read();if(before>=amount)return;
 const trace=async(account:Address)=>{
  const data=encodeFunctionData({abi:paperTokenAbi,functionName:'balanceOf',args:[account]});
  const overrides=prestateOverrides(await fork.rpc('debug_traceCall',[{to:token,data},'latest',{tracer:'prestateTracer'}]));
  const storage=Object.entries(overrides).find(([address])=>address.toLowerCase()===token.toLowerCase())?.[1].stateDiff;
  assert(storage,'Fixture balance getter storage unavailable');return storage;
 };
 const a=await trace(PAPER_FIXTURE_DONOR),b=await trace(market.pool);
 const slots=Object.keys(a).filter(key=>!(key in b));
 assert.equal(slots.length,1,'Fixture balance mapping is ambiguous');
 const slot=slots[0]!;
 await fork.rpc('anvil_setStorageAt',[token,slot,toHex(amount,{size:32})]);
 assert.equal(await read(),amount,'Fixture token balance does not match raw storage; unsupported multiplier/layout');
 context.fixtureFunding.push({token,account:PAPER_FIXTURE_DONOR,slot,amount:String(amount),before:String(before),donorStorage:a,referenceStorage:b});
}
