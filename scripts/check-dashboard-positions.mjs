// Browser interaction check. Start a disposable Chromium with remote debugging
// on 127.0.0.1:9224, then pass the locally served preview URL and output prefix.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const [url='http://127.0.0.1:4174/',output='data/dashboard-connected']=process.argv.slice(2);
assert(new URL(url).hostname==='127.0.0.1','Check a local preview only');
const tabs=await fetch('http://127.0.0.1:9224/json').then(r=>r.json());
const page=tabs.find(p=>p.type==='page');assert(page);
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let sequence=0;const pending=new Map(),errors=[],requests=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);else if(m.method==='Log.entryAdded'&&m.params.entry.level==='error'&&!m.params.entry.url?.endsWith('favicon.ico'))errors.push(m.params.entry.text);else if(m.method==='Network.requestWillBeSent')requests.push(m.params.request.url);};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const checks=[];
const check=async(name,expression)=>{assert(await evaluate(expression),name);checks.push(name);};
const waitFor=async expression=>{for(let n=0;n<150;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+expression);};
try{
 await send('Page.enable');await send('Runtime.enable');await send('Log.enable');await send('Network.enable');
 await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url});
 await waitFor('!!document.querySelector("#paper-chart path") && !!document.querySelector("#live-chart path")');
 await check('Live precedes paper with recorded positions','document.querySelector("main").firstElementChild.id==="live" && document.querySelectorAll(".positions-table tbody tr").length>=2');
 await check('No fictional fixtures or preview disclosure','!document.body.textContent.includes("Example snapshot") && !document.body.textContent.includes("DESIGN PREVIEW") && !document.body.textContent.includes("MSFT")');
 await check('Same metrics and value legend in both sections','["live","paper"].every(m=>document.querySelectorAll(`#${m} .metrics .metric`).length===6 && document.querySelector(`#${m}-series-legend`).textContent.includes("Passive holding"))');
 await check('All four time controls appear in both sections','["live","paper"].every(m=>[1,6,24,168].every(h=>document.querySelector(`[data-action="hours"][data-mode="${m}"][data-value="${h}"]`)))');
 for(const mode of ['live','paper']){
  await click(`[data-action="hours"][data-mode="${mode}"][data-value="168"]`);
  await waitFor(`document.querySelector("#${mode}-bottom")?.textContent.includes("Selected 1 week")`);
  await check(mode+' week view renders dated axis and real coverage',`document.querySelector("#${mode}-chart").textContent.includes("Sep") && document.querySelector("#${mode}-bottom").textContent.includes("observed")`);
 }
 await click('[data-action="metric"][data-mode="live"][data-value="range"]');
 await check('Range chart and legend update','!!document.querySelector("#live-chart .range-line") && document.querySelector("#live-series-legend").textContent.includes("Active LP range")');
 await click('[data-action="metric"][data-mode="live"][data-value="inventory"]');
 await check('Inventory legend labels both tokens','document.querySelector("#live-series-legend").textContent.includes("NVDA allocation") && document.querySelector("#live-series-legend").textContent.includes("USDG allocation")');
 await evaluate('document.querySelector("#live-chart").focus()');
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
 await check('Keyboard chart inspection shows actual date','!document.querySelector("#live-tooltip").hidden && document.querySelector("#live-tooltip").textContent.includes("ET")');
 await click('[data-action="scope"][data-mode="paper"][data-value="history"]');
 await check('Invalid campaign keeps its original reason','document.querySelector("#paper-detail").textContent.includes("source_stale_or_worker_missed_decision")');
 await click('[data-action="evidence"]');
 await check('Interruption dialog preserves timestamp','document.querySelector("dialog").open && document.querySelector("#dialog-body").textContent.includes("Invalidated at")');
 await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
 await check('Escape closes dialog','!document.querySelector("dialog").open');
 await click('[data-action="scope"][data-mode="paper"][data-value="active"]');
 await waitFor('!!document.querySelector("#paper-chart path")');
 await click('[data-action="tab"][data-mode="live"][data-value="activity"]');
 await check('Activity includes recorded transaction actions','document.querySelector("#live-bottom").textContent.includes("block")');
 await click('#live [data-action="event"]');
 await check('Actual receipt reference in event dialog','document.querySelector("#dialog-body").textContent.includes("0x")');await click('#dialog-close');
 await click('#live [data-action="strategy"]');await check('Strategy shows recorded width','document.querySelector("#dialog-body").textContent.includes("±20 raw ticks")');await click('#dialog-close');
 await click('#diagnostics-button');await check('API and source freshness are separate','document.querySelector("#dialog-body").textContent.includes("valuation freshness independently")');await click('#dialog-close');
 await click('[data-action="metric"][data-mode="live"][data-value="value"]');await click('[data-action="tab"][data-mode="live"][data-value="sessions"]');
 await check('Desktop has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 mkdirSync(dirname(output),{recursive:true});
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(output+'-desktop.png',Buffer.from(shot.data,'base64'));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await check('Mobile has no horizontal overflow','document.documentElement.scrollWidth<=innerWidth');
 const mobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(output+'-mobile.png',Buffer.from(mobile.data,'base64'));
 assert(requests.some(u=>new URL(u).pathname.startsWith('/api/positions/')),'Real position APIs requested');
 assert.deepEqual(errors,[],'Browser exceptions or CSP failures');
 const report={at:new Date().toISOString(),url,checks,apiRequests:requests.filter(u=>new URL(u).pathname.startsWith('/api/')),browserErrors:errors};writeFileSync(output+'-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{ws.close();}
