'use strict';

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
  tabs[index].focus();
  selectTab(tabs[index]);
  event.preventDefault();
});
tabs.forEach((tab, index) => { tab.tabIndex = index === 0 ? 0 : -1; });

const poolSelect = document.getElementById('setup-pool');
const widthSelect = document.getElementById('setup-width');
const reviewButton = document.getElementById('setup-review-button');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let registeredPools = [];
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
  widthSelect.value = String(spacing * 4);
  widthSelect.disabled = false;
}
poolSelect.addEventListener('change', renderWidths);
fetch('/api/research', { headers: { accept: 'application/json' } }).then((response) => {
  if (!response.ok) throw new Error('Research pool registry unavailable');
  return response.json();
}).then((snapshot) => {
  registeredPools = (snapshot.pools ?? []).filter((pool) => pool.registryEnabled === true)
    .sort((a, b) => a.rwaSymbol.localeCompare(b.rwaSymbol) || a.fee - b.fee);
  if (!registeredPools.length) throw new Error('No enabled registered pools are available');
  poolSelect.innerHTML = registeredPools.map((pool) =>
    `<option value="${esc(pool.poolAddress)}">${esc(pool.rwaSymbol)} / USDG · ${pool.fee / 10000}% fee tier · spacing ${pool.tickSpacing}</option>`).join('');
  poolSelect.disabled = false;
  renderWidths();
  reviewButton.disabled = false;
}).catch((error) => {
  poolSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
});

document.getElementById('setup-form').addEventListener('input', () => {
  document.getElementById('setup-review').hidden = true;
});
document.getElementById('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const error = document.getElementById('setup-error');
  const pool = registeredPools.find((candidate) => candidate.poolAddress === poolSelect.value);
  const capital = Number(document.getElementById('setup-capital').value);
  const ticks = Number(widthSelect.value);
  if (!pool || !Number.isFinite(capital) || capital < 1 || capital > 10000 ||
      !Number.isSafeInteger(ticks) || ticks < pool.tickSpacing || ticks % pool.tickSpacing !== 0) {
    error.textContent = 'Choose a registered pool, valid tick half-width and capital from 1 to 10,000 USDG.';
    error.hidden = false;
    return;
  }
  error.hidden = true;
  const facts = [
    ['Pool', poolSelect.selectedOptions[0].textContent],
    ['Capital', `${capital.toLocaleString('en-US')} USDG`],
    ['Half-width around center', widthSelect.selectedOptions[0].textContent],
    ['Strategy', document.getElementById('setup-strategy').selectedOptions[0].textContent],
    ['Mode', document.getElementById('setup-mode').selectedOptions[0].textContent],
  ];
  const container = document.getElementById('setup-review-facts');
  container.replaceChildren(...facts.map(([name, value]) => {
    const row = document.createElement('div');
    const label = document.createElement('dt'); label.textContent = name;
    const content = document.createElement('dd'); content.textContent = value;
    row.append(label, content);
    return row;
  }));
  document.getElementById('setup-review').hidden = false;
});
