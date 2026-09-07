import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.DASHBOARD_AUDIT_URL ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage({ viewport:{width:1440,height:1000} });
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#connection-label').textContent==='Dashboard connected');
  const data = await (await page.request.get(`${base}/api/dashboard`)).json();
  assert.equal(data.paper.executionEligible,false);
  assert.equal(data.paper.policy.executionBasis,'transaction_simulation');
  assert.equal(data.paper.state.position,null);
  assert.equal(data.paper.state.pnlQuote,null);
  assert.equal(await page.locator('#paper-pnl').innerText(),'—');
  assert.equal(await page.locator('#paper-costs').innerText(),'Unavailable');
  assert.match(await page.locator('#paper-status').innerText(),/transaction simulator not implemented/);
  assert.doesNotMatch(await page.locator('#paper-panel').innerText(),/entry inventory uses a stated cost haircut/);
  assert.ok(data.paper.receiptCosts.length>0);
  assert.equal(await page.locator('#paper-receipt-costs tr').count(),data.paper.receiptCosts.length);
  await page.locator('summary').filter({hasText:'Actual transaction fees observed'}).click();
  for (const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#paper-panel').screenshot({path:new URL(`live-${name}.png`,import.meta.url).pathname});
  }
  await page.route('**/api/dashboard',route=>route.fulfill({json:{...data,paper:null}}));
  await page.evaluate(()=>refresh());
  assert.equal(await page.locator('#paper-receipt-costs tr').count(),0);
  assert.equal(await page.locator('#paper-nav').innerText(),'—');
  assert.deepEqual(errors,[]);
  const result={observedAt:data.overview.serverTime,paper:data.paper,checks:[
    'live session explicitly waits for transaction simulator',
    'no cost assumption, position or PnL',
    'actual historical fees separated and denominated in ETH',
    'desktop and mobile layouts have no page overflow',
    'missing session clears prior receipt values',
    'no browser errors',
  ]};
  await writeFile(new URL('live-snapshot.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({session:data.paper.id,checks:result.checks}));
} finally { await browser.close(); }
