'use strict';

export const SETUP_PREFLIGHT_PATH = '/api/deployments/setup-preflight';

export function capitalToQuoteRaw(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return raw > 0n && raw <= 100_000n * 1_000_000n ? String(raw) : null;
}

function normalizeSetupLimits(limits) {
  const fields=['maxDeploymentValue','minDeploymentValue','maxExposurePpm','maxLossValue','maxDrawdownPpm',
    'maxActionCost','maxRollingCost','maxCampaignCost','exitReserveWei','maxSlippageBps'];
  if(!limits||typeof limits!=='object')return null;
  const normalized={};
  for(const field of fields){
    const value=String(limits[field]??'');
    if(!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)<=0n)return null;
    normalized[field]=['maxExposurePpm','maxDrawdownPpm','maxSlippageBps'].includes(field)?Number(value):value;
  }
  if(normalized.maxExposurePpm>1_000_000||normalized.maxDrawdownPpm>1_000_000||normalized.maxSlippageBps>500||
    BigInt(normalized.minDeploymentValue)>BigInt(normalized.maxDeploymentValue)||
    BigInt(normalized.maxActionCost)>BigInt(normalized.maxRollingCost)||
    BigInt(normalized.maxActionCost)>BigInt(normalized.maxCampaignCost))return null;
  return normalized;
}

export function setupPreflightRequest({ pool, capital, halfWidthTicks, strategyId, mode, limits }) {
  if (strategyId !== 'static_manual_v1' || mode !== 'paper') {
    return { available: false, reason: 'Only static/manual paper setup preflight is implemented.' };
  }
  const profileId = pool?.marketProfileId ?? pool?.profileId;
  if (typeof profileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) {
    return { available: false, reason: 'The registered market profile ID is missing from the pool data; no preflight was sent.' };
  }
  const capitalQuoteRaw = capitalToQuoteRaw(capital);
  const spacing = Number(pool.tickSpacing);
  const ticks = Number(halfWidthTicks);
  if (!capitalQuoteRaw || !Number.isSafeInteger(spacing) || spacing < 1 ||
      !Number.isSafeInteger(ticks) || ticks < spacing || ticks % spacing !== 0) {
    return { available: false, reason: 'Choose valid USDG capital and a half-width aligned to the registered pool tick spacing.' };
  }
  const normalizedLimits=limits===undefined?undefined:normalizeSetupLimits(limits);
  if(limits!==undefined&&!normalizedLimits)return {available:false,reason:'Enter all valid static/manual limits in their displayed units before review.'};
  return { available: true, payload: { profileId, capitalQuoteRaw, halfWidthTicks: ticks,
    ...(normalizedLimits?{limits:normalizedLimits}:{}) } };
}

export function preflightFacts(result) {
  if (!result || typeof result !== 'object') return [];
  const facts = [];
  if (result.profile) facts.push(['Registered pool / fee tier', `${result.profile.pool ?? 'Unavailable'} · ${result.profile.fee ?? 'Unavailable'}`]);
  if (result.profileHash) facts.push(['Registered market profile hash', String(result.profileHash)]);
  if (result.source?.block !== undefined) facts.push(['Confirmed source block', String(result.source.block)]);
  if (result.source?.hash) facts.push(['Confirmed source hash', String(result.source.hash)]);
  if (result.range) {
    facts.push(['Observed center tick', String(result.range.centerTick ?? 'Unavailable')]);
    facts.push(['Aligned center tick', String(result.range.centerAnchorTick ?? 'Unavailable')]);
    facts.push(['Tick bounds', `${result.range.tickLower ?? 'Unavailable'} to ${result.range.tickUpper ?? 'Unavailable'}`]);
    facts.push(['Price bounds · USDG per token', `${formatX18(result.range.lowerPriceQuotePerBaseX18)} to ${formatX18(result.range.upperPriceQuotePerBaseX18)}`]);
  }
  if (result.requirements) {
    facts.push([`Token 0 required · raw · ${shortToken(result.profile?.token0)}`, String(result.requirements.token0Raw ?? 'Unavailable')]);
    facts.push([`Token 1 required · raw · ${shortToken(result.profile?.token1)}`, String(result.requirements.token1Raw ?? 'Unavailable')]);
    facts.push(['Budget remaining · raw USDG', String(result.requirements.budgetResidualQuoteRaw ?? 'Unavailable')]);
  }
  if (result.references?.proofHash) facts.push(['Independent reference proof', String(result.references.proofHash)]);
  if (result.references?.price0) facts.push(['Independent token 0 reference · USD', formatX18(result.references.price0)]);
  if (result.references?.price1) facts.push(['Independent token 1 reference · USD', formatX18(result.references.price1)]);
  if (result.costs?.status) facts.push(['Cost estimate', result.costs.status === 'provisional' ? 'Provisional fork estimate' : 'Unavailable']);
  for (const [label, row] of [['Open', result.costs?.open], ['Retain close', result.costs?.closeRetain]]) {
    if (row) {
      facts.push([`${label} gas · expected / bound`, `${row.expectedGasUnits ?? 'Unavailable'} / ${row.boundGasUnits ?? 'Unavailable'} units`]);
      facts.push([`${label} cost · expected / bound · USDG`, `${formatX18(row.expectedValue)} / ${formatX18(row.boundValue)}`]);
    }
  }
  if (result.admissionLimits?.status) facts.push(['Admission limits', result.admissionLimits.status === 'available' ? 'Checked' : 'Not evaluated']);
  if (Array.isArray(result.costs?.missing) && result.costs.missing.length) facts.push(['Cost evidence gaps', result.costs.missing.join(', ')]);
  return facts;
}

const RAW_INTEGER = /^(0|[1-9][0-9]*)$/;
const PROFILE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const STATIC_LIMIT_FIELDS = ['maxDeploymentValue','minDeploymentValue','maxExposurePpm',
  'maxLossValue','maxDrawdownPpm','maxActionCost','maxRollingCost','maxCampaignCost',
  'exitReserveWei','maxSlippageBps'];

/** Build a local, read-only draft proposal from an exact available preflight.
 * This function never submits the result to the command API. */
export function reviewStaticPaperDraftBinding({ walletAddress, preflight, nativeWei, limits, now = Date.now() }) {
  const missing = [];
  if (!EVM_ADDRESS.test(String(walletAddress ?? '').trim())) missing.push('wallet_address_invalid_or_missing');
  if (!preflight || preflight.kind !== 'paper_setup_preflight' || preflight.status !== 'available' ||
      preflight.mode !== 'paper' || preflight.strategyId !== 'static_manual_v1' ||
      !PROFILE_UUID.test(preflight.profileId ?? '') || !EVM_ADDRESS.test(preflight.profile?.pool ?? '') ||
      !/^[0-9a-f]{64}$/.test(preflight.profileHash ?? '') ||
      !Number.isSafeInteger(preflight.profile?.fee) || !Number.isSafeInteger(preflight.profile?.tickSpacing) ||
      !RAW_INTEGER.test(preflight.input?.capitalQuoteRaw ?? '') ||
      !Number.isSafeInteger(preflight.input?.halfWidthTicks) ||
      !RAW_INTEGER.test(preflight.requirements?.token0Raw ?? '') ||
      !RAW_INTEGER.test(preflight.requirements?.token1Raw ?? '') ||
      !EVM_HASH.test(preflight.source?.hash ?? '') || !RAW_INTEGER.test(String(preflight.source?.block ?? '')) ||
      !Number.isSafeInteger(preflight.source?.timestamp) || !Number.isSafeInteger(preflight.range?.tickLower) ||
      !Number.isSafeInteger(preflight.range?.tickUpper) || preflight.range.tickLower >= preflight.range.tickUpper) {
    missing.push('fresh_registered_profile_or_exact_preflight_binding_unavailable');
  } else {
    const sourceAge = now - preflight.source.timestamp * 1000;
    if (sourceAge < 0 || sourceAge > 180_000) missing.push('preflight_source_expired');
  }
  if (!RAW_INTEGER.test(String(nativeWei ?? '')) || BigInt(RAW_INTEGER.test(String(nativeWei ?? '')) ? nativeWei : '0') <= 0n) {
    missing.push('proposed_native_allocation_wei_missing');
  }
  const normalizedLimits = {};
  for (const field of STATIC_LIMIT_FIELDS) {
    const value = String(limits?.[field] ?? '');
    if (!RAW_INTEGER.test(value) || BigInt(RAW_INTEGER.test(value) ? value : '0') <= 0n) {
      missing.push(`static_limit_${field}_missing_or_invalid`);
      continue;
    }
    normalizedLimits[field] = ['maxExposurePpm','maxDrawdownPpm','maxSlippageBps'].includes(field) ? Number(value) : value;
  }
  if(preflight?.input?.limits&&JSON.stringify(preflight.input.limits)!==JSON.stringify(normalizedLimits))
    missing.push('static_limits_changed_since_cost_preparation');
  if (normalizedLimits.maxExposurePpm > 1_000_000) missing.push('static_limit_maxExposurePpm_out_of_range');
  if (normalizedLimits.maxDrawdownPpm > 1_000_000) missing.push('static_limit_maxDrawdownPpm_out_of_range');
  if (normalizedLimits.maxSlippageBps > 500) missing.push('static_limit_maxSlippageBps_out_of_range');
  if (preflight?.status === 'available' && RAW_INTEGER.test(normalizedLimits.maxDeploymentValue ?? '') &&
      RAW_INTEGER.test(normalizedLimits.minDeploymentValue ?? '') &&
      BigInt(normalizedLimits.minDeploymentValue) > BigInt(normalizedLimits.maxDeploymentValue))
    missing.push('static_minimum_deployment_exceeds_maximum');
  if (preflight?.status === 'available' && RAW_INTEGER.test(normalizedLimits.maxActionCost ?? '') &&
      RAW_INTEGER.test(normalizedLimits.maxRollingCost ?? '') &&
      BigInt(normalizedLimits.maxActionCost) > BigInt(normalizedLimits.maxRollingCost))
    missing.push('static_action_cost_exceeds_rolling_limit');
  if (preflight?.status === 'available' && RAW_INTEGER.test(normalizedLimits.maxActionCost ?? '') &&
      RAW_INTEGER.test(normalizedLimits.maxCampaignCost ?? '') &&
      BigInt(normalizedLimits.maxActionCost) > BigInt(normalizedLimits.maxCampaignCost))
    missing.push('static_action_cost_exceeds_campaign_limit');
  if (missing.length) return { status: 'incomplete', missing };
  return { status: 'reviewable', missing: [], binding: {
    campaignRevision: null,
    profileId: preflight.profileId,
    profileHash: preflight.profileHash,
    source: preflight.source,
    proposedDraft: {
      mode: 'paper', chainId: 4663, wallet: walletAddress.trim(), marketProfileId: preflight.profileId,
      strategyId: 'static_manual_v1', strategyVersion: '1.0.0', stateSchemaVersion: 1,
      allocation: { token0Raw: preflight.requirements.token0Raw,
        token1Raw: preflight.requirements.token1Raw, nativeWei: String(nativeWei) },
      config: { halfWidthTicks: preflight.input.halfWidthTicks, limits: normalizedLimits },
    },
  } };
}

function shortToken(value) {
  return typeof value === 'string' && value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value ?? 'Unavailable';
}

function formatX18(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'Unavailable';
  const n = BigInt(value), whole = n / 10n ** 18n, fraction = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${fraction}`;
}

if (typeof document !== 'undefined') bootDashboardTabs();

function bootDashboardTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
      item.tabIndex = selected ? 0 : -1;
    }
    document.getElementById('status').hidden = tab.id !== 'research-tab';
    document.getElementById('connection-status').hidden = tab.id !== 'positions-tab';
    if (tab.id === 'positions-tab') window.dispatchEvent(new Event('resize'));
  }
  for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab));
  document.querySelector('.top-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = tabs.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[index].focus(); selectTab(tabs[index]); event.preventDefault();
  });
  tabs.forEach((tab, index) => { tab.tabIndex = index === 0 ? 0 : -1; });

  const poolSelect = document.getElementById('setup-pool');
  const widthSelect = document.getElementById('setup-width');
  const reviewButton = document.getElementById('setup-review-button');
  const setupNote = document.getElementById('setup-status');
  const authPanel = document.getElementById('operator-auth');
  const loginForm = document.getElementById('operator-login-form');
  const logoutButton = document.getElementById('operator-logout');
  const onOperatorOrigin = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (authPanel) authPanel.hidden = !onOperatorOrigin;
  document.getElementById('saved-paper-drafts').hidden=!onOperatorOrigin;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let registeredPools = [];
  let marketProfiles = [];
  let researchPools = [];
  let currentSetupPreflight = null;
  let csrfToken = null;
  let pendingDraftRequestId = null;
  let pendingDraftBody = null;
  let savedDraftId = null;
  let openPreview = null;
  let openIdempotencyKey = null;
  let openAcceptanceAmbiguous = false;
  let setupReviewSequence = 0;
  const pendingDraftStorageKey='concliq.operator.static-paper-draft.pending.v1';
  const pendingOpenStorageKey='concliq.operator.paper-open.pending.v1';
  let pendingDraftPersistenceAvailable=true;
  let pendingOpenAcceptance=null;
  try{
    const saved=JSON.parse(localStorage.getItem(pendingDraftStorageKey)??'null');
    if(saved&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saved.requestId??'')&&
      typeof saved.body==='string'&&saved.body.length<16_000&&JSON.parse(saved.body)){
      pendingDraftRequestId=saved.requestId;pendingDraftBody=saved.body;
    }
  }catch{pendingDraftPersistenceAvailable=false;}
  try{
    const saved=JSON.parse(localStorage.getItem(pendingOpenStorageKey)??'null');
    const payload=saved?.payload;
    if(saved&&PROFILE_UUID.test(saved.campaignId??'')&&PROFILE_UUID.test(payload?.previewId??'')&&
      /^[0-9a-f]{64}$/.test(payload?.contentDigest??'')&&Number.isSafeInteger(payload?.expectedRevision)&&
      PROFILE_UUID.test(payload?.idempotencyKey??'')){
      pendingOpenAcceptance=saved;openAcceptanceAmbiguous=true;
    }
  }catch{pendingDraftPersistenceAvailable=false;}
  const setSetupStatus = (message, kind = 'unavailable') => {
    setupNote.textContent = message;
    setupNote.dataset.state = kind;
    setupNote.setAttribute('role', 'status');
  };
  const authRequest = async (path, { method = 'GET', body, csrf = false, signal } = {}) => {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrfToken ?? '';
    const response = await fetch(path, { method, credentials: 'same-origin', headers,...(signal?{signal}:{}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && csrf) { csrfToken = null; setAuthState(false); }
      throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), { status: response.status, data });
    }
    return data;
  };
  // Keep the CSRF value private to this module. Position actions receive only
  // a same-origin request function and a boolean authentication check.
  window.concliqOperatorAuthenticated = () => onOperatorOrigin && csrfToken !== null;
  window.concliqOperatorRequest = (path, options = {}) => {
    if (!onOperatorOrigin || !csrfToken) throw new Error('operator_authentication_required');
    return authRequest(path, { ...options, csrf: options.method === 'POST' || options.method === 'DELETE' });
  };
  const notifyAuthChanged = () => window.dispatchEvent(new Event('operator-auth-changed'));
  function renderWidths() {
    const pool = registeredPools.find((candidate) => candidate.poolAddress === poolSelect.value);
    if (!pool) { widthSelect.disabled = true; widthSelect.innerHTML = '<option value="">Choose a registered pool first</option>'; return; }
    const spacing = Number(pool.tickSpacing);
    if (!Number.isSafeInteger(spacing) || spacing <= 0) { widthSelect.disabled = true; widthSelect.innerHTML = '<option value="">Tick spacing unavailable</option>'; return; }
    const choices = [1, 2, 4, 8, 16].map((multiple) => spacing * multiple);
    widthSelect.innerHTML = choices.map((ticks) => {
      const pct = ((Math.pow(1.0001, ticks) - 1) * 100).toFixed(2);
      return `<option value="${ticks}">${ticks.toLocaleString()} ticks (~${pct}%)</option>`;
    }).join('');
    widthSelect.value = String(spacing * 4); widthSelect.disabled = false;
  }
  const renderPools = (snapshot) => {
    researchPools = (snapshot.pools ?? []).filter((pool) => pool.registryEnabled === true);
    registeredPools = researchPools
      .sort((a, b) => a.rwaSymbol.localeCompare(b.rwaSymbol) || a.fee - b.fee);
    if (marketProfiles.length) applyProfileIds();
    if (!registeredPools.length) throw new Error('No enabled registered pools are available');
    poolSelect.innerHTML = registeredPools.map((pool) =>
      `<option value="${esc(pool.poolAddress)}">${esc(pool.rwaSymbol)} / USDG · ${pool.fee / 10000}% fee tier · spacing ${pool.tickSpacing}</option>`).join('');
    poolSelect.disabled = false; renderWidths(); reviewButton.disabled = false;
  };
  function applyProfileIds() {
    registeredPools = marketProfiles.filter((profile) => profile.draftAvailable === true).map((profile) => {
      const pool = researchPools.find((candidate) => candidate.poolAddress?.toLowerCase() === profile.pool?.toLowerCase() && candidate.fee === profile.fee);
      const tokenAddress = profile.quoteToken === 0 ? profile.token1 : profile.token0;
      return { ...(pool ?? {}), poolAddress: profile.pool, fee: profile.fee, tickSpacing: profile.tickSpacing,
        marketProfileId: profile.id, registryEnabled: true,
        rwaSymbol: pool?.rwaSymbol ?? `${String(tokenAddress ?? 'Pool').slice(0, 8)}…` };
    }).sort((a, b) => a.rwaSymbol.localeCompare(b.rwaSymbol) || a.fee - b.fee);
    if (!registeredPools.length) throw new Error('No verified, indexed market profiles are available for setup.');
    poolSelect.innerHTML = registeredPools.map((pool) =>
      `<option value="${esc(pool.poolAddress)}">${esc(pool.rwaSymbol)} / USDG · ${pool.fee / 10000}% fee tier · spacing ${pool.tickSpacing}</option>`).join('');
    poolSelect.disabled = false; renderWidths(); reviewButton.disabled = false;
  }
  const loadResearch = async () => {
    const snapshot = await fetch('/api/research', { headers: { accept: 'application/json' } }).then((response) => {
      if (!response.ok) throw new Error(response.status === 404 ? 'Registered pool data is not available on this operator dashboard.' : 'Research pool registry unavailable');
      return response.json();
    });
    renderPools(snapshot);
  };
  void loadResearch().catch((error) => { poolSelect.innerHTML = `<option value="">${esc(error.message)}</option>`; });
  poolSelect.addEventListener('change', () => { renderWidths(); invalidateReview(); });

  function invalidateReview() {
    setupReviewSequence++;
    reviewButton.disabled=false;
    if (pendingDraftRequestId) {
      setSetupStatus('A draft request may still be saving. Complete the same-request retry or reconciliation before changing the reviewed setup.');
      return;
    }
    currentSetupPreflight = null;
    savedDraftId = null; openPreview = null;
    document.getElementById('setup-review').hidden = true;
    document.getElementById('operator-draft-binding').hidden = true;
    setSetupStatus('Selection changed. Review again to request a fresh source and range preflight.');
  }
  document.getElementById('setup-form').addEventListener('input', invalidateReview);
  document.getElementById('setup-form').addEventListener('change', invalidateReview);
  const setupStrategy=document.getElementById('setup-strategy'),setupMode=document.getElementById('setup-mode'),
    setupLimits=document.getElementById('setup-limits-review');
  const updateLimitsVisibility=()=>{setupLimits.hidden=setupStrategy.value!=='static_manual_v1'||setupMode.value!=='paper';};
  setupStrategy.addEventListener('change',updateLimitsVisibility);setupMode.addEventListener('change',updateLimitsVisibility);
  updateLimitsVisibility();
  async function runSetupReview(event) {
    event.preventDefault();
    const reviewSequence=++setupReviewSequence;
    const error = document.getElementById('setup-error');
    const pool = registeredPools.find((candidate) => candidate.poolAddress === poolSelect.value);
    const capital = document.getElementById('setup-capital').value;
    const ticks = widthSelect.value;
    const strategyId = document.getElementById('setup-strategy').value;
    const mode = document.getElementById('setup-mode').value;
    const capitalRaw = capitalToQuoteRaw(capital), spacing = Number(pool?.tickSpacing), width = Number(ticks);
    if (!pool || !capitalRaw || !Number.isSafeInteger(spacing) || spacing < 1 ||
        !Number.isSafeInteger(width) || width < spacing || width % spacing !== 0) {
      error.textContent = 'Choose an enabled registered pool, valid USDG capital and a half-width aligned to its tick spacing.';
      error.hidden = false; return;
    }
    error.hidden = true;
    currentSetupPreflight = null;
    savedDraftId = null; openPreview = null;
    document.getElementById('operator-draft-binding').hidden = true;
    const facts = [
      ['Pool', poolSelect.selectedOptions[0].textContent],
      ['Capital', `${capital} USDG`],
      ['Half-width around center', widthSelect.selectedOptions[0].textContent],
      ['Strategy', document.getElementById('setup-strategy').selectedOptions[0].textContent],
      ['Mode', document.getElementById('setup-mode').selectedOptions[0].textContent],
    ];
    renderFacts(facts);
    const output = document.getElementById('setup-preflight-result');
    output.hidden = true;
    document.getElementById('setup-review').hidden = false;
    if (!onOperatorOrigin) {
      setSetupStatus('Fresh preflight is unavailable on the public read-only dashboard. Open the authenticated loopback operator dashboard to request it; no request was sent.');
      return;
    }
    if (strategyId !== 'static_manual_v1' || mode !== 'paper') {
      setSetupStatus('Preflight unavailable: only static/manual paper setup is implemented. No request was sent.');
      return;
    }
    if (!csrfToken) {
      setSetupStatus('Sign in to the loopback operator dashboard before requesting a fresh preflight.');
      loginForm?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const limits=Object.fromEntries(Object.entries(limitInputIds).map(([key,id])=>[key,document.getElementById(id).value]));
    const request = setupPreflightRequest({ pool, capital, halfWidthTicks: ticks, strategyId, mode,limits });
    if (!request.available) { setSetupStatus(`Preflight unavailable: ${request.reason}`); return; }
    setSetupStatus('Preparing estimated costs from a fresh confirmed source. This may take several minutes; no draft or operation will be created…', 'loading');
    reviewButton.disabled=true;
    try {
      const result = await authRequest(SETUP_PREFLIGHT_PATH, { method: 'POST', body: request.payload, csrf: true,
        signal:AbortSignal.timeout(360_000) });
      if(reviewSequence!==setupReviewSequence)return;
      reviewButton.disabled=false;
      renderPreflight(result);
    } catch (cause) {
      if(reviewSequence!==setupReviewSequence)return;
      reviewButton.disabled=false;
      const reason = cause.name==='TimeoutError'||cause.name==='AbortError' ? 'Cost review timed out or disconnected. No draft or operation was created. Review setup again to request a fresh result.' :
        cause.status === 401 ? 'Operator session expired. Sign in again; no draft or operation was created.' :
        cause.status === 404 ? 'Authenticated setup preflight route is not available on this command service.' :
        cause.data?.error === 'paper_setup_preflight_unavailable' ? 'Setup preflight service is unavailable.' :
        `Setup preflight failed (${cause.data?.error ?? 'command_failed'}). No draft or operation was created.`;
      setSetupStatus(reason);
      if (cause.status === 401) { csrfToken = null; setAuthState(false); }
    }
  }
  function renderFacts(facts) {
    const container = document.getElementById('setup-review-facts');
    container.replaceChildren(...facts.map(([name, value]) => {
      const row = document.createElement('div');
      const label = document.createElement('dt'); label.textContent = name;
      const content = document.createElement('dd'); content.textContent = value;
      row.append(label, content); return row;
    }));
  }
  function renderPreflight(result) {
    const output = document.getElementById('setup-preflight-result');
    const title = document.getElementById('setup-preflight-title');
    const detail = document.getElementById('setup-preflight-detail');
    const isAvailable = result.status === 'available';
    title.textContent = isAvailable ? 'Sizing preflight available' : 'Sizing preflight unavailable';
    const missing = Array.isArray(result.missing) ? result.missing.join(', ') : '';
    detail.textContent = isAvailable
      ? 'Fresh sizing and provisional cost evidence only. This does not create a draft, establish wallet funding, or authorize an operation.'
      : `Reason: ${missing || result.error || 'required source or cost evidence is unavailable'}. No draft or operation was created.`;
    const facts = document.getElementById('setup-preflight-facts');
    facts.replaceChildren(...preflightFacts(result).map(([name, value]) => {
      const row = document.createElement('div');
      const label = document.createElement('dt'); label.textContent = name;
      const content = document.createElement('dd'); content.textContent = value;
      row.append(label, content); return row;
    }));
    output.hidden = false;
    currentSetupPreflight = result;
    renderOperatorDraftBinding(result);
    const reviewExpiry=Date.parse(result.setupReviewExpiresAt??'');
    if(Number.isFinite(reviewExpiry))setTimeout(()=>{
      if(currentSetupPreflight===result)updateDraftBinding();
    },Math.max(0,reviewExpiry-Date.now()+1));
    setSetupStatus(isAvailable ? 'Preflight completed. Review the exact bounds and provisional estimates below; admission limits were not evaluated.' : `Preflight unavailable: ${missing || 'required evidence unavailable'}.`);
  }
  const limitInputIds={maxDeploymentValue:'limit-max-deployment',minDeploymentValue:'limit-min-deployment',
    maxExposurePpm:'limit-max-exposure',maxLossValue:'limit-max-loss',maxDrawdownPpm:'limit-max-drawdown',
    maxActionCost:'limit-max-action-cost',maxRollingCost:'limit-max-rolling-cost',
    maxCampaignCost:'limit-max-campaign-cost',exitReserveWei:'limit-exit-reserve',maxSlippageBps:'limit-slippage-bps'};
  const limitLabels={maxDeploymentValue:'Maximum deployment · raw reference USD (X18)',
    minDeploymentValue:'Minimum deployment · raw reference USD (X18)',
    maxExposurePpm:'Maximum exposure · PPM',maxLossValue:'Maximum loss · raw reference USD (X18)',
    maxDrawdownPpm:'Maximum drawdown · PPM',maxActionCost:'Maximum action cost · raw reference USD (X18)',
    maxRollingCost:'Maximum rolling cost · raw reference USD (X18)',
    maxCampaignCost:'Maximum campaign cost · raw reference USD (X18)',
    exitReserveWei:'Native exit reserve · wei',maxSlippageBps:'Maximum slippage · bps'};
  function renderOperatorDraftBinding(result) {
    const section=document.getElementById('operator-draft-binding'),available=onOperatorOrigin&&
      result?.status==='available'&&result.kind==='paper_setup_preflight'&&
      result.mode==='paper'&&result.strategyId==='static_manual_v1';
    section.hidden=!available;
    if(!available)return;
    const token0=document.getElementById('setup-allocation-token0'),token1=document.getElementById('setup-allocation-token1');
    token0.value=result.requirements?.token0Raw??'';token1.value=result.requirements?.token1Raw??'';
    document.getElementById('setup-allocation-token0-label').firstChild.textContent=
      `Token 0 (${result.profile?.token0??'address unavailable'}) allocation · raw `;
    document.getElementById('setup-allocation-token1-label').firstChild.textContent=
      `Token 1 (${result.profile?.token1??'address unavailable'}) allocation · raw `;
    updateDraftBinding();
  }
  function updateDraftBinding() {
    if(!currentSetupPreflight||document.getElementById('operator-draft-binding').hidden)return;
    const wallet=document.getElementById('setup-wallet-address').value,
      nativeWei=document.getElementById('setup-allocation-native').value,
      limits=Object.fromEntries(Object.entries(limitInputIds).map(([key,id])=>[key,document.getElementById(id).value])),
      result=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:currentSetupPreflight,nativeWei,limits}),
      status=document.getElementById('operator-draft-binding-status');
    status.dataset.state=result.status==='reviewable'?'available':'unavailable';
    status.textContent=result.status==='reviewable'?
      (savedDraftId?'Static paper admission passed when draft '+savedDraftId+' was created. Wallet ownership/funding remain unchecked; request a fresh open preview.':
       'Binding values are structurally complete. Wallet ownership/funding and server admission have not been checked; no draft was saved.'):
      `Review incomplete: ${result.missing.join(', ')}.`;
    const facts=document.getElementById('operator-draft-binding-facts');
    const saveButton=document.getElementById('save-paper-draft');
    if(result.status!=='reviewable'){facts.replaceChildren();saveButton.disabled=true;return;}
    const binding=result.binding,proposal=binding.proposedDraft,rows=[
      ['Wallet identity · syntax only',proposal.wallet],['Funding status','Unchecked'],
      ['Registered market profile',binding.profileId],['Pool / fee tier',`${currentSetupPreflight.profile.pool} · ${currentSetupPreflight.profile.fee}`],
      ['Registered profile hash',binding.profileHash],
      ['Preflight source block / hash',`${binding.source.block} · ${binding.source.hash}`],
      ['Campaign revision',savedDraftId?'1':'None · no draft exists'],['Capital budget · raw USDG',currentSetupPreflight.input.capitalQuoteRaw],
      ['Centered half-width · ticks',String(proposal.config.halfWidthTicks)],
      ['Resolved tick bounds',`${currentSetupPreflight.range.tickLower} to ${currentSetupPreflight.range.tickUpper}`],
      [`${currentSetupPreflight.profile.token0} allocation · raw`,proposal.allocation.token0Raw],
      [`${currentSetupPreflight.profile.token1} allocation · raw`,proposal.allocation.token1Raw],
      ['Native gas allocation · wei',proposal.allocation.nativeWei],
      ...Object.entries(proposal.config.limits).map(([key,value])=>[limitLabels[key]??key,String(value)]),
      ['Policy admission',savedDraftId?'Passed at draft creation; fresh open preview required':'Not evaluated'],
      ['Draft persistence',savedDraftId?'Saved · '+savedDraftId:pendingDraftRequestId?'Pending · same request ID retained':'Not saved'],
    ];
    facts.replaceChildren(...rows.map(([name,value])=>{const row=document.createElement('div');
      const label=document.createElement('dt');label.textContent=name;
      const detail=document.createElement('dd');detail.textContent=value;row.append(label,detail);return row;}));
    const candidate=currentDraftRequest?.();
    const reviewTokenValid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentSetupPreflight.setupReviewId??'')&&
      Number.isFinite(Date.parse(currentSetupPreflight.setupReviewExpiresAt??''))&&
      Date.parse(currentSetupPreflight.setupReviewExpiresAt)>Date.now();
    if(!reviewTokenValid&&!pendingDraftRequestId)
      status.textContent='Server review token is missing or expired. Request a fresh setup review before saving; no draft was submitted.';
    saveButton.disabled=!window.concliqOperatorAuthenticated?.()||Boolean(savedDraftId)||
      (!reviewTokenValid&&!pendingDraftRequestId)||
      Boolean(pendingDraftRequestId&&candidate&&pendingDraftBody!==JSON.stringify(candidate));
  }
  for(const id of ['setup-wallet-address','setup-allocation-native',...Object.values(limitInputIds)]){
    document.getElementById(id).addEventListener('input',updateDraftBinding);
    document.getElementById(id).addEventListener('change',updateDraftBinding);
  }
  document.getElementById('setup-form').addEventListener('submit', runSetupReview);

  const draftStatus=document.getElementById('setup-draft-submit-status');
  const openStatus=document.getElementById('setup-open-status');
  const setDraftStatus=(message,state='unavailable')=>{draftStatus.textContent=message;draftStatus.dataset.state=state;};
  const persistPendingDraft=()=>{
    try{localStorage.setItem(pendingDraftStorageKey,JSON.stringify({requestId:pendingDraftRequestId,body:pendingDraftBody}));return true;}
    catch{pendingDraftPersistenceAvailable=false;return false;}
  };
  const clearPendingDraft=()=>{pendingDraftRequestId=null;pendingDraftBody=null;
    try{localStorage.removeItem(pendingDraftStorageKey);}catch{pendingDraftPersistenceAvailable=false;}};
  function freezeDraftInputs(frozen){
    for(const element of [poolSelect,document.getElementById('setup-capital'),widthSelect,
      document.getElementById('setup-strategy'),document.getElementById('setup-mode'),
      document.getElementById('setup-wallet-address'),document.getElementById('setup-allocation-native'),
      ...Object.values(limitInputIds).map(id=>document.getElementById(id))])element.disabled=frozen;
    reviewButton.disabled=frozen;
  }
  const currentDraftRequest=()=>{
    if(!currentSetupPreflight)return null;
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentSetupPreflight.setupReviewId??'')||
      !Number.isFinite(Date.parse(currentSetupPreflight.setupReviewExpiresAt??''))||
      Date.parse(currentSetupPreflight.setupReviewExpiresAt)<=Date.now())return null;
    const wallet=document.getElementById('setup-wallet-address').value.trim();
    const nativeWei=document.getElementById('setup-allocation-native').value;
    const limits=Object.fromEntries(Object.entries(limitInputIds).map(([key,id])=>[key,document.getElementById(id).value]));
    const localReview=reviewStaticPaperDraftBinding({walletAddress:wallet,preflight:currentSetupPreflight,nativeWei,limits});
    if(localReview.status!=='reviewable')return null;
    const proposal=localReview.binding.proposedDraft;
    const reviewed={profileId:currentSetupPreflight.profileId,profileHash:currentSetupPreflight.profileHash,
      input:currentSetupPreflight.input,source:currentSetupPreflight.source,profile:currentSetupPreflight.profile,
      range:currentSetupPreflight.range,requirements:currentSetupPreflight.requirements,
      references:currentSetupPreflight.references,costs:currentSetupPreflight.costs};
    return {reviewId:currentSetupPreflight.setupReviewId,profileId:currentSetupPreflight.profileId,
      capitalQuoteRaw:currentSetupPreflight.input.capitalQuoteRaw,
      halfWidthTicks:currentSetupPreflight.input.halfWidthTicks,wallet:proposal.wallet,
      allocation:proposal.allocation,limits:proposal.config.limits,reviewed};
  };
  const setOpenActionsLocked=locked=>{
    const setupRefresh=document.getElementById('refresh-open-preview');if(setupRefresh)setupRefresh.disabled=locked||!window.concliqOperatorAuthenticated?.();
    for(const button of document.querySelectorAll('.saved-open-preview'))button.disabled=locked||!window.concliqOperatorAuthenticated?.();
  };
  const persistPendingOpen=()=>{
    try{localStorage.setItem(pendingOpenStorageKey,JSON.stringify(pendingOpenAcceptance));return true;}
    catch{pendingDraftPersistenceAvailable=false;return false;}
  };
  const clearPendingOpen=()=>{pendingOpenAcceptance=null;openIdempotencyKey=null;openAcceptanceAmbiguous=false;
    try{localStorage.removeItem(pendingOpenStorageKey);}catch{pendingDraftPersistenceAvailable=false;}
    document.getElementById('pending-open-recovery').hidden=true;
    setOpenActionsLocked(false);};
  async function submitOpenAcceptance(campaignId,payload,text,accept,refreshButton){
    if(!window.concliqOperatorAuthenticated?.())return;
    const priorAttemptWasAmbiguous=openAcceptanceAmbiguous;
    accept.disabled=true;setOpenActionsLocked(true);
    try{
      const accepted=await authRequest(`/api/deployments/${encodeURIComponent(campaignId)}/open-operations`,
        {method:'POST',body:payload,csrf:true});
      if(!PROFILE_UUID.test(accepted?.id??'')||
         !['queued','preflighting','executing','confirming','reconciling','blocked','succeeded','failed','cancelled','rejected'].includes(accepted.status))
        throw new Error('operation_acceptance_response_invalid');
      clearPendingOpen();
      text.textContent=`Open operation ${accepted.id} accepted · ${accepted.status}. Check Positions for saved stages; paid costs remain unavailable.`;
      try{window.dispatchEvent(new Event('positions-refresh-requested'));}catch{}
      void loadSavedPaperDrafts();
    }catch(error){
      const reason=error?.data?.error??error?.message??'command_failed';
      if(error?.data?.error==='operation_worker_not_ready'){
        if(priorAttemptWasAmbiguous){
          openAcceptanceAmbiguous=true;setOpenActionsLocked(true);accept.disabled=false;
          accept.textContent='Retry same open acceptance / reconcile';
          text.textContent='The same-key retry could not be reconciled because worker readiness is unavailable. The earlier acceptance outcome remains unknown; keep this key and retry after readiness returns.';
        }else{
          clearPendingOpen();accept.disabled=true;refreshButton.disabled=!window.concliqOperatorAuthenticated?.();
          text.textContent='Open acceptance unavailable because worker readiness was not available before submission. No operation was submitted; request a fresh preview when readiness returns.';
        }
      }else if(error?.status>=400&&error.status<500){
        clearPendingOpen();accept.disabled=true;refreshButton.disabled=!window.concliqOperatorAuthenticated?.();
        text.textContent=`Open preview rejected (${reason}). Request a fresh preview before retrying.`;
      }else{
        openAcceptanceAmbiguous=true;setOpenActionsLocked(true);accept.disabled=false;
        accept.textContent='Retry same open acceptance / reconcile';
        text.textContent=`Open acceptance outcome unknown (${reason}). Retry with the same in-page key; do not request a new preview until reconciled.`;
      }
    }
  }
  async function requestFreshOpenPreview(campaignId,statusTarget=openStatus,
    refreshButton=document.getElementById('refresh-open-preview')){
    if(openAcceptanceAmbiguous||pendingOpenAcceptance){refreshButton.disabled=true;
      statusTarget.textContent='An earlier open acceptance outcome is unknown. Reconcile with its same-key retry before requesting another preview.';return;}
    refreshButton.disabled=true;
    statusTarget.textContent='Requesting a fresh saved open preview…';
    statusTarget.dataset.state='unavailable';
    try{
      const preview=await authRequest(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        {method:'POST',body:{kind:'open'},csrf:true});
      openPreview=preview;openIdempotencyKey=null;openAcceptanceAmbiguous=false;
      const usable=preview?.kind==='open'&&preview.status==='indicative'&&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(preview.id??'')&&
        /^[0-9a-f]{64}$/.test(preview.contentDigest??'')&&Number.isSafeInteger(preview.expectedRevision)&&
        Number.isFinite(Date.parse(preview.expiresAt))&&Date.parse(preview.expiresAt)>Date.now();
      const facts=preview?.costs?.open;
      statusTarget.replaceChildren();
      const text=document.createElement('p');
      text.textContent=usable?`Saved open preview · campaign ${campaignId} · revision ${preview.expectedRevision}. Cost evidence is provisional, not paid; funding remains unchecked.`:
        `Open preview unavailable (${preview?.error??preview?.status??'incomplete binding'}). No operation was submitted.`;
      statusTarget.append(text);
      if(facts){const cost=document.createElement('p');cost.textContent=`Open gas expected / bound: ${facts.expectedGasUnits??'Unavailable'} / ${facts.boundGasUnits??'Unavailable'} units; reference USD X18 ${facts.expectedValue??'Unavailable'} / ${facts.boundValue??'Unavailable'} · provisional, not paid.`;statusTarget.append(cost);}
      const accept=document.createElement('button');accept.type='button';accept.textContent='Accept open operation';
      const actionAvailable=preview.actionAvailable===true&&preview.operationAcceptanceAvailable===true;
      accept.disabled=!usable||!actionAvailable||!window.concliqOperatorAuthenticated?.();
      if(usable&&!actionAvailable){const note=document.createElement('p');note.textContent='Open acceptance unavailable: the command service has not proven current worker readiness.';statusTarget.append(note);}
      statusTarget.append(accept);
      refreshButton.disabled=!window.concliqOperatorAuthenticated?.();
      accept.addEventListener('click',()=>{
        if(preview!==openPreview||!usable||!actionAvailable)return;
        if(!openIdempotencyKey)openIdempotencyKey=globalThis.crypto?.randomUUID?.()??null;
        if(!openIdempotencyKey)return;
        pendingOpenAcceptance={campaignId,payload:{previewId:preview.id,contentDigest:preview.contentDigest,
          expectedRevision:preview.expectedRevision,idempotencyKey:openIdempotencyKey}};
        if(!persistPendingOpen()){clearPendingOpen();accept.disabled=true;
          text.textContent='A durable same-key recovery record could not be saved. No open operation was submitted.';return;}
        void submitOpenAcceptance(campaignId,pendingOpenAcceptance.payload,text,accept,refreshButton);
      });
    }catch(error){refreshButton.disabled=!window.concliqOperatorAuthenticated?.();statusTarget.textContent=`Fresh open preview unavailable (${error?.data?.error??error?.message??'command_failed'}). No operation was submitted.`;}
  }
  document.getElementById('save-paper-draft').addEventListener('click',async()=>{
    const button=document.getElementById('save-paper-draft');
    if(!onOperatorOrigin||!window.concliqOperatorAuthenticated?.()||savedDraftId)return;
    let candidate,body;
    try{candidate=pendingDraftRequestId?JSON.parse(pendingDraftBody):currentDraftRequest();
      body=pendingDraftRequestId?pendingDraftBody:JSON.stringify(candidate);}catch{return;}
    if(!candidate)return;
    if(pendingDraftRequestId&&pendingDraftBody!==body){setDraftStatus('A prior draft submission has an unknown outcome. Restore the exact reviewed inputs to retry the same request ID.');return;}
    if(!pendingDraftRequestId){
      if(!pendingDraftPersistenceAvailable){setDraftStatus('This browser cannot persist a same-request recovery key. Draft submission is disabled until origin storage is available.');return;}
      pendingDraftRequestId=globalThis.crypto?.randomUUID?.()??null;pendingDraftBody=body;
      if(!pendingDraftRequestId||!persistPendingDraft()){clearPendingDraft();setDraftStatus('A recoverable draft request ID could not be persisted; no draft request was sent.');return;}
    }
    button.disabled=true;freezeDraftInputs(true);setDraftStatus('Rechecking canonical source, cost evidence, profile, reserve and limits before saving…');
    const payload={...candidate,requestId:pendingDraftRequestId};
    try{
      const result=await authRequest('/api/deployments/setup-drafts',{method:'POST',body:payload,csrf:true});
      if(result?.status!=='draft_created'||!/^\d+$/.test(String(result.revision))||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.draftId??''))
        throw new Error('draft_creation_response_invalid');
      savedDraftId=result.draftId;clearPendingDraft();
      freezeDraftInputs(false);
      setDraftStatus(`${result.replayed?'Reconciled existing':'Saved'} static/manual paper draft ${result.draftId} · revision ${result.revision}. Wallet funding is unchecked; no operation was created.`,'available');
      const link=document.createElement('a');link.href='#positions-tab';link.textContent='Open Positions';link.addEventListener('click',()=>document.getElementById('positions-tab').click());draftStatus.append(' ',link);
      document.getElementById('setup-open-review').hidden=false;
      await requestFreshOpenPreview(result.draftId);
      void loadSavedPaperDrafts();
      updateDraftBinding();
    }catch(error){
      const reason=error?.data?.error??error?.message??'command_failed';
      if(error?.status>=400&&error.status<500){clearPendingDraft();freezeDraftInputs(false);button.disabled=true;
        setDraftStatus(error.status===409?`Draft admission conflicted or became stale (${reason}). Review fresh source and input values before a new request.`:
          `Draft admission rejected (${reason}). No draft was reported as created.`);}
      else{button.disabled=false;setDraftStatus(`Draft creation outcome unknown (${reason}). Retry the exact same reviewed inputs with the retained request ID to reconcile; do not create a new request yet.`);}
    }
  });
  document.getElementById('refresh-open-preview').addEventListener('click',()=>{
    if(savedDraftId&&!openAcceptanceAmbiguous&&window.concliqOperatorAuthenticated?.())void requestFreshOpenPreview(savedDraftId);
  });
  function renderSavedPaperDrafts(drafts){
    const section=document.getElementById('saved-paper-drafts'),list=document.getElementById('saved-paper-drafts-list'),
      status=document.getElementById('saved-paper-drafts-status');
    section.hidden=!onOperatorOrigin||!window.concliqOperatorAuthenticated?.();list.replaceChildren();
    const recovery=document.getElementById('pending-open-recovery'),retry=document.getElementById('retry-pending-open'),
      recoveryDetail=document.getElementById('pending-open-recovery-detail');
    recovery.hidden=!pendingOpenAcceptance||section.hidden;
    if(pendingOpenAcceptance){
      recoveryDetail.textContent=`Campaign ${pendingOpenAcceptance.campaignId} · preview ${pendingOpenAcceptance.payload.previewId} · expected revision ${pendingOpenAcceptance.payload.expectedRevision}. The original idempotency key is retained. Costs and preview freshness are not re-presented as current.`;
      retry.disabled=!window.concliqOperatorAuthenticated?.();retry.onclick=()=>{
        if(!pendingOpenAcceptance||!window.concliqOperatorAuthenticated?.())return;
        openIdempotencyKey=pendingOpenAcceptance.payload.idempotencyKey;openAcceptanceAmbiguous=true;
        const setupRefresh=document.getElementById('refresh-open-preview');
        void submitOpenAcceptance(pendingOpenAcceptance.campaignId,pendingOpenAcceptance.payload,
          recoveryDetail,retry,setupRefresh);
      };
      setOpenActionsLocked(true);
    }else{retry.onclick=null;}
    const rows=Array.isArray(drafts)?drafts.filter(row=>row&&PROFILE_UUID.test(row.id??'')&&
      Number.isSafeInteger(row.revision)&&row.revision>0&&PROFILE_UUID.test(row.marketProfileId??'')&&
      /^[0-9a-f]{64}$/.test(row.profileHash??'')&&EVM_ADDRESS.test(row.wallet??'')&&EVM_ADDRESS.test(row.pool??'')&&
      /^[0-9a-f]{64}$/.test(row.configHash??'')&&Number.isSafeInteger(row.fee)&&Number.isSafeInteger(row.tickSpacing)&&row.allocation&&row.config):[];
    if(!rows.length){status.textContent='No saved static/manual paper drafts are available.';return;}
    status.textContent=`${rows.length} saved draft${rows.length===1?'':'s'} · configuration only; source and cost evidence must be refreshed.`;
    for(const draft of rows){
      const card=document.createElement('article');card.className='saved-paper-draft';
      const heading=document.createElement('h3');heading.textContent=`Draft ${draft.id} · revision ${draft.revision}`;card.append(heading);
      const facts=document.createElement('dl');
      const config=draft.config,range=Number.isSafeInteger(config.halfWidthTicks)?`Centered half-width · ${config.halfWidthTicks} ticks`:
        Number.isSafeInteger(config.tickLower)&&Number.isSafeInteger(config.tickUpper)?`Saved tick bounds · ${config.tickLower} to ${config.tickUpper}`:'Saved range unavailable';
      const rows=[['Lifecycle','Draft · no operation accepted'],['Wallet identity',draft.wallet],
        ['Registered pool / fee',`${draft.pool} · ${draft.fee} · spacing ${draft.tickSpacing}`],
        ['Market profile ID / hash',`${draft.marketProfileId} · ${draft.profileHash}`],['Saved configuration hash',draft.configHash],
        ['Allocation · token0/token1 raw',`${draft.allocation.token0Raw??'Unavailable'} / ${draft.allocation.token1Raw??'Unavailable'}`],
        ['Native allocation · wei',String(draft.allocation.nativeWei??'Unavailable')],[ 'Range configuration',range],
        ...Object.entries(config.limits??{}).map(([key,value])=>[limitLabels[key]??key,String(value)]),
        ['Created',String(draft.createdAt??'Unavailable')],['Funding','Unchecked'],
        ['Current source / current costs','Unavailable · request a fresh preview']];
      for(const [label,value]of rows){const cell=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
        dt.textContent=label;dd.textContent=value;cell.append(dt,dd);facts.append(cell);}
      card.append(facts);
      const actions=document.createElement('div');actions.className='draft-actions';
      const button=document.createElement('button');button.type='button';button.textContent='Request fresh open preview';
      button.className='saved-open-preview';button.disabled=Boolean(pendingOpenAcceptance)||!window.concliqOperatorAuthenticated?.();
      const actionStatus=document.createElement('p');actionStatus.className='draft-action-status';actionStatus.setAttribute('role','status');
      actionStatus.textContent='No open operation is submitted until a fresh preview is explicitly actionable and confirmed.';
      button.addEventListener('click',()=>{if(window.concliqOperatorAuthenticated?.())void requestFreshOpenPreview(draft.id,actionStatus,button);});
      actions.append(button,actionStatus);card.append(actions);list.append(card);
    }
  }
  async function loadSavedPaperDrafts(){
    const section=document.getElementById('saved-paper-drafts'),status=document.getElementById('saved-paper-drafts-status');
    if(!onOperatorOrigin||!window.concliqOperatorAuthenticated?.()){section.hidden=true;return;}
    section.hidden=false;status.textContent='Loading saved static/manual paper drafts…';
    try{const result=await authRequest('/api/deployments/setup-drafts');renderSavedPaperDrafts(result.drafts);}
    catch(error){section.hidden=false;status.textContent=`Saved paper drafts unavailable (${error?.data?.error??error?.message??'command_failed'}).`;
      document.getElementById('saved-paper-drafts-list').replaceChildren();}
  }
  function restorePendingDraftReview(){
    if(!pendingDraftRequestId||!pendingDraftBody||!window.concliqOperatorAuthenticated?.())return;
    let body;try{body=JSON.parse(pendingDraftBody);}catch{clearPendingDraft();return;}
    if(!body?.reviewed||body.profileId!==body.reviewed.profileId){clearPendingDraft();return;}
    const setupReview=document.getElementById('setup-review'),binding=document.getElementById('operator-draft-binding');
    setupReview.hidden=false;binding.hidden=false;document.getElementById('setup-preflight-result').hidden=true;
    document.getElementById('setup-wallet-address').value=body.wallet??'';
    document.getElementById('setup-allocation-token0').value=body.allocation?.token0Raw??'';
    document.getElementById('setup-allocation-token1').value=body.allocation?.token1Raw??'';
    document.getElementById('setup-allocation-native').value=body.allocation?.nativeWei??'';
    for(const [key,id]of Object.entries(limitInputIds))document.getElementById(id).value=String(body.limits?.[key]??'');
    document.getElementById('setup-allocation-token0-label').firstChild.textContent=`Token 0 (${body.reviewed.profile?.token0??'address unavailable'}) allocation · raw `;
    document.getElementById('setup-allocation-token1-label').firstChild.textContent=`Token 1 (${body.reviewed.profile?.token1??'address unavailable'}) allocation · raw `;
    document.getElementById('operator-draft-binding-status').textContent='Recovered pending request. Its previous source and costs are historical; retrying the same UUID first checks for an already-saved campaign, then server admission requires fresh evidence.';
    document.getElementById('operator-draft-binding-status').dataset.state='loading';
    const facts=document.getElementById('operator-draft-binding-facts');
    const review=body.reviewed,config={halfWidthTicks:body.halfWidthTicks,limits:body.limits};
    const rows=[['Wallet identity · syntax only',body.wallet],['Funding status','Unchecked'],
      ['Registered market profile',body.profileId],['Registered profile hash',review.profileHash],
      ['Previously reviewed source · not current',`${review.source?.block??'Unavailable'} · ${review.source?.hash??'Unavailable'}`],
      ['Capital budget · raw USDG',body.capitalQuoteRaw],['Centered half-width · ticks',String(body.halfWidthTicks)],
      ['Previously reviewed bounds · not current',`${review.range?.tickLower??'Unavailable'} to ${review.range?.tickUpper??'Unavailable'}`],
      ['Token 0 allocation · raw',body.allocation?.token0Raw??'Unavailable'],
      ['Token 1 allocation · raw',body.allocation?.token1Raw??'Unavailable'],['Native allocation · wei',body.allocation?.nativeWei??'Unavailable'],
      ...Object.entries(config.limits??{}).map(([key,value])=>[limitLabels[key]??key,String(value)]),
      ['Draft request ID',pendingDraftRequestId],['Admission state','Unknown · retry same request to reconcile']];
    facts.replaceChildren(...rows.map(([label,value])=>{const cell=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');
      dt.textContent=label;dd.textContent=value;cell.append(dt,dd);return cell;}));
    const saveButton=document.getElementById('save-paper-draft');saveButton.textContent='Retry same draft request / reconcile';saveButton.disabled=false;
    freezeDraftInputs(true);setDraftStatus('A prior draft POST may have completed. Retry the retained request UUID to reconcile the saved campaign; source, bounds and cost evidence shown above are historical, not current.');
    document.getElementById('positions-tab').click();
  }
  for(const id of ['setup-wallet-address','setup-allocation-native',...Object.values(limitInputIds)]){
    document.getElementById(id).addEventListener('input',()=>{if(pendingDraftRequestId&&pendingDraftBody!==JSON.stringify(currentDraftRequest()))setDraftStatus('Inputs changed while a draft request may be pending. Restore the exact prior values to retry and reconcile.');});
  }
  window.addEventListener('operator-auth-changed',updateDraftBinding);

  function setAuthState(signedIn) {
    document.getElementById('operator-login-fields').hidden = signedIn;
    logoutButton.hidden = !signedIn;
    document.getElementById('operator-auth-status').textContent = signedIn ? 'Authenticated for this browser session.' : 'Not signed in. Session credentials stay in this page memory.';
    notifyAuthChanged();
  }
  if (onOperatorOrigin && loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = document.getElementById('operator-password');
      const message = document.getElementById('operator-auth-status');
      try {
        const session = await authRequest('/api/session', { method: 'POST', body: { password: password.value } });
        csrfToken = session.csrfToken; password.value = ''; setAuthState(true);
        try {
          const response = await authRequest('/api/market-profiles');
          marketProfiles = response.profiles ?? [];
          applyProfileIds();
          setSetupStatus('Signed in. Verified, indexed profiles are available for static/manual paper preflight.');
          restorePendingDraftReview();
          await loadSavedPaperDrafts();
        } catch (cause) {
          poolSelect.disabled = true; reviewButton.disabled = true;
          setSetupStatus(`Verified market profiles unavailable (${cause.data?.error ?? cause.message ?? 'command_failed'}); no preflight can be sent.`);
        }
      } catch (cause) {
        message.textContent = cause.status === 401 ? 'Sign in failed. Check the operator password.' :
          cause.status === 429 ? 'Sign in rate limit reached. Try again after the cooldown.' :
          `Sign in unavailable (${cause.data?.error ?? 'command_failed'}).`;
      }
    });
    logoutButton.addEventListener('click', async () => {
      try { await authRequest('/api/session', { method: 'DELETE', csrf: true }); }
      catch { /* Expired sessions are discarded locally as well. */ }
      csrfToken = null; setAuthState(false); invalidateReview();
      setSetupStatus('Signed out. No setup request can be sent until you sign in again.');
    });
  }
  function setAuthStateInitial() {
    if (onOperatorOrigin) setAuthState(false);
  }
  setAuthStateInitial();
}
