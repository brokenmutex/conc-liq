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
export async function suspendPaperWorker(worker,readinessCheck,
 {timeoutMs=5_000,readRuntimeBackends}={}){
 assert(worker&&worker.exitCode===null,'paper worker must be running before suspension');
 const deadline=Date.now()+timeoutMs,quiescenceSamples=[];
 const boundedRead=async read=>{
  let timer;
  try{return await Promise.race([read(),new Promise((_,reject)=>{
   timer=setTimeout(()=>reject(Error('Timed out waiting for an idle worker suspension within the bounded window')),
    Math.max(1,deadline-Date.now()));
  })]);}
  finally{clearTimeout(timer);}
 };
 assert.equal(await boundedRead(readinessCheck),true,
  'worker readiness lease must be held before suspension');
 const processStopped=async()=>{
  try{
   const stat=await readFile(`/proc/${worker.pid}/stat`,'utf8'),
    state=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[0];
   return state==='T'||state==='t';
  }catch{return false;}
 };
 const resume=()=>{
  if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGCONT');
 };
 try{
  while(Date.now()<deadline){
   assert.equal(worker.exitCode,null,'paper worker unexpectedly exited before suspension');
   assert.equal(worker.kill('SIGSTOP'),true,'could not suspend paper worker');
   while(Date.now()<deadline&&!(await processStopped()))await sleep(25);
   if(!(await processStopped()))throw Error('Timed out waiting for worker suspension');
   if(Date.now()>=deadline)throw Error('Timed out waiting for an idle worker suspension within the bounded window');
   // Two idle observations after SIGSTOP prove that no tagged runtime session
   // has an active statement or open transaction whose locks the frozen
   // process could retain. The caller supplies the database-scoped predicate.
   const sample={first:null,second:null};quiescenceSamples.push(sample);
   if(readRuntimeBackends){
    sample.first=await boundedRead(readRuntimeBackends);
    if(sample.first?.quiescent){
     await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
     sample.second=await boundedRead(readRuntimeBackends);
    }
   }
   if(Date.now()>=deadline)throw Error('Timed out waiting for an idle worker suspension within the bounded window');
   if(!readRuntimeBackends||(sample.first?.quiescent&&sample.second?.quiescent)){
    assert.equal(worker.exitCode,null,'suspended worker unexpectedly exited');
    assert.equal(await boundedRead(readinessCheck),true,
     'suspended process must retain its readiness lease');
    if(Date.now()>=deadline)throw Error('Timed out waiting for an idle worker suspension within the bounded window');
    return {pid:worker.pid,signal:'SIGSTOP',readinessLeaseRetained:true,
     runtimeDatabaseQuiescence:readRuntimeBackends?sample:null};
   }
   resume();
   await sleep(Math.min(50,Math.max(1,deadline-Date.now())));
  }
  throw Error('Timed out waiting for an idle worker suspension within the bounded window');
 }catch(error){
  resume();
  if(error instanceof Error)error.runtimeDatabaseQuiescenceSamples=quiescenceSamples;
  throw error;
 }
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
