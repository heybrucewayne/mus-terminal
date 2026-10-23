import { BACKUP_KEYS, filterMarkets, normalizeAlerts, evaluateAlerts, validateBackup } from './core.mjs';

const q = selector => document.querySelector(selector);
const escape = escapeHtml;
let markets = window.MusMarketSnapshot || [];
let marketFilter = 'all';
let marketQuery = '';
let alerts = normalizeAlerts(cacheGet('mus_alerts_v2'));
let commandItems = [];
let commandIndex = 0;
const presets = {
  overview: { title:'Market overview', panels:['panel-bubbles','panel-table','panel-trenches','panel-forecast'] },
  solana: { title:'Solana focus', panels:['panel-bubbles','panel-table','panel-trenches'] },
  charts: { title:'Chart desk', panels:['panel-table','panel-tradingview','panel-forecast'] }
};

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  q('#toastStack').append(node);
  while (q('#toastStack').children.length > 4) q('#toastStack').firstElementChild.remove();
  setTimeout(() => node.remove(), 7000);
}

function persistAlerts() {
  cacheSet('mus_alerts_v2', alerts);
  renderAlerts();
}

function openDialog(id) {
  closeAssetMenu();
  closePageContextMenu();
  document.querySelectorAll('.terminal-dialog[open]').forEach(dialog => dialog.close());
  const dialog = q('#' + id);
  if (!dialog.open) dialog.showModal();
}

document.querySelectorAll('.terminal-dialog').forEach(dialog => {
  dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
});

function money(row, value = row?.price) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const digits = row?.decimals ?? (Math.abs(value) < 1 ? 4 : 2);
  return `${row?.usd === false ? '' : '$'}${Number(value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})}${row?.suffix || ''}`;
}

function renderSummary() {
  const cards = [
    { id:'BTC', name:'Bitcoin', symbol:'₿', pair:'BTC / USDT' },
    { id:'ETH', name:'Ethereum', symbol:'Ξ', pair:'ETH / USDT' },
    { id:'SOL', name:'Solana', symbol:'◎', pair:'SOL / USDT' },
    { id:'GOLD', name:'Gold', symbol:'◈', pair:'XAU / USD' }
  ];
  q('#marketStrip').innerHTML = cards.map(card => {
    const row = markets.find(item => item.id === card.id);
    const valid = row?.price != null && Number.isFinite(row.price);
    const change = valid && Number.isFinite(row.chg) ? row.chg : null;
    return `<button class="market-card" type="button" data-summary-asset="${card.id}" aria-label="Open ${card.name} chart">
      <div class="market-card-top"><span class="market-card-name"><span class="market-card-symbol">${card.symbol}</span>${card.name}</span><span class="market-card-sub">${card.pair}</span></div>
      <div class="market-card-values"><strong class="market-card-price">${money(row)}</strong><span class="market-card-change ${change === null ? '' : change >= 0 ? 'pos' : 'neg'}">${change === null ? 'No quote' : (change >= 0 ? '↗ +' : '↘ ') + change.toFixed(2) + '%'}</span></div>
      <div class="market-card-range"><span>LOW <span>${money(row,row?.low)}</span></span><span>HIGH <span>${money(row,row?.high)}</span></span></div>
    </button>`;
  }).join('');
}

q('#marketStrip').addEventListener('click', event => {
  const button = event.target.closest('[data-summary-asset]');
  if (!button) return;
  const row = markets.find(item => item.id === button.dataset.summaryAsset);
  if (row) openAssetMenu(row, button);
  else toast('No quote received for this asset yet.');
});

window.MusFilterMarkets = rows => filterMarkets(rows, marketFilter, marketQuery);
document.querySelectorAll('[data-market-filter]').forEach(button => {
  button.addEventListener('click', () => {
    marketFilter = button.dataset.marketFilter;
    document.querySelectorAll('[data-market-filter]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    renderMarketTable();
  });
});
q('#watchlistSearch').addEventListener('input', event => {
  marketQuery = event.target.value;
  renderMarketTable();
});

function updateFeedState() {
  const feed = window.MusMarketFeed;
  const node = q('#feedState');
  let state = 'connecting';
  let label = 'Connecting to crypto feed';
  if (!navigator.onLine) { state = 'offline'; label = 'Offline · cached quotes'; }
  else if (document.hidden) { state = 'paused'; label = 'Updates paused'; }
  else if (feed?.state === 'error') { state = 'error'; label = 'Crypto feed unavailable'; }
  else if (feed?.at) {
    state = feed.stale || Date.now() - feed.at > 45_000 ? 'stale' : 'live';
    label = state === 'live' ? 'Crypto feed connected' : 'Crypto quotes are stale';
  }
  node.dataset.state = state;
  node.replaceChildren();
  node.append(document.createElement('i'), document.createTextNode(label));
  q('#feedUpdated').textContent = feed?.at ? `Last crypto quote ${new Date(feed.at).toLocaleTimeString('en-GB')}` : 'Waiting for first update';
  q('#terminalClock').textContent = new Date().toLocaleTimeString('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',second:'2-digit'}) + ' UTC';
}
window.addEventListener('mus:feed', updateFeedState);
window.addEventListener('online', () => { updateFeedState(); fetchTickers(); });
window.addEventListener('offline', updateFeedState);
document.addEventListener('visibilitychange', updateFeedState);
setInterval(updateFeedState, 1000);

function renderAlertOptions() {
  const select = q('#alertAsset');
  const selected = select.value;
  const rows = markets.filter(row => row.price > 0 && row.cls !== 'ECONOMIC');
  const signature = rows.map(row => row.id + ':' + row.name).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.innerHTML = rows.length ? rows.map(row => `<option value="${escape(row.id)}">${escape(row.name)}${row.suffix ? ' · ' + escape(row.suffix) : row.usd === false ? '' : ' · USD/USDT'}</option>`).join('') : '<option value="">Waiting for market quotes…</option>';
    if (rows.some(row => row.id === selected)) select.value = selected;
  }
  q('#alertForm button[type="submit"]').disabled = !rows.length;
  q('#alertTarget').placeholder = String(rows.find(row => row.id === select.value)?.price || '0.00');
}

function renderAlerts() {
  q('#alertCount').textContent = alerts.filter(alert => !alert.triggeredAt).length;
  q('#alertList').innerHTML = alerts.length ? alerts.map(alert => {
    const row = markets.find(item => item.id === alert.assetId);
    return `<div class="alert-row ${alert.triggeredAt ? 'triggered' : ''}"><div><strong>${escape(alert.name)} ${alert.direction === 'above' ? '≥' : '≤'} ${escape(money(row || {usd:false},alert.target))}</strong><p>${alert.triggeredAt ? 'Triggered · ' + escape(new Date(alert.triggeredAt).toLocaleString()) : 'Active · waiting for a fresh quote'}</p></div><button type="button" data-delete-alert="${escape(alert.id)}" aria-label="Delete ${escape(alert.name)} alert">×</button></div>`;
  }).join('') : '<div class="empty-state">No alerts yet. Set a level and keep the market in view.</div>';
}

q('#alertsOpen').addEventListener('click', () => {
  renderAlertOptions();
  renderAlerts();
  openDialog('alertsDialog');
});
q('#alertAsset').addEventListener('change', renderAlertOptions);
q('#alertForm').addEventListener('submit', event => {
  event.preventDefault();
  const row = markets.find(item => item.id === q('#alertAsset').value);
  const target = Number(q('#alertTarget').value);
  const direction = q('#alertDirection').value;
  const status = q('#alertFormStatus');
  if (!row || !Number.isFinite(target) || target <= 0) { status.textContent = 'Choose an asset and a positive target price.'; return; }
  if (alerts.length >= 100) { status.textContent = 'Remove an old alert before creating another.'; return; }
  if (alerts.some(alert => !alert.triggeredAt && alert.assetId === row.id && alert.target === target && alert.direction === direction)) { status.textContent = 'This alert is already active.'; return; }
  alerts.unshift({ id:crypto.randomUUID(), assetId:row.id, name:row.name, target, direction, createdAt:Date.now(), triggeredAt:null });
  persistAlerts();
  q('#alertTarget').value = '';
  status.textContent = 'Alert saved. It will be checked with the next fresh quote.';
});
q('#alertList').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-alert]');
  if (!button) return;
  alerts = alerts.filter(alert => alert.id !== button.dataset.deleteAlert);
  persistAlerts();
});

window.addEventListener('mus:markets', event => {
  markets = event.detail;
  q('#watchlistCount').textContent = markets.length;
  renderSummary();
  renderAlertOptions();
  const triggered = evaluateAlerts(alerts, markets, Date.now(), window.MusSessionStarted || Date.now());
  if (triggered.length) {
    const ids = new Set(triggered.map(alert => alert.id));
    alerts = alerts.map(alert => ids.has(alert.id) ? {...alert,triggeredAt:Date.now()} : alert);
    persistAlerts();
    triggered.forEach(alert => toast(`${alert.name} reached your ${alert.direction === 'above' ? 'upper' : 'lower'} level: ${money(markets.find(row => row.id === alert.assetId),alert.target)}`));
  }
});

function workspaceLabel(value) {
  q('#workspaceTitle').replaceChildren(document.createTextNode(value), Object.assign(document.createElement('span'),{textContent:'.'}));
}

function applyWorkspace(id) {
  let panelIds;
  if (id === 'saved') {
    const saved = cacheGet('mus_saved_workspace_v2');
    if (!Array.isArray(saved?.panels)) { toast('Save a layout first.'); return; }
    panelIds = saved.panels.filter(panel => PANEL_DEFS.some(def => def.id === panel)).slice(0,4);
    if (!panelIds.length) return;
    if (saved.frames && typeof saved.frames === 'object' && !Array.isArray(saved.frames)) {
      const frames = {};
      for (const [signature,group] of Object.entries(saved.frames)) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
        frames[signature] = {};
        for (const [panel,frame] of Object.entries(group)) {
          if (PANEL_DEFS.some(def => def.id === panel) && frame && typeof frame === 'object') frames[signature][panel] = clampPanelFrame(frame);
        }
      }
      panelFrameStore = frames;
      cacheSet(PANEL_FRAMES_KEY, frames);
    }
  } else panelIds = presets[id]?.panels;
  if (!panelIds) return;
  PANEL_DEFS.forEach(panel => { panelVisibility[panel.id] = panelIds.includes(panel.id); });
  activePanelFrameSignature = '';
  savePanelVisibility();
  updatePanelLayout();
  renderPanelManager();
  if (id !== 'saved') restoreDefaultPanelFrames(visiblePanelDefs());
  workspaceLabel(id === 'saved' ? 'Your workspace' : presets[id].title);
  cacheSet('mus_workspace_v2',id);
  if (panelVisibility['panel-trenches']) loadTrenches(false);
  if (panelVisibility['panel-forecast']) loadForecast(false);
}

function showSavedWorkspace() {
  if (cacheGet('mus_saved_workspace_v2') && !q('#workspaceSelect option[value="saved"]')) q('#workspaceSelect').add(new Option('Saved layout','saved'));
}
showSavedWorkspace();
const initialWorkspace = cacheGet('mus_workspace_v2');
if (initialWorkspace === 'saved' || presets[initialWorkspace]) {
  q('#workspaceSelect').value = initialWorkspace;
  workspaceLabel(initialWorkspace === 'saved' ? 'Your workspace' : presets[initialWorkspace].title);
}
q('#workspaceSelect').addEventListener('change', event => applyWorkspace(event.target.value));
q('#workspaceSave').addEventListener('click', () => {
  savePanelFrames();
  cacheSet('mus_saved_workspace_v2',{panels:visiblePanelDefs().map(panel => panel.id),frames:panelFrameStore});
  cacheSet('mus_workspace_v2','saved');
  showSavedWorkspace();
  q('#workspaceSelect').value = 'saved';
  workspaceLabel('Your workspace');
  toast('Your panel layout is saved.');
});

function renderSettings() {
  q('#settingsThemes').innerHTML = window.MusTerminalTheme.list().map(theme => `<button type="button" class="tool-button" data-setting-theme="${theme}" aria-pressed="${window.MusTerminalTheme.current() === theme}">${theme === 'black' ? 'Midnight' : theme === 'white' ? 'Daylight' : 'Liquid glass'}</button>`).join('');
  q('#settingsPanels').innerHTML = PANEL_DEFS.map(panel => {
    const visible = panelVisibility[panel.id];
    const disabled = visible ? visiblePanelDefs().length <= 1 : visiblePanelDefs().length >= MAX_VISIBLE_PANELS;
    return `<button type="button" class="setting-panel" data-setting-panel="${panel.id}" aria-pressed="${visible}" ${disabled ? 'disabled' : ''}><span>${escape(panel.label)}</span><span>${visible ? 'ON' : 'OFF'}</span></button>`;
  }).join('');
}
q('#settingsOpen').addEventListener('click', () => { renderSettings(); openDialog('settingsDialog'); });
q('#settingsThemes').addEventListener('click', event => {
  const button = event.target.closest('[data-setting-theme]');
  if (!button) return;
  window.MusTerminalTheme.select(button.dataset.settingTheme);
  syncThemePicker();
  renderSettings();
});
q('#themeCycle').addEventListener('click', () => {
  const themes = ['black','white','liquid-glass'];
  window.MusTerminalTheme.select(themes[(themes.indexOf(window.MusTerminalTheme.current()) + 1) % themes.length]);
  syncThemePicker();
});
q('#settingsPanels').addEventListener('click', event => {
  const button = event.target.closest('[data-setting-panel]');
  if (!button) return;
  togglePanel(button.dataset.settingPanel);
  renderSettings();
  if (panelVisibility[button.dataset.settingPanel]) {
    if (button.dataset.settingPanel === 'panel-trenches') loadTrenches(false);
    if (button.dataset.settingPanel === 'panel-forecast') loadForecast(false);
  }
});
q('#resetLayout').addEventListener('click', () => { restoreDefaultPanelFrames(visiblePanelDefs()); toast('Panel positions reset.'); });

q('#refreshMarkets').addEventListener('click', async () => {
  const button = q('#refreshMarkets');
  button.disabled = true;
  button.setAttribute('aria-busy','true');
  try {
    const result = await Promise.allSettled([fetchTickers(),fetchHype(),fetchTradFi(),fetchCustomCoinGecko(),fetchCustomForex()]);
    toast(result[0].status === 'fulfilled' && result[0].value ? 'Market refresh complete.' : 'Live crypto refresh failed. Last available quotes are kept.');
  } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
});

function renderCommands() {
  const query = q('#commandInput').value.trim().toLowerCase();
  const actions = [
    { name:'Open price alerts',hint:'ACTION',run:() => q('#alertsOpen').click() },
    { name:'Workspace settings',hint:'ACTION',run:() => q('#settingsOpen').click() },
    { name:'Refresh markets',hint:'ACTION',run:() => q('#refreshMarkets').click() },
    { name:'Switch theme',hint:'APPEARANCE',run:() => q('#themeCycle').click() },
    ...Object.entries(presets).map(([id,preset]) => ({name:preset.title,hint:'WORKSPACE',run:() => {q('#workspaceSelect').value=id;applyWorkspace(id);}}))
  ];
  commandItems = [
    ...markets.filter(row => [row.name,row.sub,row.id].some(value => String(value || '').toLowerCase().includes(query))).map(row => ({name:row.name,hint:money(row),run:() => openAssetMenu(row,q('#commandOpen'))})),
    ...actions.filter(action => action.name.toLowerCase().includes(query))
  ].slice(0,12);
  if (query && !markets.some(row => row.name.toLowerCase() === query)) commandItems.push({name:`Add ${query.toUpperCase()} to watchlist`,hint:'ADD ASSET',run:() => {q('#px-q').value=query;addCustom();}});
  commandIndex = Math.min(commandIndex, Math.max(0,commandItems.length - 1));
  q('#commandResults').innerHTML = commandItems.map((item,index) => `<button type="button" id="command-item-${index}" class="command-result" role="option" data-command-index="${index}" aria-selected="${index === commandIndex}"><span>${escape(item.name)}</span><small>${escape(item.hint)}</small></button>`).join('') || '<div class="empty-state">No matching actions.</div>';
  q('#commandInput').setAttribute('aria-activedescendant',`command-item-${commandIndex}`);
}
function runCommand(index) {
  const action = commandItems[index];
  if (!action) return;
  q('#commandDialog').close();
  action.run();
}
q('#commandInput').setAttribute('role','combobox');
q('#commandInput').setAttribute('aria-controls','commandResults');
q('#commandInput').setAttribute('aria-autocomplete','list');
q('#commandInput').setAttribute('aria-expanded','true');
q('#commandResults').setAttribute('role','listbox');
q('#commandResults').setAttribute('aria-label','Assets and commands');
q('#commandOpen').addEventListener('click', () => {
  q('#commandInput').value = '';
  commandIndex = 0;
  renderCommands();
  openDialog('commandDialog');
  q('#commandInput').focus();
});
q('#commandInput').addEventListener('input', () => { commandIndex = 0; renderCommands(); });
q('#commandInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); runCommand(commandIndex); }
  if (['ArrowDown','ArrowUp'].includes(event.key) && commandItems.length) {
    event.preventDefault();
    commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandItems.length) % commandItems.length;
    renderCommands();
    q(`#command-item-${commandIndex}`)?.scrollIntoView({block:'nearest'});
  }
});
q('#commandResults').addEventListener('click', event => {
  const button = event.target.closest('[data-command-index]');
  if (button) runCommand(Number(button.dataset.commandIndex));
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); q('#commandOpen').click(); }
});

q('#exportWorkspace').addEventListener('click', () => {
  try {
    const settings = Object.fromEntries(BACKUP_KEYS.map(key => [key,localStorage.getItem(key)]).filter(([,value]) => value !== null));
    const blob = new Blob([JSON.stringify({app:'mus-terminal',version:2,exportedAt:new Date().toISOString(),settings},null,2)],{type:'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `mus-terminal-backup-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    q('#backupStatus').textContent = 'Backup exported.';
  } catch { q('#backupStatus').textContent = 'Browser storage is unavailable. Backup could not be exported.'; }
});
q('#importWorkspace').addEventListener('click', () => q('#importFile').click());
q('#importFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const status = q('#backupStatus');
  try {
    if (file.size > 1_000_000) throw new Error('Backup must be smaller than 1 MB.');
    const settings = validateBackup(JSON.parse(await file.text()));
    const previous = Object.fromEntries(BACKUP_KEYS.map(key => [key,localStorage.getItem(key)]));
    try {
      BACKUP_KEYS.forEach(key => settings[key] === undefined ? localStorage.removeItem(key) : localStorage.setItem(key,settings[key]));
    } catch (error) {
      BACKUP_KEYS.forEach(key => { try { previous[key] === null ? localStorage.removeItem(key) : localStorage.setItem(key,previous[key]); } catch {} });
      throw error;
    }
    status.textContent = 'Backup restored. Reloading workspace…';
    setTimeout(() => location.reload(), 500);
  } catch (error) { status.textContent = error instanceof SyntaxError ? 'This file is not a valid JSON backup.' : error.message || 'Backup could not be restored.'; }
  event.target.value = '';
});

// Keep saved alert state in sync between tabs.
window.addEventListener('storage', event => {
  if (event.key === 'mus_alerts_v2') { alerts = normalizeAlerts(cacheGet('mus_alerts_v2')); renderAlerts(); }
});

renderSummary();
renderAlerts();
renderAlertOptions();
updateFeedState();
renderAll();
