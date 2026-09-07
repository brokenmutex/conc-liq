import assert from'node:assert/strict';import{writeFile}from'node:fs/promises';
const{chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');const browser=await chromium.launch({headless:true});
const base='http://127.0.0.1:4173';
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Dashboard connected');
 const data=await(await page.request.get(base+'/api/dashboard')).json();
 assert.equal(data.paper.id,'4');assert.equal(data.paper.executionEligible,false);assert.equal(data.paper.policy.referencePolicy.kind,'continuous_bounded_v1');
 assert.equal(data.paper.state.status,'open');assert(data.paper.state.intervals>=1);assert(BigInt(data.paper.state.observedSwaps)>0n);
 assert(data.paper.execution.runs.some(r=>r.action==='entry'&&r.status==='succeeded'));
 assert.match(await page.locator('#paper-status').innerText(),/Paper position open/);
 assert.match(await page.locator('#focus-session').innerText(),/24\/7/);
 assert.match(await page.locator('#paper-reference').innerText(),/Held equity reference.*2026-09-04.*3%/);
 assert.match(await page.locator('#paper-lifecycle').innerText(),/holding time limit/);
 assert.notEqual(await page.locator('#paper-pnl').innerText(),'—');
 assert.doesNotMatch(await page.locator('#focus-reasons').innerText(),/equity session closed|rwa oracle price stale/);
 await page.locator('summary').filter({hasText:'Paper transaction simulations'}).click();
 for(const[name,viewport]of[['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  await page.setViewportSize(viewport);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#paper-panel').screenshot({path:new URL(`live-${name}.png`,import.meta.url).pathname});
 }
 await page.route('**/api/dashboard',route=>route.fulfill({json:{...data,paper:{...data.paper,state:{...data.paper.state,reference:{...data.paper.state.reference,basis:'unavailable',referencePriceX18:null,referenceUpdatedAt:null,deviationPpm:null}}}}}));
 await page.evaluate(()=>refresh());assert.match(await page.locator('#paper-reference').innerText(),/Unavailable/);
 await page.unroute('**/api/dashboard');
 await page.route('**/api/dashboard',route=>route.fulfill({json:{...data,paper:null}}));await page.evaluate(()=>refresh());
 assert.equal(await page.locator('#paper-nav').innerText(),'—');assert.equal(await page.locator('#paper-execution-runs tr').count(),0);
 assert.doesNotMatch(await page.locator('#paper-lifecycle').innerText(),/holding time limit/);assert.deepEqual(errors,[]);
 const result={observedAt:data.overview.serverTime,paper:data.paper,entryGate:data.focus.paperEntry,checks:['actual forward entry and later holding observations visible','24/7 policy and held-reference timestamp visible','gas and exit reserve separated','holding deadline shown','legacy closed-session findings do not contradict the active paper policy','desktop/mobile without overflow','missing reference values stay unavailable without browser errors','missing-session reset clears economics','no browser errors']};
 await writeFile(new URL('live-snapshot.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({session:data.paper.id,intervals:data.paper.state.intervals,checks:result.checks}));
}finally{await browser.close()}
