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
    if (!response.ok) throw Object.assign(new Error(data.error ?? `Request failed (${response.status})`), { status: response.status, data });
    return data;
  };
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
    document.getElementById('setup-review').hidden = true;
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
    setSetupStatus(isAvailable ? 'Preflight completed. Review the exact bounds and provisional estimates below; admission limits were not evaluated.' : `Preflight unavailable: ${missing || 'required evidence unavailable'}.`);
  }
  document.getElementById('setup-form').addEventListener('submit', runSetupReview);

  function setAuthState(signedIn) {
    document.getElementById('operator-login-fields').hidden = signedIn;
    logoutButton.hidden = !signedIn;
    document.getElementById('operator-auth-status').textContent = signedIn ? 'Authenticated for this browser session.' : 'Not signed in. Session credentials stay in this page memory.';
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
