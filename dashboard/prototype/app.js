'use strict';
// Reuse the deployed read-only dashboard. All controls below are browser-only UX demos.
const $ = (selector) => document.querySelector(selector);
const frames = {research: $('#research-frame'), positions: $('#positions-frame')};
const loaded = {research: false, positions: false};
const demoPositions = {
  live: [{id: 'sample-live', label: 'Sample live position', status: 'active', events: []}],
  paper: [{id: 'sample-paper', label: 'Sample paper position', status: 'active', events: []}],
};
const selected = {live: 'sample-live', paper: 'sample-paper'};
let pools = [];
let reviewed = null;
let nextDemoId = 1;

function showTab(tab) {
  for (const name of ['research', 'positions']) {
    $(`#${name}-panel`).hidden = name !== tab;
    $(`#${name}-tab`).setAttribute('aria-selected', String(name === tab));
  }
  if (!loaded[tab]) loadDashboard(tab);
  else resizeFrame(frames[tab]);
}

function resizeFrame(frame) {
  if (frame.hidden) return;
  try {
    const doc = frame.contentDocument;
    const height = doc.body?.scrollHeight ?? 0;
    if (height > 0) frame.style.height = `${Math.max(450, height + 4)}px`;
  } catch { /* The visible fallback link handles an unavailable dashboard. */ }
}

async function loadDashboard(tab) {
  loaded[tab] = true;
  const frame = frames[tab];
  const status = $(`#${tab}-status`);
  try {
    const response = await fetch(tab === 'research' ? '/research' : '/', {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (!html.includes('<!doctype html>')) throw new Error('Dashboard HTML unavailable');
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      frame.hidden = false;
      status.hidden = true;
      resizeFrame(frame);
      new frame.contentWindow.ResizeObserver(() => resizeFrame(frame)).observe(doc.body);
      if (tab === 'positions') attachPositionControls(frame);
    }, {once: true});
    // srcdoc keeps the two existing dashboard scripts and styles in separate
    // documents while allowing them to use their normal same-origin APIs.
    // The dashboard's frame-ancestors policy blocks a direct iframe URL.
    frame.srcdoc = html.replace('</head>', '<style>html,body{overflow:hidden!important}.masthead,footer{display:none!important}</style></head>');
  } catch (error) {
    loaded[tab] = false;
    status.replaceChildren(document.createTextNode(`Could not load the dashboard (${error.message}). `));
    const link = document.createElement('a');
    link.href = tab === 'research' ? '/research' : '/';
    link.textContent = `Open ${tab} directly`;
    status.append(link);
  }
}

function node(doc, tag, className, text) {
  const result = doc.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function attachPositionControls(frame) {
  const doc = frame.contentDocument;
  const style = node(doc, 'style');
  style.textContent = `
    .prototype-action-card{margin:18px 0 30px;padding:18px;background:#19212b;border:1px solid #3d4d5d;border-radius:9px}
    .prototype-action-card h3{margin:0 0 5px;font-size:15px}.prototype-action-card p{margin:5px 0 12px;color:#a9b7c5;font-size:12px;line-height:1.5}
    .prototype-action-card label{display:grid;gap:6px;max-width:390px;color:#a9b7c5;font-size:12px}
    .prototype-action-card select{padding:9px 11px;color:#e5ecf4;background:#1e2833;border:1px solid #3d4d5d;border-radius:7px}
    .prototype-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:13px 0}.prototype-action-buttons button{padding:9px 12px}
    .prototype-action-card button:disabled{opacity:.45;cursor:not-allowed}.prototype-demo-state{font-weight:650;color:#e5ecf4!important}
  `;
  doc.head.append(style);
  for (const mode of ['live', 'paper']) {
    const section = doc.querySelector(`#${mode}`);
    if (!section) continue;
    const ensure = () => {
      if (section.querySelector('.prototype-action-card')) return;
      const card = node(doc, 'div', 'prototype-action-card');
      section.append(card);
      renderActions(frame, mode);
      resizeFrame(frame);
    };
    new frame.contentWindow.MutationObserver(ensure).observe(section, {childList: true});
    ensure();
  }
}

function renderActions(frame, mode) {
  const doc = frame.contentDocument;
  if (!doc) return;
  const card = doc.querySelector(`#${mode} .prototype-action-card`);
  if (!card) return;
  const entries = demoPositions[mode];
  const position = entries.find((entry) => entry.id === selected[mode]) ?? entries[0];
  selected[mode] = position.id;
  card.replaceChildren();
  card.append(node(doc, 'h3', '', `${mode === 'live' ? 'Live' : 'Paper'} position actions`));
  card.append(node(doc, 'p', '', 'Demo controls only. Dashboard records above stay unchanged; no operation is submitted.'));
  const label = node(doc, 'label', '', 'Try actions on a demo position');
  const picker = node(doc, 'select');
  for (const entry of entries) {
    const option = node(doc, 'option', '', entry.label);
    option.value = entry.id;
    picker.append(option);
  }
  picker.value = position.id;
  picker.addEventListener('change', () => {selected[mode] = picker.value; renderActions(frame, mode);});
  label.append(picker);
  card.append(label);
  const state = position.status === 'closed-retain' ? 'Closed · tokens retained' :
    position.status === 'closed-convert' ? 'Closed · converted to USDG' :
    position.status === 'paused' ? 'Management paused' : 'Active';
  card.append(node(doc, 'p', 'prototype-demo-state', `${state} · demo`));
  const buttons = node(doc, 'div', 'prototype-action-buttons');
  const closed = position.status.startsWith('closed');
  for (const [action, caption] of [
    ['pause', position.status === 'paused' ? 'Resume management' : 'Pause management'],
    ['retain', 'Close · retain tokens'],
    ['convert', 'Close · convert to USDG'],
  ]) {
    const button = node(doc, 'button', '', caption);
    button.type = 'button';
    button.disabled = closed;
    button.addEventListener('click', () => {
      if (action === 'pause') position.status = position.status === 'paused' ? 'active' : 'paused';
      else position.status = action === 'retain' ? 'closed-retain' : 'closed-convert';
      position.events.push(caption);
      renderActions(frame, mode);
    });
    buttons.append(button);
  }
  card.append(buttons);
  if (position.events.length) card.append(node(doc, 'p', '', `Demo activity: ${position.events.join(' → ')}`));
}

const tier = (fee) => `${(fee / 10000).toFixed(2)}% tier`;
const widthPercent = (ticks) => {
  const value = Math.expm1(ticks * Math.log(1.0001)) * 100;
  return `~${value.toFixed(value < 1 ? 2 : 1)}%`;
};
const poolName = (pool) => `${pool.rwaSymbol} / USDG · ${tier(pool.fee)}`;

async function loadPools() {
  const picker = $('#pool');
  try {
    const response = await fetch('/api/research', {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    pools = (snapshot.pools ?? []).filter((pool) =>
      pool.poolAddress && pool.rwaSymbol && Number.isInteger(pool.fee) && Number.isInteger(pool.tickSpacing) && pool.tickSpacing > 0);
    if (!pools.length) throw new Error('No pools available');
    picker.replaceChildren(...pools.map((pool) => {
      const option = document.createElement('option');
      option.value = pool.poolAddress;
      option.textContent = poolName(pool);
      return option;
    }));
    picker.disabled = false;
    updateWidths();
  } catch (error) {
    picker.replaceChildren(new Option('Pools unavailable', ''));
    $('#form-error').textContent = `Pool list unavailable (${error.message}). Reload to retry.`;
    $('#form-error').hidden = false;
  }
}

function updateWidths() {
  const pool = pools.find((item) => item.poolAddress === $('#pool').value);
  const picker = $('#half-width');
  if (!pool) {picker.disabled = true; return;}
  picker.replaceChildren(...[1, 2, 4, 8, 16].map((multiple) => {
    const ticks = pool.tickSpacing * multiple;
    return new Option(`${ticks} ticks (${widthPercent(ticks)})`, String(ticks));
  }));
  picker.value = String(pool.tickSpacing * 4);
  picker.disabled = false;
  $('#setup-review').hidden = true;
}

function reviewFact(label, value) {
  const row = document.createElement('div');
  const name = document.createElement('dt'); name.textContent = label;
  const detail = document.createElement('dd'); detail.textContent = value;
  row.append(name, detail);
  return row;
}

$('#setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const pool = pools.find((item) => item.poolAddress === $('#pool').value);
  const capital = Number($('#capital').value);
  const ticks = Number($('#half-width').value);
  const error = $('#form-error');
  if (!pool || !Number.isFinite(capital) || capital < 1 || capital > 10000 ||
      !Number.isInteger(ticks) || ticks < pool.tickSpacing || ticks % pool.tickSpacing !== 0) {
    error.textContent = 'Choose an available pool, valid tick width and capital from 1 to 10,000 USDG.';
    error.hidden = false;
    return;
  }
  reviewed = {pool, capital, ticks, strategy: $('#strategy').value, mode: $('#mode').value};
  error.hidden = true;
  $('#review-facts').replaceChildren(
    reviewFact('Pool', poolName(pool)),
    reviewFact('Capital', `${capital.toLocaleString('en-US')} USDG`),
    reviewFact('Half-width around center', `${ticks} ticks (${widthPercent(ticks)})`),
    reviewFact('Strategy', reviewed.strategy === 'static' ? 'Static / manual' : 'RangeKeeper'),
    reviewFact('Mode', reviewed.mode === 'live' ? 'Live demo' : 'Paper demo'),
  );
  $('#setup-review').hidden = false;
  $('#setup-review').scrollIntoView({block: 'nearest', behavior: 'smooth'});
});

$('#create-demo').addEventListener('click', () => {
  if (!reviewed) return;
  const {pool, mode, strategy} = reviewed;
  const position = {
    id: `new-demo-${nextDemoId++}`,
    label: `${pool.rwaSymbol} ${tier(pool.fee)} · ${strategy === 'static' ? 'Static' : 'RangeKeeper'} (demo)`,
    status: 'active', events: ['Created demo position'],
  };
  demoPositions[mode].push(position);
  selected[mode] = position.id;
  renderActions(frames.positions, mode);
  $('#setup-review').hidden = true;
  frames.positions.contentDocument?.querySelector(`#${mode} .prototype-action-card`)?.scrollIntoView({block: 'center', behavior: 'smooth'});
});

for (const tab of ['research', 'positions'])
  $(`#${tab}-tab`).addEventListener('click', () => showTab(tab));
$('#pool').addEventListener('change', updateWidths);
$('#setup-form').addEventListener('input', () => {reviewed = null; $('#setup-review').hidden = true;});
showTab(new URLSearchParams(location.search).get('tab') === 'positions' ? 'positions' : 'research');
loadPools();
