import type {RangeKeeperWorkerResult} from './rangekeeper-live-wallet-worker.js';
import {redactLiveWorkerText} from './live-worker-signer.js';

export type LiveWorkerLog=(level:'info'|'warn'|'error',event:string,fields?:Record<string,unknown>)=>void;
export type LiveWorkerOutcome='observed'|'deferred'|'idle'|'progress'|'blocked'|'disabled'|'failed';

export interface LiveWorkerLoopDeps {
 intervalMs:number;maxSteps:number;signal:AbortSignal;log:LiveWorkerLog;
 /** Bounded history and snapshot maintenance. `ready:false` defers execution but is not an error. */
 maintain:()=>Promise<{ready:boolean;reasons:readonly string[]}>;
 /** Present only when signer and publisher are configured; absent means observe-only. */
 execute?:{lease:{assertHealthy:()=>Promise<void>};step:()=>Promise<RangeKeeperWorkerResult>};
 secrets?:readonly string[];
 sleep?:(ms:number,signal:AbortSignal)=>Promise<void>;
}

/** Deterministic failures (a blocked job, a throwing step) back off exponentially
 * instead of hammering the queue, capped so recovery after lease expiry stays timely. */
export function liveWorkerBackoffMs(baseMs:number,streak:number,capMs=300_000){
 return streak<=0?baseMs:Math.min(Math.max(baseMs,capMs),baseMs*2**Math.min(streak,10));
}

export const pauseLiveWorker=(durationMs:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
 if(signal.aborted){resolve();return;}
 const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
 const timer=setTimeout(done,durationMs);
 signal.addEventListener('abort',done,{once:true});
});

/** One pass: assert the lease, maintain, then step the shared wallet queue while
 * it reports progress. A lease failure throws and must stop the process; a step
 * that is already running is never interrupted by a stop request. */
export async function runLiveWorkerPass(deps:LiveWorkerLoopDeps):Promise<{outcome:LiveWorkerOutcome;steps:number}>{
 const {execute,log}=deps,reason=(error:unknown)=>redactLiveWorkerText(error,deps.secrets);
 await execute?.lease.assertHealthy();
 let prepared:{ready:boolean;reasons:readonly string[]};
 try{prepared=await deps.maintain();}
 catch(error){log('error','live_worker_maintenance_failed',{reason:reason(error)});prepared={ready:false,reasons:['maintenance_failed']};}
 if(!execute)return {outcome:'observed',steps:0};
 if(!prepared.ready)return {outcome:'deferred',steps:0};
 let steps=0;
 while(steps<deps.maxSteps&&!deps.signal.aborted){
  await execute.lease.assertHealthy();
  let result:RangeKeeperWorkerResult;
  try{result=await execute.step();}
  catch(error){log('error','live_worker_step_failed',{reason:reason(error)});return {outcome:'failed',steps};}
  steps++;
  if(result.status==='idle')return {outcome:'idle',steps};
  const fields={status:result.status,jobId:result.jobId,
   ...('stage' in result&&result.stage?{stage:result.stage}:{}),...('effectId' in result&&result.effectId?{effectId:result.effectId}:{}),
   ...('reason' in result?{reason:reason(result.reason)}:{})};
  if(result.status==='blocked'){log('error','live_worker_step',fields);return {outcome:'blocked',steps};}
  if(result.status==='disabled'){log('warn','live_worker_step',fields);return {outcome:'disabled',steps};}
  log('info','live_worker_step',fields);
 }
 return {outcome:'progress',steps};
}

/** Runs until the signal aborts. Throws only when the readiness lease is lost. */
export async function runLiveWorkerLoop(deps:LiveWorkerLoopDeps){
 const sleep=deps.sleep??pauseLiveWorker;let streak=0;
 while(!deps.signal.aborted){
  const {outcome}=await runLiveWorkerPass(deps);
  streak=outcome==='blocked'||outcome==='failed'||outcome==='disabled'?streak+1:0;
  const delay=outcome==='progress'?Math.min(1_000,deps.intervalMs):liveWorkerBackoffMs(deps.intervalMs,streak);
  if(streak>0)deps.log('warn','live_worker_backoff',{outcome,streak,delayMs:delay});
  await sleep(delay,deps.signal);
 }
}
