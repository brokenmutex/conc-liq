import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const base=process.env.DASHBOARD_AUDIT_URL??'http://127.0.0.1:4173';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);
 await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Dashboard connected');
 const data=await(await page.request.get(`${base}/api/dashboard`)).json();
 assert.equal(data.paper.executionEligible,false);
 assert.equal(data.paper.policy.executionBasis,'nitro_fork_v1');
 assert.equal(data.paper.policy.mode,'guarded');
 assert.equal(data.paper.state.position,null);
 assert.equal(data.paper.state.pnlQuote,null);
 assert.equal(await page.locator('#paper-pnl').innerText(),'—');
 assert.equal(await page.locator('#paper-costs').innerText(),'No trades yet');
 assert.doesNotMatch(await page.locator('#paper-panel').innerText(),/simulator not implemented|flat charge applied/);
 assert.match(await page.locator('#paper-execution-proof').innerText(),/10 calls verified.*not forward strategy performance/);
 assert.match(await page.locator('#focus-rehearsal').innerText(),/Cash-to-cash calls verified/);
 assert.equal(data.paper.execution.rehearsal.totalGasWei,'466529295616000');
 assert.equal(data.paper.execution.runs.length,0);
 await page.locator('summary').filter({hasText:'Actual transaction fees observed'}).click();
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
  await page.setViewportSize(viewport);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#paper-panel').screenshot({path:new URL(`live-${name}.png`,import.meta.url).pathname});
 }
 // The table must render action evidence and clear it on a later missing session.
 const rows=[{id:'fixture',action:'entry',status:'succeeded',observedAt:data.overview.serverTime,block:'56666711',gasWei:'279173732812000',error:null}];
 await page.route('**/api/dashboard',route=>route.fulfill({json:{...data,paper:{...data.paper,execution:{...data.paper.execution,runs:rows}}}}));
 await page.evaluate(()=>refresh());
 assert.equal(await page.locator('#paper-execution-runs tr').count(),1);
 assert.match(await page.locator('#paper-execution-runs').textContent(),/0\.000279173/);
 await page.unroute('**/api/dashboard');
 await page.route('**/api/dashboard',route=>route.fulfill({json:{...data,paper:null}}));
 await page.evaluate(()=>refresh());
 assert.equal(await page.locator('#paper-execution-runs tr').count(),0);
 assert.equal(await page.locator('#paper-receipt-costs tr').count(),0);
 assert.equal(await page.locator('#paper-nav').innerText(),'—');
 assert.deepEqual(errors,[]);
 const result={observedAt:data.overview.serverTime,paper:data.paper,entryReadiness:data.focus.entryReadiness,riskReasons:data.focus.riskGate.reasons,checks:[
  'guarded simulator session active without invented fills or PnL','dated round trip and native gas estimate visible separately','focus panel reflects latest execution mechanics','historical receipt costs remain separate','execution action table and reset verified with labelled browser fixture','desktop and mobile without page overflow','no browser errors']};
 await writeFile(new URL('live-snapshot.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({session:data.paper.id,checks:result.checks}));
}finally{await browser.close();}
