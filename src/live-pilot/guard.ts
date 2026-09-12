import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {Hex} from 'viem';
import type {RobinhoodClient} from '../client.js';
import {sourceSql} from '../paper/store.js';
import {PAPER_NVDA,PAPER_POOL,type PaperCheckpoint} from '../paper/engine.js';
import {readPaperReferenceGate,readPaperRiskSources,evaluatePaperCurrentRisk} from '../paper/reference.js';
import {evaluateCanaryEntryReadiness} from '../canary-plan/entry-readiness.js';
import {advanceHolding,holdingChainFault,type PaperHoldingState} from '../paper/holding.js';
import type {RpcHealthEvaluation} from '../rpc-health/domain.js';
import type {LivePilotConfig} from './config.js';
import type {PilotState} from './domain.js';
import type {PilotSource} from './chain.js';

export interface PilotGuard {
 source:PilotSource;entryAllowed:boolean;referencePriceX18:string|null;reasons:string[];holding?:PaperHoldingState;
}
export class PilotGuardUnavailable extends Error {
 constructor(readonly holding:PaperHoldingState|undefined,reason:string){super(reason);}
}
export function observePilotHolding(state:PilotState|undefined,observation:Omit<Parameters<typeof advanceHolding>[0],'previous'>) {
 if(!state||(state.tokenId===null&&BigInt(state.last.nvda)===0n))return undefined;
 // The first accepted exposed snapshot is the receipt that acquired inventory,
 // not the campaign's creation time while its capital was still entirely cash.
 const since=new Date(Number(state.last.timestamp)*1000).toISOString();
 return advanceHolding({...observation,previous:state.holding??{
  checkedAt:since,lastHealthAt:since,chainSince:null,riskSince:null,paused:false,resumeFromPause:false,exitReasons:[],reasons:[],healthSampleId:null,riskEvidence:null}});
}
export async function readPilotGuard(db:PoolClient,client:RobinhoodClient,config:LivePilotConfig,streamKey:string,state?:PilotState):Promise<PilotGuard> {
 const now=new Date().toISOString(),rows=(await db.query<{id:string;snapshot:RpcHealthEvaluation}>(
  "SELECT id::text,snapshot FROM rpc_health_samples WHERE observed_at >= NOW()-INTERVAL '16 minutes' ORDER BY observed_at DESC,id DESC LIMIT 128")).rows;
 const latest=rows[0]?.snapshot;
 const candidates=(await db.query(`${sourceSql} ORDER BY c.block_number DESC,c.id DESC LIMIT 10`,[streamKey,PAPER_NVDA,PAPER_POOL])).rows;
 const source=candidates.find(s=>s.canonical&&s.covered&&s.coverage_identity_valid);
 const cp=source?.checkpoint as PaperCheckpoint|undefined;
 const fresh=cp&&Date.parse(now)>=Date.parse(cp.blockTimestamp)&&Date.parse(now)-Date.parse(cp.blockTimestamp)<=180000;
 const reference=fresh?await readPaperReferenceGate(db,cp,config.strategy.referencePolicy!,now):null;
 const riskRead=fresh?await readPaperRiskSources(db,cp):null,risk=riskRead&&cp?evaluatePaperCurrentRisk(riskRead,cp,config.strategy.referencePolicy!):null;
 const holding=observePilotHolding(state,{now,policy:config.strategy.holdingPolicy!,samples:rows,risk,riskRead});
 if(!latest||Date.parse(now)-Date.parse(latest.observedAt)>20000)throw new PilotGuardUnavailable(holding,'Current chain health unavailable');
 const fault=holdingChainFault(latest,30);
 if(!latest.allowBulk||fault.hard.length||fault.transient.length||!latest.anchorBlock||!latest.anchorHash)
  throw new PilotGuardUnavailable(holding,'Chain is not currently readable with quorum');
 const block=await client.getBlock({blockNumber:BigInt(latest.anchorBlock)});assert(block.hash.toLowerCase()===latest.anchorHash.toLowerCase());
 assert(Number(block.timestamp)<=Date.now()/1000&&Date.now()/1000-Number(block.timestamp)<=30,'Confirmed chain source stale');
 const readiness=evaluateCanaryEntryReadiness({now,sourceBlock:block.number,samples:rows});
 return {source:{block:String(block.number),hash:block.hash as Hex,timestamp:String(block.timestamp)},entryAllowed:readiness.chainEligible&&!!reference?.eligible,
  referencePriceX18:reference?.evidence.current.reference?.referencePriceX18??null,
  reasons:[...readiness.reasons.filter(r=>r!=='equity_session_closed'),...(reference?.reasons??['strategy_checkpoint_unavailable'])],holding};
}
