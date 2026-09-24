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

async function pollOperation(id, request, setStatus, onChanged) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const op = await request(`/api/operations/${encodeURIComponent(id)}`);
      const stage = op.stage ?? op.status ?? 'unavailable';
      setStatus(`Retain-close ${op.status ?? 'status unavailable'} · ${stage}. Paid costs and final economics remain unavailable.`);
      await onChanged(op);
      if (['succeeded', 'completed', 'failed', 'rejected', 'blocked', 'cancelled'].includes(op.status)) return;
    } catch (error) {
      setStatus(`Retain-close accepted · latest stage unavailable (${error?.data?.error ?? error?.message ?? 'command_failed'}). Check Positions history.`);
      return;
    }
  }
}
