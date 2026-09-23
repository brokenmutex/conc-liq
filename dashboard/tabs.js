'use strict';

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
    item.tabIndex = selected ? 0 : -1;
  }
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
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let registeredPools = [];
function renderWidths() {
  const pool = registeredPools.find((candidate) => candidate.poolAddress === poolSelect.value);
  if (!pool) { widthSelect.disabled = true; widthSelect.innerHTML = '<option value="">Choose a registered pool first</option>'; return; }
  const spacing = Number(pool.tickSpacing);
  if (!Number.isSafeInteger(spacing) || spacing <= 0) { widthSelect.disabled = true; widthSelect.innerHTML = '<option value="">Tick spacing unavailable</option>'; return; }
  const choices = [1, 5, 10, 20, 50].map((multiple) => spacing * multiple);
  widthSelect.innerHTML = choices.map((ticks) => {
    const pct = ((Math.pow(1.0001, ticks) - 1) * 100).toFixed(2);
    return `<option value="${ticks}">±${ticks.toLocaleString()} ticks (about ±${pct}%)</option>`;
  }).join('');
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
}).catch((error) => {
  poolSelect.innerHTML = `<option value="">${esc(error.message)}</option>`;
});

document.getElementById('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const error = document.getElementById('setup-error');
  error.textContent = 'Fresh preflight and command paths are unavailable. No position was submitted.';
  error.hidden = false;
});
