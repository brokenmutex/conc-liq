'use strict';

export const SETUP_PREFLIGHT_PATH = '/api/deployments/setup-preflight';

export function capitalToQuoteRaw(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const raw = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
  return raw > 0n && raw <= 100_000n * 1_000_000n ? String(raw) : null;
}

export function setupPreflightRequest({ pool, capital, halfWidthTicks, strategyId, mode }) {
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
  return { available: true, payload: { profileId, capitalQuoteRaw, halfWidthTicks: ticks } };
}

export function preflightFacts(result) {
  if (!result || typeof result !== 'object') return [];
  const facts = [];
  if (result.profile) facts.push(['Registered pool / fee tier', `${result.profile.pool ?? 'Unavailable'} · ${result.profile.fee ?? 'Unavailable'}`]);
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
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let registeredPools = [];
  let marketProfiles = [];
  let researchPools = [];
  let currentSetupPreflight = null;
  let csrfToken = null;
  const setSetupStatus = (message, kind = 'unavailable') => {
    setupNote.textContent = message;
    setupNote.dataset.state = kind;
    setupNote.setAttribute('role', 'status');
  };
  const authRequest = async (path, { method = 'GET', body, csrf = false } = {}) => {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrfToken ?? '';
    const response = await fetch(path, { method, credentials: 'same-origin', headers,
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
    currentSetupPreflight = null;
    document.getElementById('setup-review').hidden = true;
    document.getElementById('operator-draft-binding').hidden = true;
    setSetupStatus('Selection changed. Review again to request a fresh source and range preflight.');
  }
  document.getElementById('setup-form').addEventListener('input', invalidateReview);
  document.getElementById('setup-form').addEventListener('change', invalidateReview);
  async function runSetupReview(event) {
    event.preventDefault();
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
    const request = setupPreflightRequest({ pool, capital, halfWidthTicks: ticks, strategyId, mode });
    if (!request.available) { setSetupStatus(`Preflight unavailable: ${request.reason}`); return; }
    setSetupStatus('Checking fresh source, independent references, registered profile and estimated costs…', 'loading');
    try {
      const result = await authRequest(SETUP_PREFLIGHT_PATH, { method: 'POST', body: request.payload, csrf: true });
      renderPreflight(result);
    } catch (cause) {
      const reason = cause.status === 401 ? 'Operator session expired. Sign in again; no draft or operation was created.' :
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
      'Binding values are structurally complete. Wallet ownership/funding and all policy admission remain unchecked; no draft was saved.':
      `Review incomplete: ${result.missing.join(', ')}.`;
    const facts=document.getElementById('operator-draft-binding-facts');
    if(result.status!=='reviewable'){facts.replaceChildren();return;}
    const binding=result.binding,proposal=binding.proposedDraft,rows=[
      ['Wallet identity · syntax only',proposal.wallet],['Funding status','Unchecked'],
      ['Registered market profile',binding.profileId],['Pool / fee tier',`${currentSetupPreflight.profile.pool} · ${currentSetupPreflight.profile.fee}`],
      ['Preflight source block / hash',`${binding.source.block} · ${binding.source.hash}`],
      ['Campaign revision','None · no draft exists'],['Capital budget · raw USDG',currentSetupPreflight.input.capitalQuoteRaw],
      ['Centered half-width · ticks',String(proposal.config.halfWidthTicks)],
      ['Resolved tick bounds',`${currentSetupPreflight.range.tickLower} to ${currentSetupPreflight.range.tickUpper}`],
      [`${currentSetupPreflight.profile.token0} allocation · raw`,proposal.allocation.token0Raw],
      [`${currentSetupPreflight.profile.token1} allocation · raw`,proposal.allocation.token1Raw],
      ['Native gas allocation · wei',proposal.allocation.nativeWei],
      ...Object.entries(proposal.config.limits).map(([key,value])=>[limitLabels[key]??key,String(value)]),
      ['Policy admission','Not evaluated'],['Draft persistence','Unavailable · no request sent'],
    ];
    facts.replaceChildren(...rows.map(([name,value])=>{const row=document.createElement('div');
      const label=document.createElement('dt');label.textContent=name;
      const detail=document.createElement('dd');detail.textContent=value;row.append(label,detail);return row;}));
  }
  for(const id of ['setup-wallet-address','setup-allocation-native',...Object.values(limitInputIds)]){
    document.getElementById(id).addEventListener('input',updateDraftBinding);
    document.getElementById(id).addEventListener('change',updateDraftBinding);
  }
  document.getElementById('setup-form').addEventListener('submit', runSetupReview);

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
