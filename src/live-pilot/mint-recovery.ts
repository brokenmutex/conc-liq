import assert from 'node:assert/strict';
import {decodeAbiParameters,decodeErrorResult,keccak256,stringToHex} from 'viem';
import {NONFUNGIBLE_POSITION_MANAGER} from '../constants.js';
import {PAPER_POOL} from '../paper/engine.js';
import type {PilotAction} from './domain.js';

interface CallTrace {type:string;from:string;to:string;input:`0x${string}`;output?:`0x${string}`;error?:string;calls?:CallTrace[]}
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Only the manager's own minimum-amount failure, after a successful pool mint,
 * qualifies. Router errors, nested reverts and arbitrary reason strings do not. */
export function proveMintSlippageTrace(action:PilotAction,trace:CallTrace) {
 assert(action.plan.kind==='mint'&&action.status==='reverted'&&action.hash,'Recovery requires a reverted mint');
 assert(trace.type==='CALL'&&same(trace.from,action.intent.operator)&&same(trace.to,NONFUNGIBLE_POSITION_MANAGER));
 assert(same(trace.to,action.intent.to)&&same(trace.input,action.intent.data),'Trace differs from recorded mint');
 assert(trace.error==='execution reverted'&&trace.output,'Mint did not revert');
 const error=decodeErrorResult({abi:[],data:trace.output});
 assert(error.errorName==='Error'&&error.args?.[0]==='Price slippage check','Mint revert is not price slippage');
 const calls:CallTrace[]=[];const visit=(c:CallTrace)=>{assert(!c.error,'Nested contract failure');calls.push(c);for(const child of c.calls??[])visit(child);};
 for(const c of trace.calls??[])visit(c);
 const mints=calls.filter(c=>c.type==='CALL'&&same(c.from,NONFUNGIBLE_POSITION_MANAGER)&&same(c.to,PAPER_POOL)&&c.input.startsWith('0x3c8a7d8d'));
 assert.equal(mints.length,1,'Expected one successful pool mint');assert(mints[0]!.output);
 const [amount0,amount1]=decodeAbiParameters([{type:'uint256'},{type:'uint256'}],mints[0]!.output!);
 assert(amount0<=BigInt(action.plan.amount0)&&amount1<=BigInt(action.plan.amount1),'Pool mint exceeds authorized funding');
 assert(amount0<BigInt(action.plan.min0)||amount1<BigInt(action.plan.min1),'Pool mint did not breach token minimum');
 return {kind:'canonical_mint_slippage_v1' as const,actionId:action.id,hash:action.hash,
  amount0:String(amount0),amount1:String(amount1),min0:action.plan.min0,min1:action.plan.min1,
  traceHash:keccak256(stringToHex(JSON.stringify(trace)))};
}
