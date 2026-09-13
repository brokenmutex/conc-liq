// Offline resumable runner. Capture is a separate read-only operation.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.argv[2]??'data/adaptive-lp-universe-study-2026-09-13';
const read=p=>JSON.parse(readFileSync(p)),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),memo=process.argv.includes('--memo'),workers=Number(process.argv.find(a=>a.startsWith('--workers='))?.split('=')[1]??3);assert(Number.isInteger(workers)&&workers>=1&&workers<=5);
if(memo){const proof=read(root+'/memo-validation/certificate.json');assert(proof.exhaustivePassed&&proof.quoteConformancePassed&&proof.controlByteIdentical);assert.equal(proof.quoteHookSha256,hash('scripts/lp-empty-quote-hook.mjs'));assert.equal(proof.quoteSourceSha256,hash('src/research/portfolio-math.ts'));assert.equal(proof.quoteConformanceSha256,hash(root+'/memo-validation/quote-conformance.json'));assert.equal(proof.hookSha256,hash('scripts/lp-tick-memo-hook.mjs'));assert.equal(proof.sourceSha256,hash('src/backtest/principal.ts'));assert.equal(proof.exhaustiveSha256,hash(root+'/memo-validation/exhaustive.json'));assert.equal(proof.controlSha256,hash(proof.controlResult));assert.equal(proof.controlSha256,hash(proof.originalResult));}
mkdirSync(root+'/logs',{recursive:true});
const run=(script,args,log)=>new Promise((resolve,reject)=>{const useMemo=memo&&(script==='scripts/adaptive-lp-universe-study.mjs'||script==='scripts/audit-adaptive-lp-universe.mjs');writeFileSync(root+'/logs/'+log+'.execution.json',JSON.stringify({script,args,memoization:useMemo?{hookSha256:hash('scripts/lp-tick-memo-hook.mjs'),quoteHookSha256:hash('scripts/lp-empty-quote-hook.mjs'),certificateSha256:hash(root+'/memo-validation/certificate.json')}:null,startedAt:new Date().toISOString()})+'\n');const fd=openSync(root+'/logs/'+log,'a'),child=spawn(process.execPath,['--import','tsx',...(useMemo?['--import','./scripts/lp-tick-memo-hook.mjs','--import','./scripts/lp-empty-quote-hook.mjs']:[]),script,...args],{stdio:['ignore',fd,fd]});closeSync(fd);child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${script} ${args.join(' ')} failed (${code}); see ${log}`)));});
// Optional coordination with a separately running capture; never initiates RPC.
if(process.argv.includes('--await-capture'))while(!existsSync(root+'/completed.json')){if(existsSync(root+'/capture.log'))assert(!readFileSync(root+'/capture.log','utf8').includes('"failed":true'),'Capture failed');await new Promise(resolve=>setTimeout(resolve,5000));}
assert(existsSync(root+'/completed.json'),'Finish canonical capture first');
if(!existsSync(root+'/inclusion.json'))await run('scripts/prepare-adaptive-lp-universe.mjs',[root],'prepare.log');
const inclusion=read(root+'/inclusion.json'),plan=read(root+'/capture.json').plan;
const tasks=inclusion.included.flatMap(a=>plan.budgetsQuote.map(b=>({symbol:a.symbol,budget:b})));
async function worker(){for(;;){const t=tasks.shift();if(!t)return;const key=t.symbol+'-'+t.budget;if(!existsSync(root+'/runs/'+key+'/completed.json')){console.log(JSON.stringify({stage:'run_started',...t}));await run('scripts/adaptive-lp-universe-study.mjs',[t.symbol,t.budget,root],key+'.log');}console.log(JSON.stringify({stage:'run_complete',...t}));}}
await Promise.allSettled(Array.from({length:workers},()=>worker())).then(results=>{for(const r of results)if(r.status==='rejected')throw r.reason;});
const audits=inclusion.included.map(a=>a.symbol);
async function auditor(){for(;;){const symbol=audits.shift();if(!symbol)return;if(!existsSync(root+'/reconstruction-'+symbol+'.json')){console.log(JSON.stringify({stage:'audit_started',symbol}));await run('scripts/audit-adaptive-lp-universe.mjs',[root,symbol],'audit-'+symbol+'.log');}console.log(JSON.stringify({stage:'audit_complete',symbol}));}}
await Promise.allSettled([auditor(),auditor()]).then(results=>{for(const r of results)if(r.status==='rejected')throw r.reason;});
console.log(JSON.stringify({stage:'all_runs_and_reconstructions_complete',assets:inclusion.included.length}));
