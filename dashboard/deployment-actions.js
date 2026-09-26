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
export function mountStaticConvertAction(root, {campaignId, authenticated, request,
  onAccepted = () => {}, now = Date.now} = {}) {
  root.replaceChildren();
  const onOperator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (!onOperator || !uuid.test(campaignId ?? '') || typeof request !== 'function') return;
  const storageKey = `concliq.operator.paper-convert.pending.v1.${campaignId}`;
  const button = document.createElement('button'); button.type = 'button';
  button.textContent = 'Review convert-close'; button.disabled = !authenticated?.();
  const status = document.createElement('p'); status.className = 'retain-action-status';
  status.setAttribute('role', 'status');
  const review = document.createElement('div'); review.className = 'retain-action-review'; review.hidden = true;
  const retry = document.createElement('button'); retry.type = 'button';
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
  } else setStatus(authenticated?.() ? 'Static/manual paper convert-close only.' :
    'Sign in on this loopback page to review convert-close.');
  button.addEventListener('click', async () => {
    if (pending || !authenticated?.()) return;
    button.disabled = true; review.hidden = true;
    setStatus('Checking a fresh source, modeled fee carry and prospective convert cost…');
    try {
      const preview = await request(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        {method: 'POST', body: {kind: 'close_convert'}});
      review.replaceChildren();
      const heading = document.createElement('h4'); heading.textContent = 'Convert-close preview'; review.append(heading);
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
      accept.className = 'retain-confirm-button'; accept.textContent = 'Accept convert-close';
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
  onAccepted = () => {}, now = Date.now } = {}) {
  root.replaceChildren();
  const onOperator = location.pathname === '/operator' || location.pathname.startsWith('/operator/');
  if (!onOperator || !uuid.test(campaignId ?? '') || typeof request !== 'function') return;

  const previewButton = document.createElement('button');
  previewButton.type = 'button'; previewButton.className = 'retain-preview-button';
  previewButton.textContent = 'Review retain-close';
  previewButton.disabled = !authenticated?.();
  previewButton.title = previewButton.disabled ? 'Sign in to request a fresh close preview' : '';
  const status = document.createElement('p'); status.className = 'retain-action-status';
  status.setAttribute('role', 'status');
  status.textContent = authenticated?.() ? 'Static/manual paper retain-close only.' :
    'Sign in on this loopback page to request a fresh retain-close preview.';
  const review = document.createElement('div'); review.className = 'retain-action-review'; review.hidden = true;
  root.append(previewButton, status, review);

  let preview = null;
  let idempotencyKey = null;
  const setStatus = value => { status.textContent = value; };
  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true;
    idempotencyKey = null;
    review.hidden = true; preview = null;
    setStatus('Checking a fresh canonical retain-close source and provisional gas estimate…');
    try {
      const result = await request(`/api/deployments/${encodeURIComponent(campaignId)}/previews`,
        { method: 'POST', body: { kind: 'close_retain' } });
      preview = result;
      review.replaceChildren();
      const heading = document.createElement('h4');
      heading.textContent = result.status === 'indicative' ? 'Retain-close preview' : 'Retain-close unavailable';
      review.append(heading);
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
      accept.setAttribute('aria-label', 'Accept static/manual paper retain-close');
      review.append(accept);
      accept.addEventListener('click', async () => {
        if (!idempotencyKey) idempotencyKey = globalThis.crypto?.randomUUID?.() ?? null;
        const payload = retainAcceptPayload(preview, idempotencyKey);
        if (!payload || !authenticated?.()) {
          accept.disabled = true; setStatus('Preview expired or authentication ended. Review a fresh preview.'); return;
        }
        accept.disabled = true; previewButton.disabled = true;
        setStatus(idempotencyKey ? 'Submitting the reviewed retain-close operation…' : 'A browser idempotency key is unavailable; acceptance is disabled.');
        if (!idempotencyKey) return;
        try {
          const accepted = await request(`/api/deployments/${encodeURIComponent(campaignId)}/operations`,
            { method: 'POST', body: payload });
          const validStatuses = ['queued','preflighting','executing','confirming','reconciling','blocked','succeeded','failed','cancelled','rejected','completed'];
          if (!uuid.test(accepted?.id ?? '') || !validStatuses.includes(accepted.status))
            throw new Error('operation_acceptance_response_invalid');
          idempotencyKey = null;
          setStatus(`Operation ${accepted.id} accepted · ${accepted.status}. Paid costs and final economics remain unavailable.`);
          try { await onAccepted(accepted); } catch { /* status polling remains authoritative */ }
          await pollOperation(accepted.id, request, setStatus, onAccepted);
        } catch (error) {
          const reason = error?.data?.error ?? error?.message ?? 'command_failed';
          if (error?.data?.error === 'operation_worker_not_ready') {
            idempotencyKey = null; accept.disabled = true;
            previewButton.disabled = !authenticated?.();
            setStatus('Worker readiness expired before acceptance. The server did not accept an operation; request a fresh preview when readiness returns.');
          } else if (error?.status >= 400 && error.status < 500) {
            idempotencyKey = null;
            accept.disabled = true;
            setStatus(error.status === 409 ? `Preview rejected as stale or conflicting (${reason}). Request a fresh preview.` :
              `Command service rejected acceptance (${reason}). Request a fresh preview before retrying.`);
            previewButton.disabled = !authenticated?.();
          } else {
            accept.disabled = false; accept.textContent = 'Retry same acceptance / reconcile';
            setStatus(`Acceptance outcome is unknown (${reason}). Retry with the same in-page idempotency key or refresh Positions to reconcile; do not submit a new preview yet.`);
          }
        }
      });
      review.hidden = false;
      setStatus(canAccept ? 'Review the retained lower bounds and provisional costs, then confirm once.' :
        'Preview saved for review; operation acceptance is unavailable.');
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      setStatus(error?.status === 409 ? `Fresh preview rejected (${reason}); refresh the position and retry.` :
        `Retain-close preview unavailable (${reason}). No operation was submitted.`);
    } finally {
      previewButton.disabled = !authenticated?.();
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
  previewButton.title = previewButton.disabled ? 'Sign in to request a fresh lifecycle preview' : '';
  const status = document.createElement('p'); status.className = 'retain-action-status';
  status.setAttribute('role', 'status');
  status.textContent = authenticated?.() ? `Static/manual paper ${kind} only.` :
    'Sign in on this loopback page to request a fresh lifecycle preview.';
  const review = document.createElement('div'); review.className = 'retain-action-review'; review.hidden = true;
  root.append(previewButton, status, review);
  let preview = null, idempotencyKey = null;
  const setStatus = value => { status.textContent = value; };
  previewButton.addEventListener('click', async () => {
    previewButton.disabled = true; idempotencyKey = null; preview = null; review.hidden = true;
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
        if (!idempotencyKey) idempotencyKey = globalThis.crypto?.randomUUID?.() ?? null;
        const payload = lifecycleAcceptPayload(preview, kind, idempotencyKey);
        if (!payload || !authenticated?.()) {
          accept.disabled = true; setStatus('Preview expired or authentication ended. Review a fresh lifecycle preview.'); return;
        }
        accept.disabled = true; previewButton.disabled = true;
        if (!idempotencyKey) { setStatus('A browser idempotency key is unavailable; acceptance is disabled.'); return; }
        setStatus(`Submitting the reviewed ${kind} operation…`);
        try {
          const accepted = await request(`/api/deployments/${encodeURIComponent(campaignId)}/lifecycle-operations`,
            { method: 'POST', body: payload });
          const validStatuses = ['queued','preflighting','executing','confirming','reconciling','blocked','succeeded','failed','cancelled','rejected','completed'];
          if (!uuid.test(accepted?.id ?? '') || !validStatuses.includes(accepted.status))
            throw new Error('operation_acceptance_response_invalid');
          idempotencyKey = null;
          setStatus(`${actionName} operation ${accepted.id} accepted · ${accepted.status}. Economics remain unavailable.`);
          try { await onAccepted(accepted); } catch { /* journal polling remains authoritative */ }
          await pollOperation(accepted.id, request, setStatus, onAccepted, actionName);
        } catch (error) {
          const reason = error?.data?.error ?? error?.message ?? 'command_failed';
          if (error?.data?.error === 'operation_worker_not_ready') {
            idempotencyKey = null; accept.disabled = true; previewButton.disabled = !authenticated?.();
            setStatus('Worker readiness expired before acceptance. The server did not accept an operation; request a fresh lifecycle preview when readiness returns.');
          } else if (error?.status >= 400 && error.status < 500) {
            idempotencyKey = null; accept.disabled = true; previewButton.disabled = !authenticated?.();
            setStatus(error.status === 409 ? `${actionName} preview rejected as stale or conflicting (${reason}). Request a fresh preview.` :
              `${actionName} command rejected (${reason}). Request a fresh preview before retrying.`);
          } else {
            accept.disabled = false; accept.textContent = `Retry same ${kind} / reconcile`;
            setStatus(`${actionName} acceptance outcome is unknown (${reason}). Retry with the same in-page idempotency key or reconcile in Positions; do not request another preview yet.`);
          }
        }
      });
      review.hidden = false;
      setStatus(canAccept ? `Review the saved ${kind} transition, then confirm once.` :
        'Lifecycle preview saved for review; operation acceptance is unavailable.');
    } catch (error) {
      const reason = error?.data?.error ?? error?.message ?? 'command_failed';
      setStatus(error?.status === 409 ? `Fresh ${kind} preview rejected (${reason}); refresh the position and retry.` :
        `${actionName} preview unavailable (${reason}). No operation was submitted.`);
    } finally { previewButton.disabled = !authenticated?.(); }
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
