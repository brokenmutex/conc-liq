import { isDeepStrictEqual } from 'node:util';
import type {PaperState,PaperPolicy,PaperCheckpoint} from './engine.js';

/** Resume at a fresh source after a recorded infrastructure pause. Never
 * execute on an old checkpoint or extend the policy's maximum evidence gap. */
export function pausedPaperSourceWait(state:PaperState,policy:PaperPolicy,cp:PaperCheckpoint,now:string):'wait'|'gap_exceeded'|null {
 if(!state.position||!state.last||!state.holding?.resumeFromPause)return null;
 const age=(at:string)=>Date.parse(now)-Date.parse(at);
 if(age(state.last.blockTimestamp)>policy.maxGapSeconds*1000)return 'gap_exceeded';
 return [cp.capturedAt,cp.blockTimestamp].some(at=>age(at)>policy.maxSourceAgeSeconds*1000)?'wait':null;
}

/** Compare persisted JSON values, independent of PostgreSQL jsonb key order.
 * JSON round-tripping also matches how optional undefined properties persist.
 * Array order, values, added fields, and removed fields remain significant. */
export function samePersistedPaperState(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}
