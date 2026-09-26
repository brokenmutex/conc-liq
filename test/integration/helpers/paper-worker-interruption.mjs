// POSIX process controls for recovery acceptance fixtures. The caller owns
// worker creation and durable-operation assertions; these helpers only prove
// the real process/readiness-lease interruption boundary.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(read,expected,label,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(await read()===expected)return;
  await sleep(50);
 }
 throw Error(`Timed out waiting for ${label}`);
}

/** Freeze a live worker while preserving its PostgreSQL readiness lease.
 * This lets a caller accept durable work while proving the worker cannot
 * claim it until the interrupted process is replaced. */
export async function suspendPaperWorker(worker,readinessCheck,{timeoutMs=5_000}={}){
 assert(worker&&worker.exitCode===null,'paper worker must be running before suspension');
 assert.equal(await readinessCheck(),true,'worker readiness lease must be held before suspension');
 assert.equal(worker.kill('SIGSTOP'),true,'could not suspend paper worker');
 await waitFor(async()=>{
  try{
   const stat=await readFile(`/proc/${worker.pid}/stat`,'utf8'),state=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[0];
   return state==='T'||state==='t';
  }catch{return false;}
 },true,'worker suspension',timeoutMs);
 // SIGSTOP does not set ChildProcess.exitCode. Keep an explicit liveness and
 // lease assertion so process death cannot masquerade as a frozen worker.
 assert.equal(worker.exitCode,null,'suspended worker unexpectedly exited');
 assert.equal(await readinessCheck(),true,'suspended process must retain its readiness lease');
 return {pid:worker.pid,signal:'SIGSTOP',readinessLeaseRetained:true};
}

/** Kill a deliberately suspended child and wait until PostgreSQL releases its
 * session advisory lease. The caller can then start its ordinary worker path. */
export async function killSuspendedPaperWorker(worker,readinessCheck,{timeoutMs=10_000}={}){
 assert(worker&&worker.exitCode===null,'paper worker must remain suspended and alive');
 assert.equal(await readinessCheck(),true,'suspended worker readiness lease was lost early');
 const exited=once(worker,'exit');
 assert.equal(worker.kill('SIGKILL'),true,'could not terminate suspended paper worker');
 const [exitCode,signalCode]=await Promise.race([exited,
  sleep(timeoutMs).then(()=>{throw Error('Timed out waiting for interrupted paper worker exit');})]);
 assert.equal(exitCode,null,'suspended worker must terminate from SIGKILL');
 assert.equal(signalCode,'SIGKILL','suspended worker exit must report SIGKILL');
 await waitFor(readinessCheck,false,'worker readiness lease release',timeoutMs);
 return {pid:worker.pid,signal:'SIGKILL',readinessLeaseReleased:true};
}
