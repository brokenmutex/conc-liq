// This page is an in-memory UX fixture. It never calls a deployment API.
const $ = (selector) => document.querySelector(selector);
const state = {
  step: 'research', pool: 'NVDA', window: '1h', strategy: 'static', mode: 'paper',
  capital: 250, lower: 80, upper: 120, previewReady: false, position: null,
};
const strategyText = {
  static: 'Static / manual holds the chosen range until you request a change or close.',
  rangekeeper: 'RangeKeeper monitors the configured range and can propose a guarded recenter after a sustained exit.',
};
const money = (value) => `${new Intl.NumberFormat('en-US', {maximumFractionDigits: 0}).format(value)} USDG`;

function show(step) {
  if (state.position && step !== 'position') step = 'position';
  if (step === 'preview' && !state.previewReady) step = 'setup';
  if (step === 'position' && !state.position) step = 'research';
  state.step = step;
  for (const section of document.querySelectorAll('.screen')) section.hidden = section.id !== step;
  for (const button of document.querySelectorAll('[data-step]')) {
    button.setAttribute('aria-current', button.dataset.step === step ? 'step' : 'false');
    button.disabled = state.position ? button.dataset.step !== 'position' : button.dataset.step === 'position';
  }
  if (step === 'research') renderResearch();
  if (step === 'setup') renderSetup();
  if (step === 'preview') renderPreview();
  if (step === 'position') renderPosition();
}

function renderResearch() {
  for (const button of document.querySelectorAll('[data-pool]'))
    button.setAttribute('aria-pressed', String(button.dataset.pool === state.pool));
  for (const button of document.querySelectorAll('[data-window]'))
    button.setAttribute('aria-pressed', String(button.dataset.window === state.window));
  $('#research-selection').textContent = `Selected ${state.pool} / USDG · ${state.window} window. All pool metrics are demo placeholders.`;
}

function renderSetup() {
  $('#pool').value = state.pool;
  $('#capital').value = String(state.capital);
  $('#lower').value = String(state.lower);
  $('#upper').value = String(state.upper);
  $('#strategy').value = state.strategy;
  $('#mode').value = state.mode;
  $('#strategy-description').textContent = strategyText[state.strategy];
  $('#form-error').hidden = true;
}

function fact(label, value) {
  const item = document.createElement('div');
  item.className = 'preview-fact';
  const name = document.createElement('span'); name.textContent = label;
  const body = document.createElement('strong'); body.textContent = value;
  item.append(name, body);
  return item;
}

function renderPreview() {
  $('#preview-facts').replaceChildren(
    fact('Pool', `${state.pool} / USDG`),
    fact('Research window', `${state.window} · demo`),
    fact('Capital requested', money(state.capital)),
    fact('Range requested', `${state.lower}–${state.upper} USDG`),
    fact('Strategy', state.strategy === 'static' ? 'Static / manual' : 'RangeKeeper'),
    fact('Mode', state.mode === 'paper' ? 'Paper demo' : 'Live preview only'),
  );
  $('#preview-open').hidden = state.mode === 'live';
  $('#live-note').hidden = state.mode !== 'live';
}

function addEvent(label, kind) {
  state.position.events.push({label, kind, at: new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})});
}

function renderPosition() {
  const position = state.position;
  if (!position) return;
  $('#position-title').textContent = `${state.pool} / USDG`;
  $('#position-subtitle').textContent = `${state.strategy === 'static' ? 'Static / manual' : 'RangeKeeper'} · paper demo · browser memory only`;
  $('#position-status').textContent = position.phase === 'closed' ? 'Closed · demo' :
    position.phase === 'paused' ? 'Management paused · demo' : 'Active · demo';
  $('#position-capital').textContent = money(state.capital);
  $('#position-range').textContent = `${state.lower}–${state.upper} USDG`;
  $('#pause-button').disabled = position.phase === 'closed';
  $('#pause-button').textContent = position.phase === 'paused' ? 'Resume management' : 'Pause management';
  $('#close-retain').disabled = position.phase === 'closed';
  $('#close-convert').disabled = position.phase === 'closed';
  $('#control-note').textContent = position.phase === 'closed' ?
    `Demo closure: ${position.ending}. Token balances and proceeds are unavailable.` :
    'Controls change only this browser-memory walkthrough. No paper or live operation is submitted.';
  const chart = $('#lifecycle-chart');
  const activity = $('#activity');
  chart.replaceChildren(); activity.replaceChildren();
  for (const event of position.events) {
    const column = document.createElement('div'); column.className = 'event-column';
    const bar = document.createElement('i'); bar.className = event.kind;
    const label = document.createElement('small'); label.textContent = event.label;
    column.append(bar, label); chart.append(column);
    const row = document.createElement('li');
    const description = document.createElement('span'); description.textContent = `${event.label} · demo`;
    const time = document.createElement('time'); time.textContent = event.at;
    row.append(description, time); activity.append(row);
  }
}

for (const button of document.querySelectorAll('[data-step]'))
  button.addEventListener('click', () => show(button.dataset.step));
for (const button of document.querySelectorAll('[data-window]'))
  button.addEventListener('click', () => {state.window = button.dataset.window; state.previewReady = false; renderResearch();});
for (const button of document.querySelectorAll('[data-pool]'))
  button.addEventListener('click', () => {state.pool = button.dataset.pool; state.previewReady = false; renderResearch();});
$('#research-next').addEventListener('click', () => show('setup'));
$('#setup-back').addEventListener('click', () => show('research'));
$('#preview-back').addEventListener('click', () => show('setup'));
$('#strategy').addEventListener('change', () => {
  $('#strategy-description').textContent = strategyText[$('#strategy').value];
});
$('#setup-form').addEventListener('input', () => {state.previewReady = false;});
$('#setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const capital = Number($('#capital').value), lower = Number($('#lower').value), upper = Number($('#upper').value);
  const error = $('#form-error');
  if (!Number.isFinite(capital) || capital < 1 || capital > 10000 ||
      !Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || lower >= upper) {
    error.textContent = 'Enter capital from 1 to 10,000 USDG and an upper price above a positive lower price.';
    error.hidden = false;
    return;
  }
  state.pool = $('#pool').value;
  state.capital = capital; state.lower = lower; state.upper = upper;
  state.strategy = $('#strategy').value; state.mode = $('#mode').value;
  state.previewReady = true; error.hidden = true;
  show('preview');
});
$('#preview-open').addEventListener('click', () => {
  if (state.mode !== 'paper' || !state.previewReady) return;
  state.position = {phase: 'active', ending: null, events: []};
  addEvent('Opened', 'open'); show('position');
});
$('#pause-button').addEventListener('click', () => {
  if (!state.position || state.position.phase === 'closed') return;
  state.position.phase = state.position.phase === 'paused' ? 'active' : 'paused';
  addEvent(state.position.phase === 'paused' ? 'Paused' : 'Resumed', state.position.phase === 'paused' ? 'pause' : 'open');
  renderPosition();
});
function close(ending) {
  if (!state.position || state.position.phase === 'closed') return;
  state.position.phase = 'closed'; state.position.ending = ending;
  addEvent(ending === 'retain tokens' ? 'Closed · retain' : 'Closed · convert', 'close');
  renderPosition();
}
$('#close-retain').addEventListener('click', () => close('retain tokens'));
$('#close-convert').addEventListener('click', () => close('convert to USDG'));
$('#start-over').addEventListener('click', () => {
  state.position = null; state.previewReady = false; show('research');
});
show('research');
