import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {paperGasQuote} from '../src/paper/transaction-engine.ts';
const [gasAuditPath,paperCapturePath,studyPlanPath,marketPath,outputDir]=process.argv.slice(2);assert(outputDir);
fs.mkdirSync(outputDir,{recursive:true});const digest=x=>createHash('sha256').update(x).digest('hex');
const gas=JSON.parse(fs.readFileSync(gasAuditPath)),paper=JSON.parse(fs.readFileSync(paperCapturePath)),original=JSON.parse(fs.readFileSync(studyPlanPath));
assert.equal(gas.captureSha256,digest(fs.readFileSync(paperCapturePath)));
const units=(r,p)=>r.transactions.filter(t=>p(t.action)).reduce((n,t)=>n+BigInt(t.gas),0n),entry=gas.campaign.find(r=>r.id==='181'),exit=gas.campaign.find(r=>r.id==='182');assert(entry&&exit);
const buy=gas.proofs.find(p=>p.name==='buy'),sell=gas.proofs.find(p=>p.name==='sell');assert(buy&&sell);
const max=xs=>xs.reduce((a,b)=>a>b?a:b,0n);
const actionUnits={entry:BigInt(entry.gas),exit:BigInt(exit.gas),buy:units(entry,a=>['approve_entry_swap','buy_nvda'].includes(a)),
 recenter:{remove:max(gas.proofs.map(r=>units(r,a=>a==='decrease_and_collect'))),mint:max(gas.proofs.map(r=>units(r,a=>a.includes('mint')))),buy:units(buy,a=>['approve_recenter_swap','recenter_buy_nvda'].includes(a)),sell:units(sell,a=>['approve_recenter_swap','recenter_sell_nvda'].includes(a))}};
assert([entry,exit,...gas.proofs].every(r=>r.parentQuote===0),'Nonzero parent fees require separate repricing');
const valuation=paper.rows.find(r=>r.id==='182').valuation;
const prices=[120000000n,200000000n,820000000n],quote=(units,price)=>String(paperGasQuote(String(units*price),valuation));
const profiles=prices.map(price=>({id:`uniform_${price}_wei`,entry:quote(actionUnits.entry,price),exit:quote(actionUnits.exit,price),buy:quote(actionUnits.buy,price),feePpm:1000000,recenter:Object.fromEntries(Object.entries(actionUnits.recenter).map(([k,v])=>[k,quote(v,price)]))}));
const plan={...original,createdAt:new Date().toISOString(),profiles,auditOnly:true,sourceGasAuditSha256:digest(fs.readFileSync(gasAuditPath)),actionUnits,valuation,
 method:'Same node-estimated action gas units, one common native gas price for every action, and one ETH/USDG valuation per profile. Fixed-price sensitivity, not contemporaneous historical or future quotes.'};delete plan.frozenAt;delete plan.prospective;
const encoded=JSON.stringify(plan,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n',planPath=path.join(outputDir,'plan.json'),resultPath=path.join(outputDir,'raw-replay.json');
fs.writeFileSync(planPath,encoded,{flag:'wx'});
const r=spawnSync(process.execPath,['--import','tsx','scripts/replay-offhours-recenter.mjs',marketPath,planPath,resultPath],{encoding:'utf8',timeout:30*60*1000,maxBuffer:8*1024*1024});
fs.writeFileSync(path.join(outputDir,'replay.log'),r.stdout??'');if(r.status!==0){process.stderr.write(r.stderr??'');throw Error(`Replay failed: ${r.status}`);}
const replay=JSON.parse(fs.readFileSync(resultPath));
const result={computedAt:new Date().toISOString(),codeSha256:digest(fs.readFileSync('scripts/lp-gas-regime-sensitivity.mjs')),planSha256:digest(encoded),rawReplaySha256:digest(fs.readFileSync(resultPath)),captureSha256:replay.captureSha256,method:plan.method,
 actionUnits:plan.actionUnits,valuation,profiles,aggregates:replay.aggregates,
 windows:replay.windows.map(w=>({...w,results:w.results.map(({actions,rejections,...r})=>({...r,rejections}))})),
 caveats:['Overrides the original runner cost-description boilerplate; profiles use common gas prices with full modeled fee income, not its fixed 2x-gas half-fee scenario','Recorded node estimates still differ from actual receipts and can depend on operation prestate','Parent estimates were zero for these probes; future parent costs are not assumed zero','All original guards, fees, swaps and execution-delay rules remain; cost-dependent actions are rerun, not simply repriced after the fact','Three historical windows remain a small correlated sample. No prospective plan or paper settings changed']};
const summary=JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';fs.writeFileSync(path.join(outputDir,'summary.json'),summary,{flag:'wx'});fs.writeFileSync(path.join(outputDir,'summary.json.sha256'),digest(summary)+'\n',{flag:'wx'});console.log(JSON.stringify(replay.aggregates.map(a=>({profile:a.profile,cap:a.cap,mode:a.rangePolicy,pnl:a.meanPnl,delta:a.meanDeltaSameCap,recenters:a.recenters})),null,2));
