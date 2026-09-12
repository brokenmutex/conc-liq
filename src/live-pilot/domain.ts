import type {Address,Hex} from 'viem';
import type {PaperHoldingState} from '../paper/holding.js';
import type {PilotIntent} from './journal.js';

export interface PilotPosition {
 tokenId:string;owner:Address;token0:Address;token1:Address;fee:number;tickLower:number;tickUpper:number;
 liquidity:string;tokensOwed0:string;tokensOwed1:string;
}
export interface PilotSnapshot {
 block:string;hash:Hex;timestamp:string;operator:Address;usdg:string;nvda:string;native:string;nonce:number;nftCount:string;
 tick:number;sqrtPriceX96:string;poolLiquidity:string;unlocked:boolean;
 allowances:{token:Address;spender:Address;amount:string}[];position:PilotPosition|null;
}
export interface PilotState {
 version:1;id:string;operator:Address;policyHash:string;phase:'entry'|'holding'|'recenter'|'exit'|'closed'|'halted';
 desired:'running'|'exit'|'stopped';reserveUsdg:string;initialCapitalQuote:string;initialNative:string;
 tokenId:string|null;retiredTokenIds:string[];range:{tickLower:number;tickUpper:number}|null;swapDone:boolean;
 last:PilotSnapshot;gasSpentWei:string;gasSpentQuote:string|null;collectedFee0:string;collectedFee1:string;createdAt:string;updatedAt:string;
 closedAt:string|null;holding?:PaperHoldingState;haltReason?:string;benchmark:{usdg:string;nvda:string}|null;
}
export type PilotPlan = {
 kind:'approve';token:Address;spender:Address;amount:string;
}|{kind:'swap';token:0|1;amountIn:string;minOut:string;quotedOut:string;deadline:string;
 }|{kind:'mint';tickLower:number;tickUpper:number;amount0:string;amount1:string;min0:string;min1:string;deadline:string;
 }|{kind:'withdraw';tokenId:string;liquidity:string;min0:string;min1:string;deadline:string;};
export interface PilotAction {
 id:string;campaignId:string;intent:PilotIntent;plan:PilotPlan;before:PilotSnapshot;
 status:'prepared'|'signed'|'confirmed'|'reverted'|'cancelled';raw:Hex|null;hash:Hex|null;
 receipt:unknown|null;createdAt:string;broadcastAt:string|null;error:string|null;
}
export const json=(value:unknown)=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v);
