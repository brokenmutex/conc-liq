'use strict';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;

export function retainPreviewCanBeAccepted(preview, now = Date.now()) {
  return Boolean(preview && preview.kind === 'close_retain' &&
    preview.status === 'indicative' && preview.actionAvailable === true &&
    preview.operationAcceptanceAvailable === true && uuid.test(preview.id ?? '') &&
    digest.test(preview.contentDigest ?? '') && Number.isSafeInteger(preview.expectedRevision) &&
    preview.expectedRevision > 0 && Number.isFinite(Date.parse(preview.expiresAt)) &&
    Date.parse(preview.expiresAt) > now);
}

export function retainAcceptPayload(preview, idempotencyKey) {
  if (!retainPreviewCanBeAccepted(preview)) return null;
  if (!uuid.test(idempotencyKey ?? '')) return null;
  return { previewId: preview.id, contentDigest: preview.contentDigest,
    expectedRevision: preview.expectedRevision, idempotencyKey };
}

export function convertPreviewCanBeAccepted(preview, now = Date.now()) {
  return Boolean(preview && preview.kind === 'close_convert' &&
    preview.terminalModelVersion === 3 && preview.status === 'indicative' &&
    preview.trustedPreviewSaved === true && preview.actionAvailable === true &&
    preview.operationAcceptanceAvailable === true && uuid.test(preview.id ?? '') &&
    digest.test(preview.contentDigest ?? '') && digest.test(preview.modelHash ?? '') &&
    Number.isSafeInteger(preview.expectedRevision) && preview.expectedRevision > 0 &&
    Number.isFinite(Date.parse(preview.expiresAt)) && Date.parse(preview.expiresAt) > now &&
    preview.costs?.status === 'provisional' &&
    preview.costs?.scope === 'candidate_prestate_gas_only' &&
    preview.costs?.pathVersion === 'paper_static_manual_close_convert_prestate_v1' &&
    preview.costs?.paidGasAvailable === false && preview.paidCostsAvailable === false &&
    preview.feeAccrualAvailable === false);
}

export function convertAcceptPayload(preview, idempotencyKey) {
  if (!convertPreviewCanBeAccepted(preview) || !uuid.test(idempotencyKey ?? '')) return null;
  return {previewId: preview.id, contentDigest: preview.contentDigest,
    expectedRevision: preview.expectedRevision, idempotencyKey};
}

export function lifecyclePreviewCanBeAccepted(preview, kind, now = Date.now()) {
  return Boolean(['pause', 'resume'].includes(kind) && preview && preview.kind === kind &&
    preview.status === 'indicative' && preview.actionAvailable === true &&
    preview.operationAcceptanceAvailable === true && uuid.test(preview.id ?? '') &&
    digest.test(preview.contentDigest ?? '') && Number.isSafeInteger(preview.expectedRevision) &&
    preview.expectedRevision > 0 && Number.isFinite(Date.parse(preview.expiresAt)) &&
    Date.parse(preview.expiresAt) > now);
}

export function lifecycleAcceptPayload(preview, kind, idempotencyKey) {
  if (!lifecyclePreviewCanBeAccepted(preview, kind)) return null;
  if (!uuid.test(idempotencyKey ?? '')) return null;
  return { previewId: preview.id, contentDigest: preview.contentDigest,
    expectedRevision: preview.expectedRevision, idempotencyKey };
}

const pendingAcceptanceKey = (campaignId, kind) =>
  `concliq.operator.paper-action.pending.v1.${campaignId}.${kind}`;
function validPendingAcceptance(value, campaignId, kind) {
  return Boolean(value && value.campaignId === campaignId && value.kind === kind &&
    uuid.test(value.payload?.previewId ?? '') && digest.test(value.payload?.contentDigest ?? '') &&
    Number.isSafeInteger(value.payload?.expectedRevision) && value.payload.expectedRevision > 0 &&
    uuid.test(value.payload?.idempotencyKey ?? ''));
}
function readPendingAcceptance(campaignId, kind) {
  try {
    const raw = localStorage.getItem(pendingAcceptanceKey(campaignId, kind));
    if (raw === null) return null;
    let saved;
    try { saved = JSON.parse(raw); } catch { return {campaignId,kind,invalid:true}; }
    if (!validPendingAcceptance(saved, campaignId, kind)) return {campaignId,kind,invalid:true};
    // Normalize to the request-only shape. Credentials and unrelated storage
    // fields are never copied into the action's in-memory recovery record.
    return {campaignId, kind, payload:{previewId:saved.payload.previewId,
      contentDigest:saved.payload.contentDigest,expectedRevision:saved.payload.expectedRevision,
      idempotencyKey:saved.payload.idempotencyKey}};
  } catch { return null; }
}
function persistPendingAcceptance(campaignId, kind, payload) {
  if (!validPendingAcceptance({campaignId,kind,payload},campaignId,kind)) return false;
  try {
    localStorage.setItem(pendingAcceptanceKey(campaignId, kind), JSON.stringify({campaignId,kind,
      payload:{previewId:payload.previewId,contentDigest:payload.contentDigest,
        expectedRevision:payload.expectedRevision,idempotencyKey:payload.idempotencyKey}}));
    return true;
  } catch { return false; }
}
function clearPendingAcceptance(campaignId, kind) {
  try { localStorage.removeItem(pendingAcceptanceKey(campaignId, kind)); return true; }
  catch { return false; }
}
function knownNoAcceptance(error) {
  return error?.status === 503 && error?.data?.error === 'operation_worker_not_ready' ||
    error?.status === 409;
}

const recoveryInFlight = new Set();
function savedPaperAcceptances() {
  const records = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const action = /^concliq\.operator\.paper-action\.pending\.v1\.([0-9a-f-]{36})\.(pause|resume|close_retain)$/i.exec(key ?? '');
      const convert = /^concliq\.operator\.paper-convert\.pending\.v1\.([0-9a-f-]{36})$/i.exec(key ?? '');
      if (!action && !convert) continue;
      const campaignId = (action ?? convert)[1], kind = action?.[2] ?? 'close_convert';
      if (!uuid.test(campaignId)) continue;
      let record;
      if (action) record = readPendingAcceptance(campaignId, kind);
      else {
        try {
          const saved = JSON.parse(localStorage.getItem(key));
          record = validPendingAcceptance({...saved, kind}, campaignId, kind) ?
            {campaignId, kind, payload:{previewId:saved.payload.previewId,
              contentDigest:saved.payload.contentDigest,expectedRevision:saved.payload.expectedRevision,
              idempotencyKey:saved.payload.idempotencyKey}} : {campaignId,kind,invalid:true};
        } catch { record = {campaignId,kind,invalid:true}; }
      }
      if (record) records.push({...record,key});
    }
  } catch { /* Existing action widgets report unavailable browser storage. */ }
  return records.sort((a,b)=>a.key.localeCompare(b.key));
}

/** Recovery remains reachable after accepted operations change the campaign's
 * lifecycle and its fresh-action widgets disappear. It only resends the saved
 * acceptance payload; it cannot request a new preview. */
export function mountPendingPaperAcceptanceRecovery(root, {authenticated, request,
  onAccepted = () => {}} = {}) {
  if (!root) return;
  const operator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  const records = operator ? savedPaperAcceptances() : [];
  const identity = JSON.stringify([Boolean(authenticated?.()),records]);
  if (root.dataset.recoveryIdentity === identity) return;
  root.dataset.recoveryIdentity = identity;
  root.replaceChildren(); root.hidden = records.length === 0;
  if (!records.length) return;
  const heading = document.createElement('h2'); heading.textContent = 'Pending paper request recovery';
  root.append(heading);
  for (const record of records) {
    const row = document.createElement('div'), status = document.createElement('p');
    row.className = 'paper-acceptance-recovery-row';
    const label = {pause:'Pause',resume:'Resume',close_retain:'Retain-close',close_convert:'Convert-close'}[record.kind];
    status.setAttribute('role','status');
    status.textContent = record.invalid ? `${label} · ${record.campaignId}: saved recovery record is invalid.` :
      `${label} · ${record.campaignId}: reconcile the saved request to learn its outcome.`;
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'paper-acceptance-reconcile-button';
    button.dataset.campaignId = record.campaignId; button.dataset.kind = record.kind;
    button.textContent = 'Reconcile saved acceptance';
    button.disabled = Boolean(record.invalid) || !authenticated?.() || recoveryInFlight.has(record.key);
    row.append(status,button); root.append(row);
    button.addEventListener('click',async()=>{
      if (!record.payload || !authenticated?.() || recoveryInFlight.has(record.key) || typeof request !== 'function') return;
      recoveryInFlight.add(record.key); button.disabled = true;
      const suffix = record.kind === 'close_retain' ? 'operations' :
        record.kind === 'close_convert' ? 'close-convert-operations' : 'lifecycle-operations';
      const clearSameRequest = () => {
        const current = savedPaperAcceptances().find(item=>item.key === record.key);
        if (!current || JSON.stringify(current.payload) !== JSON.stringify(record.payload)) return false;
        localStorage.removeItem(record.key); return true;
      };
      try {
        const accepted = await request(`/api/deployments/${encodeURIComponent(record.campaignId)}/${suffix}`,
          {method:'POST',body:record.payload});
        if (!uuid.test(accepted?.id ?? '') || !['queued','preflighting','executing','confirming','reconciling',
          'blocked','succeeded','failed','cancelled','rejected','completed'].includes(accepted.status))
          throw new Error('operation_acceptance_response_invalid');
        if (!clearSameRequest()) throw new Error('saved_recovery_record_changed');
        status.textContent = `Operation ${accepted.id} · ${accepted.status}. See Positions for its recorded stage.`;
        await onAccepted(accepted);
      } catch (error) {
        if (knownNoAcceptance(error)) {
          try { clearSameRequest(); } catch { /* Retain the recovery record when storage cannot clear it. */ }
        }
        status.textContent = `Reconciliation unavailable (${error?.data?.error ?? error?.message ?? 'command_failed'}). Check Positions before continuing.`;
      } finally {
        recoveryInFlight.delete(record.key); button.disabled = !authenticated?.() || Boolean(record.invalid);
      }
    });
  }
}

const addFact = (list, label, value) => {
  const row = document.createElement('div'); row.className = 'retain-preview-fact';
  const name = document.createElement('span'); name.textContent = label;
  const detail = document.createElement('strong'); detail.textContent = value;
  row.append(name, detail); list.append(row);
};
function formatX18(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'Unavailable';
  const raw = BigInt(value), whole = raw / 10n ** 18n;
  const fraction = (raw % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${fraction}`;
}

/** The convert command is exposed only after the server returns a saved V3
 * preview with explicit worker readiness. A pending acceptance keeps its exact
 * request key across a page reload until the server reconciles its outcome. */
export function mountStaticConvertAction(root, {campaignId, positionLabel, authenticated, request,
  onAccepted = () => {}, now = Date.now} = {}) {
  root.replaceChildren();
  const onOperator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (!onOperator || !uuid.test(campaignId ?? '') || typeof request !== 'function') return;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `Close ${positionLabel || `campaign ${campaignId}`} · convert tokens to USDG`);
  const storageKey = `concliq.operator.paper-convert.pending.v1.${campaignId}`;
  const button = document.createElement('button'); button.type = 'button';
  button.className = 'convert-preview-button';
  button.textContent = 'Review convert-close'; button.disabled = !authenticated?.();
  button.setAttribute('aria-label', `Review close · convert ${positionLabel || `campaign ${campaignId}`} tokens to USDG`);
  const status = document.createElement('p'); status.className = 'convert-action-status';
  status.setAttribute('role', 'status');
  const review = document.createElement('div'); review.className = 'convert-action-review'; review.hidden = true;
  const retry = document.createElement('button'); retry.type = 'button';
  retry.className = 'convert-reconcile-button';
  retry.textContent = 'Retry same request / reconcile'; retry.hidden = true;
  retry.disabled = !authenticated?.();
  root.append(button, status, review, retry);
  let pending = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved?.campaignId === campaignId && uuid.test(saved?.payload?.previewId ?? '') &&
      digest.test(saved?.payload?.contentDigest ?? '') &&
      Number.isSafeInteger(saved?.payload?.expectedRevision) &&
      uuid.test(saved?.payload?.idempotencyKey ?? '')) pending = saved;
  } catch { /* A fresh preview remains reviewable, but acceptance needs storage. */ }
  const clear = () => {pending = null; retry.hidden = true;
    try { localStorage.removeItem(storageKey); } catch { /* fail closed below */ }};
  const setStatus = value => {status.textContent = value;};
  const submit = async () => {
    if (!pending || !authenticated?.()) return;
    button.disabled = true;
    setStatus('Submitting or reconciling the saved convert-close request…');
    try {
      const accepted = await request(`/api/deployments/${encodeURIComponent(campaignId)}/close-convert-operations`,
        {method: 'POST', body: pending.payload});
      if (!uuid.test(accepted?.id ?? '') || !['queued','preflighting','executing','confirming',
        'reconciling','blocked','succeeded','failed','cancelled','rejected','completed'].includes(accepted.status))
        throw new Error('operation_acceptance_response_invalid');
      clear();
      setStatus(`Convert-close operation ${accepted.id} · ${accepted.status}. Final economics remain unavailable until recorded.`);
      try {await onAccepted(accepted);} catch { /* operation journal is authoritative */ }
      await pollOperation(accepted.id, request, setStatus, onAccepted, 'Convert-close');
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      if (error?.status === 503 && ['operation_worker_not_ready',
        'paper_close_convert_acceptance_unavailable'].includes(error?.data?.error)) {
        clear(); setStatus(`Convert-close was not accepted (${reason}). Review a fresh preview when the worker is ready.`);
      } else if (error?.status >= 400 && error.status < 500 && error?.status !== 429) {
        clear(); setStatus(`Convert-close request rejected (${reason}). Review a fresh preview.`);
      } else {
        retry.hidden = false; retry.disabled = !authenticated?.();
        setStatus(`Acceptance outcome unknown (${reason}). Retry the same saved request to reconcile; do not create a new preview.`);
      }
    } finally {button.disabled = Boolean(pending) || !authenticated?.();}
  };
  retry.addEventListener('click', submit);
  if (pending) {
    button.disabled = true;
    setStatus(`A convert-close request may already be accepted for preview ${pending.payload.previewId}.`);
    retry.hidden = false;
  } else setStatus(authenticated?.() ? 'Paper close · convert the position tokens to USDG. The token balances will not be retained.' :
    'Operator connection is required to review convert-close.');
  button.addEventListener('click', async () => {
    if (pending || !authenticated?.()) return;
    button.disabled = true; review.hidden = true;
    setStatus('Checking a fresh source, modeled fee carry and prospective convert cost…');
    try {
      const preview = await request(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        {method: 'POST', body: {kind: 'close_convert'}});
      review.replaceChildren();
      const heading = document.createElement('h4'); heading.textContent =
        `${positionLabel ? `${positionLabel} · ` : ''}Close · convert tokens to USDG`; review.append(heading);
      const consequence = document.createElement('p'); consequence.className = 'convert-action-consequence';
      consequence.textContent = 'This paper close models swapping the position tokens into USDG. It does not retain the token balances.';
      review.append(consequence);
      const facts = document.createElement('div'); facts.className = 'retain-preview-facts';
      addFact(facts, 'Swap input · raw', preview.quote?.inputAmountRaw ?? 'Unavailable');
      addFact(facts, 'Minimum USDG output · raw', preview.quote?.minimumOutputRaw ?? 'Unavailable');
      addFact(facts, 'Expected USDG output · raw', preview.quote?.expectedOutputRaw ?? 'Unavailable');
      addFact(facts, 'Gas · expected / bound · reference USD', preview.costs ?
        `${formatX18(preview.costs.expectedValue)} / ${formatX18(preview.costs.boundValue)} · fork estimated` : 'Unavailable');
      addFact(facts, 'Modeled fee carry', 'Provisional · not earned');
      addFact(facts, 'Paid gas and final economics', 'Unavailable');
      review.append(facts);
      const canAccept = convertPreviewCanBeAccepted(preview, now());
      const detail = document.createElement('p');
      detail.textContent = canAccept ? 'Review the minimum output and provisional cost before confirming.' :
        'Operation acceptance is unavailable until the saved V3 preview and supervised worker pass their evidence gates.';
      review.append(detail);
      const accept = document.createElement('button'); accept.type = 'button';
      accept.className = 'convert-confirm-button'; accept.textContent = 'Confirm close · convert to USDG';
      accept.setAttribute('aria-label', `Confirm close · convert ${positionLabel || `campaign ${campaignId}`} tokens to USDG`);
      accept.disabled = !canAccept; review.append(accept);
      accept.addEventListener('click', () => {
        const key = globalThis.crypto?.randomUUID?.() ?? null;
        const payload = convertAcceptPayload(preview, key);
        if (!payload || !authenticated?.()) {accept.disabled = true; setStatus('Preview expired or authentication ended. Review again.'); return;}
        pending = {campaignId, payload};
        try {localStorage.setItem(storageKey, JSON.stringify(pending));}
        catch {pending = null; setStatus('This browser cannot retain a recovery key. No request was sent.'); return;}
        accept.disabled = true; void submit();
      });
      review.hidden = false;
      setStatus(canAccept ? 'Preview ready for review.' : 'Preview is indicative; operation acceptance is unavailable.');
    } catch (error) {
      setStatus(`Convert-close preview unavailable (${error?.data?.error ?? error?.message ?? 'command_failed'}). No operation was sent.`);
    } finally {button.disabled = !authenticated?.();}
  });
}

/** Mounts the one currently eligible browser action. Caller supplies the
 * in-memory authenticated request function; the CSRF token stays private. */
export function mountStaticRetainAction(root, { campaignId, authenticated, request,
  positionLabel, onAccepted = () => {}, now = Date.now } = {}) {
  root.replaceChildren();
  const onOperator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (!onOperator || !uuid.test(campaignId ?? '') || typeof request !== 'function') return;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `Close ${positionLabel || `campaign ${campaignId}`} · retain token balances`);

  const previewButton = document.createElement('button');
  previewButton.type = 'button'; previewButton.className = 'retain-preview-button';
  previewButton.textContent = 'Review retain-close';
  previewButton.setAttribute('aria-label', `Review close · retain ${positionLabel || `campaign ${campaignId}`} token balances`);
  previewButton.disabled = !authenticated?.();
  previewButton.title = previewButton.disabled ? 'Operator connection required for a fresh close preview' : '';
  const status = document.createElement('p'); status.className = 'retain-action-status';
  status.setAttribute('role', 'status');
  const storageKind = 'close_retain';
  let pending = readPendingAcceptance(campaignId, storageKind);
  status.textContent = pending ? 'A retain-close acceptance may already be queued. Reconcile the same request before requesting another preview.' :
    authenticated?.() ? 'Paper close · retain the position token balances in their current assets; no USDG swap.' :
      'Operator connection required for a fresh retain-close preview.';
  const review = document.createElement('div'); review.className = 'retain-action-review'; review.hidden = true;
  const retry = document.createElement('button'); retry.type = 'button';
  retry.className = 'retain-reconcile-button'; retry.textContent = 'Retry same acceptance / reconcile';
  retry.hidden = !pending; retry.disabled = !authenticated?.() || Boolean(pending?.invalid);
  root.append(previewButton, status, review, retry);
  if (pending?.invalid) status.textContent = 'A saved retain-close recovery record is invalid. Fresh previews are blocked; reconcile this campaign in Positions before continuing.';

  let preview = null, acceptedOperation = false;
  const setStatus = value => { status.textContent = value; };
  const syncButtons = () => {
    previewButton.disabled = Boolean(pending) || acceptedOperation || !authenticated?.();
    retry.hidden = !pending; retry.disabled = !pending || Boolean(pending.invalid) || !authenticated?.();
  };
  const clearPending = () => {
    if (!clearPendingAcceptance(campaignId, storageKind)) {
      pending = {campaignId,kind:storageKind,invalid:true};
      setStatus('The saved retain-close recovery key could not be cleared. Fresh previews remain blocked until the browser can reconcile it.');
      syncButtons(); return false;
    }
    pending = null; syncButtons(); return true;
  };
  const submitPending = async button => {
    if (!pending?.payload || !authenticated?.()) return;
    button.disabled = true; previewButton.disabled = true;
    setStatus('Submitting or reconciling the saved retain-close request…');
    try {
      const accepted = await request(`/api/deployments/${encodeURIComponent(campaignId)}/operations`,
        { method: 'POST', body: pending.payload });
      const validStatuses = ['queued','preflighting','executing','confirming','reconciling','blocked','succeeded','failed','cancelled','rejected','completed'];
      if (!uuid.test(accepted?.id ?? '') || !validStatuses.includes(accepted.status))
        throw new Error('operation_acceptance_response_invalid');
      acceptedOperation = true;
      if (!clearPending()) return;
      setStatus(`Operation ${accepted.id} accepted · ${accepted.status}. Paid costs and final economics remain unavailable.`);
      try { await onAccepted(accepted); } catch { /* status polling remains authoritative */ }
      await pollOperation(accepted.id, request, setStatus, onAccepted);
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      if (knownNoAcceptance(error)) {
        if (!clearPending()) return;
        button.disabled = true; syncButtons();
        setStatus(error?.data?.error === 'operation_worker_not_ready' ?
          'Worker readiness expired before acceptance. The server found no saved operation for this request; request a fresh preview when readiness returns.' :
          `Retain-close request rejected as stale or conflicting (${reason}). Request a fresh preview.`);
      } else if (error?.status >= 400 && error?.status < 500 && error?.status !== 429) {
        // Authentication and authorization failures do not prove that an
        // earlier request was absent, so retain the key for a later reconcile.
        retry.hidden = false; retry.disabled = !authenticated?.(); button.disabled = false;
        button.textContent = 'Retry same acceptance / reconcile';
        setStatus(`Acceptance outcome remains unknown (${reason}). Keep the saved request and retry it to reconcile; do not request a new preview.`);
      } else {
        retry.hidden = false; retry.disabled = !authenticated?.(); button.disabled = false;
        button.textContent = 'Retry same acceptance / reconcile';
        setStatus(`Acceptance outcome is unknown (${reason}). Retry the same saved request to reconcile; do not submit a new preview yet.`);
      }
    }
  };
  retry.addEventListener('click', () => { void submitPending(retry); });
  if (pending && !pending.invalid) retry.disabled = !authenticated?.();
  syncButtons();
  previewButton.addEventListener('click', async () => {
    if (pending) return;
    previewButton.disabled = true;
    review.hidden = true; preview = null;
    setStatus('Checking a fresh canonical retain-close source and provisional gas estimate…');
    try {
      const result = await request(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        { method: 'POST', body: { kind: 'close_retain' } });
      preview = result;
      review.replaceChildren();
      const heading = document.createElement('h4');
      heading.textContent = `${positionLabel ? `${positionLabel} · ` : ''}${result.status === 'indicative' ?
        'Close · retain token balances' : 'Retain-close unavailable'}`;
      review.append(heading);
      const consequence = document.createElement('p'); consequence.className = 'retain-action-consequence';
      consequence.textContent = 'This paper close keeps the token balances in their current assets. It does not swap them into USDG.';
      review.append(consequence);
      if (result.retainedLowerBound) {
        const facts = document.createElement('div'); facts.className = 'retain-preview-facts';
        addFact(facts, 'Token 0 retained lower bound · raw', result.retainedLowerBound.token0Raw ?? 'Unavailable');
        addFact(facts, 'Token 1 retained lower bound · raw', result.retainedLowerBound.token1Raw ?? 'Unavailable');
        addFact(facts, 'Fee capture and paid gas', 'Unavailable');
        addFact(facts, 'Net economics', 'Unavailable');
        const closeCost = result.costs?.closeRetain;
        addFact(facts, 'Retain-close gas · expected / bound', closeCost ?
          `${closeCost.expectedGasUnits ?? 'Unavailable'} / ${closeCost.boundGasUnits ?? 'Unavailable'} units` : 'Unavailable');
        addFact(facts, 'Gas cost · expected / bound · reference USD', closeCost ?
          `${formatX18(closeCost.expectedValue)} / ${formatX18(closeCost.boundValue)} · provisional, not paid` : 'Unavailable · not paid');
        review.append(facts);
      }
      const canAccept = retainPreviewCanBeAccepted(result, now());
      if (!canAccept) {
        const detail = document.createElement('p');
        detail.textContent = result.actionAvailable === false || result.operationAcceptanceAvailable === false ?
          'Acceptance is unavailable because the command service has not proven supervised worker readiness.' :
          'This preview lacks a fresh, complete acceptance binding. Request another preview before any acceptance.';
        review.append(detail);
      }
      const accept = document.createElement('button'); accept.type = 'button';
      accept.className = 'retain-confirm-button'; accept.textContent = 'Accept retain-close';
      accept.disabled = !canAccept;
      accept.setAttribute('aria-label', `Confirm close · retain ${positionLabel || `campaign ${campaignId}`} token balances`);
      review.append(accept);
      accept.addEventListener('click', async () => {
        if (pending) { await submitPending(accept); return; }
        const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? null;
        const payload = retainAcceptPayload(preview, idempotencyKey);
        if (!payload || !authenticated?.()) {
          accept.disabled = true; setStatus('Preview expired or the operator session ended. Review a fresh preview.'); return;
        }
        if (!idempotencyKey) { accept.disabled = true; setStatus('A browser idempotency key is unavailable; acceptance is disabled.'); return; }
        if (!persistPendingAcceptance(campaignId, storageKind, payload)) {
          accept.disabled = true; setStatus('This browser cannot retain the recovery key. No operation request was sent.'); return;
        }
        pending = {campaignId,kind:storageKind,payload}; syncButtons();
        retry.textContent = 'Retry same acceptance / reconcile';
        await submitPending(accept);
      });
      review.hidden = false;
      setStatus(canAccept ? 'Review the retained lower bounds and provisional costs, then confirm once.' :
        'Preview saved for review; operation acceptance is unavailable.');
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      setStatus(error?.status === 409 ? `Fresh preview rejected (${reason}); refresh the position and retry.` :
        `Retain-close preview unavailable (${reason}). No operation was submitted.`);
    } finally {
      previewButton.disabled = Boolean(pending) || acceptedOperation || !authenticated?.();
    }
  });
}

/** Static/manual pause or resume, tied to its saved preview and the same
 * authenticated worker lease used by operation acceptance. */
export function mountPaperLifecycleAction(root, { campaignId, kind, authenticated, request,
  onAccepted = () => {}, now = Date.now } = {}) {
  root.replaceChildren();
  const onOperator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (!onOperator || !uuid.test(campaignId ?? '') || !['pause', 'resume'].includes(kind) ||
      typeof request !== 'function') return;
  const actionName = kind === 'pause' ? 'Pause' : 'Resume';
  const previewButton = document.createElement('button');
  previewButton.type = 'button'; previewButton.className = 'paper-lifecycle-preview-button';
  previewButton.textContent = `Review ${actionName.toLowerCase()}`;
  previewButton.disabled = !authenticated?.();
  previewButton.title = previewButton.disabled ? 'Operator connection required for a fresh lifecycle preview' : '';
  const status = document.createElement('p'); status.className = 'retain-action-status';
  status.setAttribute('role', 'status');
  const storageKind = kind;
  let pending = readPendingAcceptance(campaignId, storageKind);
  status.textContent = pending ? `A ${kind} acceptance may already be queued. Reconcile the same request before requesting another preview.` :
    authenticated?.() ? `Static/manual paper ${kind} only.` :
      'Operator connection required for a fresh lifecycle preview.';
  const review = document.createElement('div'); review.className = 'retain-action-review'; review.hidden = true;
  const retry = document.createElement('button'); retry.type = 'button';
  retry.className = 'paper-lifecycle-reconcile-button';
  retry.textContent = `Retry same ${kind} / reconcile`;
  retry.hidden = !pending; retry.disabled = !authenticated?.() || Boolean(pending?.invalid);
  root.append(previewButton, status, review, retry);
  if (pending?.invalid) status.textContent = `A saved ${kind} recovery record is invalid. Fresh previews are blocked; reconcile this campaign in Positions before continuing.`;
  let preview = null, acceptedOperation = false;
  const setStatus = value => { status.textContent = value; };
  const syncButtons = () => {
    previewButton.disabled = Boolean(pending) || acceptedOperation || !authenticated?.();
    retry.hidden = !pending; retry.disabled = !pending || Boolean(pending.invalid) || !authenticated?.();
  };
  const clearPending = () => {
    if (!clearPendingAcceptance(campaignId, storageKind)) {
      pending = {campaignId,kind:storageKind,invalid:true};
      setStatus(`The saved ${kind} recovery key could not be cleared. Fresh previews remain blocked until the browser can reconcile it.`);
      syncButtons(); return false;
    }
    pending = null; syncButtons(); return true;
  };
  const submitPending = async button => {
    if (!pending?.payload || !authenticated?.()) return;
    button.disabled = true; previewButton.disabled = true;
    setStatus(`Submitting or reconciling the saved ${kind} request…`);
    try {
      const accepted = await request(`/api/deployments/${encodeURIComponent(campaignId)}/lifecycle-operations`,
        { method: 'POST', body: pending.payload });
      const validStatuses = ['queued','preflighting','executing','confirming','reconciling','blocked','succeeded','failed','cancelled','rejected','completed'];
      if (!uuid.test(accepted?.id ?? '') || !validStatuses.includes(accepted.status))
        throw new Error('operation_acceptance_response_invalid');
      acceptedOperation = true;
      if (!clearPending()) return;
      setStatus(`${actionName} operation ${accepted.id} accepted · ${accepted.status}. Economics remain unavailable.`);
      try { await onAccepted(accepted); } catch { /* journal polling remains authoritative */ }
      await pollOperation(accepted.id, request, setStatus, onAccepted, actionName);
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      if (knownNoAcceptance(error)) {
        if (!clearPending()) return;
        button.disabled = true; syncButtons();
        setStatus(error?.data?.error === 'operation_worker_not_ready' ?
          `Worker readiness expired before ${kind} acceptance. The server found no saved operation for this request; request a fresh preview when readiness returns.` :
          `${actionName} request rejected as stale or conflicting (${reason}). Request a fresh preview.`);
      } else {
        retry.hidden = false; retry.disabled = !authenticated?.(); button.disabled = false;
        button.textContent = `Retry same ${kind} / reconcile`;
        setStatus(`${actionName} acceptance outcome remains unknown (${reason}). Keep the saved request and retry it to reconcile; do not request another preview.`);
      }
    }
  };
  retry.addEventListener('click', () => { void submitPending(retry); });
  syncButtons();
  previewButton.addEventListener('click', async () => {
    if (pending) return;
    previewButton.disabled = true; preview = null; review.hidden = true;
    setStatus(`Checking the saved ${kind} transition and operation worker readiness…`);
    try {
      const result = await request(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        { method: 'POST', body: { kind } });
      preview = result; review.replaceChildren();
      const heading = document.createElement('h4');
      heading.textContent = result.status === 'indicative' ? `${actionName} management preview` : `${actionName} management unavailable`;
      review.append(heading);
      const transition = document.createElement('p');
      transition.textContent = result.proposal?.from && result.proposal?.to ?
        `Campaign lifecycle: ${result.proposal.from} → ${result.proposal.to}. No source or strategy configuration changes.` :
        'Saved lifecycle transition details are unavailable.';
      review.append(transition);
      const canAccept = lifecyclePreviewCanBeAccepted(result, kind, now());
      if (!canAccept) {
        const detail = document.createElement('p');
        detail.textContent = result.actionAvailable === false || result.operationAcceptanceAvailable === false ?
          'Acceptance is unavailable because the command service has not proven supervised worker readiness.' :
          'This preview lacks a fresh, complete acceptance binding. Request another preview before acceptance.';
        review.append(detail);
      }
      const accept = document.createElement('button'); accept.type = 'button';
      accept.className = 'paper-lifecycle-confirm-button'; accept.textContent = `${actionName} management`;
      accept.disabled = !canAccept; accept.setAttribute('aria-label', `Accept static/manual paper ${kind}`);
      review.append(accept);
      accept.addEventListener('click', async () => {
        if (pending) { await submitPending(accept); return; }
        const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? null;
        const payload = lifecycleAcceptPayload(preview, kind, idempotencyKey);
        if (!payload || !authenticated?.()) {
          accept.disabled = true; setStatus('Preview expired or authentication ended. Review a fresh lifecycle preview.'); return;
        }
        if (!idempotencyKey) { accept.disabled = true; setStatus('A browser idempotency key is unavailable; acceptance is disabled.'); return; }
        if (!persistPendingAcceptance(campaignId, storageKind, payload)) {
          accept.disabled = true; setStatus('This browser cannot retain the recovery key. No operation request was sent.'); return;
        }
        pending = {campaignId,kind:storageKind,payload}; syncButtons();
        await submitPending(accept);
      });
      review.hidden = false;
      setStatus(canAccept ? `Review the saved ${kind} transition, then confirm once.` :
        'Lifecycle preview saved for review; operation acceptance is unavailable.');
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      setStatus(error?.status === 409 ? `Fresh ${kind} preview rejected (${reason}); refresh the position and retry.` :
        `${actionName} preview unavailable (${reason}). No operation was submitted.`);
    } finally { previewButton.disabled = Boolean(pending) || acceptedOperation || !authenticated?.(); }
  });
}

async function pollOperation(id, request, setStatus, onChanged, actionName = 'Retain-close') {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const op = await request(`/api/operations/${encodeURIComponent(id)}`);
      const stage = op.stage ?? op.status ?? 'unavailable';
      setStatus(`${actionName} ${op.status ?? 'status unavailable'} · ${stage}. Paid costs and final economics remain unavailable.`);
      await onChanged(op);
      if (['succeeded', 'completed', 'failed', 'rejected', 'blocked', 'cancelled'].includes(op.status)) return;
    } catch (error) {
      setStatus(`${actionName} accepted · latest stage unavailable (${error?.data?.error ?? error?.message ?? 'command_failed'}). Check Positions history.`);
      return;
    }
  }
}
