// Read-only shared-view probe for a RangeKeeper paper campaign. The caller owns
// the real command server and canonical campaign; this helper uses its actual
// API/assets and never intercepts requests or clicks an operation control.
import assert from 'node:assert/strict';
import {startDashboardBrowser} from './helpers/dashboard-browser.mjs';

const PAPER_POSITION_ID=id=>`paper-dep-${id}`;
const waitFor=async(page,expression,label)=>{
 try{await page.waitFor(expression,20_000);}
 catch{throw Error(`RangeKeeper browser view unavailable: ${label}`);}
};

function validateInput({origin,campaignId,status}){
 let parsed;
 try{parsed=new URL(origin);}catch{throw Error('RangeKeeper browser view requires a local command origin');}
 if(!['http:','https:'].includes(parsed.protocol)||
  !['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname))
  throw Error('RangeKeeper browser view is restricted to a loopback command origin');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaignId??''))
  throw Error('RangeKeeper browser view requires a campaign UUID');
 if(!['open','closed'].includes(status))throw Error('RangeKeeper browser view status must be open or closed');
 return parsed.origin;
}

/** Verify shared paper position/history rendering for one actual campaign.
 * `status: open` includes active or paused open campaigns; closed campaigns are
 * read from History. The API is fetched directly from the browser origin and
 * the same actual campaign must also appear in the rendered dashboard. */
export async function verifyRangeKeeperPaperBrowserView({origin,campaignId,status}){
 const commandOrigin=validateInput({origin,campaignId,status}),id=PAPER_POSITION_ID(campaignId),checks=[];
 let browser;
 try{
  browser=await startDashboardBrowser();
  const {page}=browser;
  await page.send('Emulation.setDeviceMetricsOverride',{
   width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page.send('Page.navigate',{url:`${commandOrigin}/operator`});
  await waitFor(page,'document.readyState==="complete"','operator dashboard load');
  await waitFor(page,'window.concliqOperatorAuthenticated?.()===true','real operator session handshake');

  const api=await page.evaluate(`(async()=>{
   const overviewResponse=await fetch('/api/positions');
   if(!overviewResponse.ok)throw Error('positions_api_unavailable');
   const overview=await overviewResponse.json();
   const rows=overview.positions??[];
   const found=rows.filter(row=>row.mode==='paper'&&row.deployment?.campaignId===${JSON.stringify(campaignId)});
   if(found.length!==1)throw Error('campaign_not_unique_in_positions_api');
   const selected=found[0];
   const detailResponse=await fetch('/api/positions/'+encodeURIComponent(selected.id)+'?hours=0');
   if(!detailResponse.ok)throw Error('position_history_api_unavailable');
   return {selected,detail:await detailResponse.json()};
  })()`);
  assert.equal(api.selected.id,id,'paper campaign ID must match the deployment API identity');
  assert.equal(api.selected.deployment.campaignId,campaignId);
  assert.equal(api.selected.deployment.strategyId,'rangekeeper_v1');
  if(status==='open')assert(['active','paused'].includes(api.selected.deployment.lifecycle),
   'open view requires an active or paused campaign');
  else{
   assert.equal(api.selected.deployment.lifecycle,'closed','closed view requires a closed campaign');
   assert.equal(api.selected.history,true,'closed campaign must be classified as history');
  }
  assert.equal(api.detail.position.deployment.campaignId,campaignId);
  assert.equal(api.detail.position.mode,'paper');
  assert(api.detail.performance&&Number.isSafeInteger(api.detail.performance.markCount)&&
   api.detail.performance.markCount>0,'campaign detail must contain persisted mark history');
  assert(Array.isArray(api.detail.events),'campaign detail must expose the recorded activity history');
  if(status==='closed')assert(api.detail.performance.timeline?.some(point=>point.action==='exit'),
   'retained close must appear as an exit in position history');
  checks.push('actual API returns the requested RangeKeeper paper campaign and persisted detail history');

  await page.evaluate(`document.getElementById('positions-tab')?.click()`);
  if(status==='closed'){
   await page.evaluate(`document.querySelector('#paper button[data-action="scope"][data-value="history"]')?.click()`);
  }
  await waitFor(page,`document.querySelector('#paper tr[data-position="${id}"]')!==null`,
   `${status} campaign row in paper positions`);
  await page.evaluate(`document.querySelector('#paper tr[data-position="${id}"] .position-select')?.click()`);
  await page.evaluate(`(()=>{const all=document.querySelector('#paper button[data-action="hours"][data-value="0"]');all?.click();return true;})()`);
  await waitFor(page,`document.querySelector('#paper-detail .chart-footnote')?.textContent.includes('marks')`,
   'campaign detail history view');
  await waitFor(page,`document.querySelector('#paper-detail .metric')!==null`,'campaign economics facts');

  if(status==='open'){
   await waitFor(page,`document.querySelector('#paper-detail .retain-action-root button.retain-preview-button')!==null`,
    'read-only retained-close control');
   const action=await page.evaluate(`(()=>{const button=document.querySelector('#paper-detail .retain-action-root button.retain-preview-button');
    return button?{text:button.textContent,disabled:button.disabled}:null;})()`);
   assert.equal(action?.text,'Review retain-close');
   assert.equal(action.disabled,false,'open campaign should expose an enabled read-only review control');
   checks.push('open campaign shows its retained-close review control without invoking it');
  }else{
   const action=await page.evaluate(`Boolean(document.querySelector('#paper-detail .retain-action-root, #paper-detail button.retain-preview-button'))`);
   assert.equal(action,false,'closed campaign must not show an active retained-close control');
   checks.push('closed campaign has no retained-close control');
  }

  const economics=await page.evaluate(`(()=>Object.fromEntries(
   [...document.querySelectorAll('#paper-detail .metric')].map(metric=>[
    metric.querySelector('.metric-label')?.textContent.trim(),
    metric.querySelector('.metric-value')?.textContent.trim()])) )()`);
  for(const label of ['Net value','Net P&L','LP fees','Paid execution costs'])
   assert.equal(economics[label],'—',`${label} must remain unavailable in the dashboard`);
  assert.equal(economics['Modeled cost / fees'],'—','fee/cost ratio must remain unavailable');
  checks.push('unavailable net value, P&L, fees and paid costs remain dashes');

  await page.evaluate(`document.querySelector('#paper button[data-action="tab"][data-value="activity"]')?.click()`);
  await waitFor(page,'document.querySelectorAll("#paper-bottom .activity-list li").length>0',
   'recorded operation activity');
  const activity=await page.evaluate(`document.querySelector('#paper-bottom .activity-list')?.textContent??''`);
  assert.match(activity,/open/i,'activity should include the opening operation');
  if(status==='closed')assert.match(activity,/close_retain/i,'closed activity should include retained close');
  checks.push('actual operation history is rendered in the detail activity table');

  await page.send('Emulation.setDeviceMetricsOverride',{
   width:390,height:844,deviceScaleFactor:1,mobile:true});
  const mobile=await page.evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
   campaign:document.querySelector('#paper tr[data-position="${id}"]')!==null,
   closeControl:Boolean(document.querySelector('#paper-detail .retain-action-root button.retain-preview-button'))})`);
  assert.equal(mobile.campaign,true,'campaign must remain visible on the mobile dashboard');
  assert(mobile.scrollWidth<=mobile.width,'mobile dashboard must not overflow horizontally');
  assert.equal(mobile.closeControl,status==='open','mobile close-control state must match campaign lifecycle');
  const mobileEconomics=await page.evaluate(`(()=>Object.fromEntries(
   [...document.querySelectorAll('#paper-detail .metric')].map(metric=>[
    metric.querySelector('.metric-label')?.textContent.trim(),
    metric.querySelector('.metric-value')?.textContent.trim()])))()`);
  for(const label of ['Net value','Net P&L','LP fees','Paid execution costs','Modeled cost / fees'])
   assert.equal(mobileEconomics[label],'—',`mobile ${label} must remain unavailable`);
  checks.push('same campaign, economics and lifecycle affordance fit the mobile dashboard');
  return {checks,status,campaignId};
 }catch(error){
  if(error instanceof assert.AssertionError)throw error;
  if(error?.message?.startsWith('RangeKeeper browser view'))throw error;
  throw Error('RangeKeeper paper dashboard view probe failed safely');
 }finally{await browser?.close().catch(()=>{});}
}
