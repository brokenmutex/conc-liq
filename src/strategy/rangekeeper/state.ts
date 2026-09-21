import {z} from 'zod';
import type {Hex} from 'viem';
import type {RangeKeeperState} from './domain.js';

const uint=z.string().regex(/^(0|[1-9][0-9]*)$/).transform(BigInt);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s=>s as Hex);
const source=z.object({block:uint,hash,timestamp:z.number().int().nonnegative()}).strict();
const range=z.object({tickLower:z.number().int(),tickUpper:z.number().int()}).strict();
const swap=z.object({token:z.union([z.literal(0),z.literal(1)]),amountIn:uint,quotedOut:uint,minOut:uint,priceAfter:uint,feeValue:uint,shortfallValue:uint}).strict();
const candidate=z.object({kind:z.enum(['entry','recenter']),range,swap:swap.nullable(),amount0Desired:uint,amount1Desired:uint,
 amount0Min:uint,amount1Min:uint,liquidity:uint,deployedValue:uint,sourceBlock:uint,sourceHash:hash,expiresAt:z.number().int().nonnegative()}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),policyId:z.literal('rangekeeper_v1'),strategyVersion:z.literal('1.0.0'),
 configHash:hash,buildId:z.string().min(1),lastEligible:source.nullable(),
 exit:z.object({tokenId:z.string().regex(/^[1-9][0-9]*$/),tickLower:z.number().int(),tickUpper:z.number().int(),
  block:uint,hash,since:z.number().int().nonnegative(),lastOutsideAt:z.number().int().nonnegative()}).strict().nullable(),
 confirmation:z.object({candidate,firstBlock:uint,firstHash:hash,firstAt:z.number().int().nonnegative()}).strict().nullable(),
}).strict();

export function serializeRangeKeeperState(state:RangeKeeperState){return JSON.stringify(state,(_,v)=>typeof v==='bigint'?String(v):v);}
export function parseRangeKeeperState(raw:unknown):RangeKeeperState {return stateSchema.parse(typeof raw==='string'?JSON.parse(raw):raw);}
