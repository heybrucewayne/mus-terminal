export const BACKUP_KEYS = [
  'cc_custom', 'cc_hidden_assets', 'cc_market_order_v1', 'mus_theme_v1',
  'mus_last_background_v1', 'mus_panel_visibility_v1', 'mus_panel_frames_v1',
  'mus_panel_layout_v1', 'mus_tradingview_panel_symbol_v1',
  'mus_alerts_v2', 'mus_saved_workspace_v2', 'mus_workspace_v2'
];

export function numberOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function filterMarkets(rows, filter = 'all', query = '') {
  const needle = String(query).trim().toLowerCase();
  return rows.filter(row => (filter === 'all' || (filter === 'crypto' ? row.kind === 'crypto' : row.kind !== 'crypto'))
    && [row.name, row.sub, row.id].some(value => String(value || '').toLowerCase().includes(needle)));
}

export function normalizeAlerts(input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set();
  return input.slice(0, 100).filter(alert => {
    if (!alert || typeof alert.id !== 'string' || !alert.id || alert.id.length > 100 || ids.has(alert.id)) return false;
    if (typeof alert.assetId !== 'string' || !alert.assetId || alert.assetId.length > 80) return false;
    if (!['above', 'below'].includes(alert.direction) || !(numberOrNull(alert.target) > 0)) return false;
    ids.add(alert.id);
    return true;
  }).map(alert => ({
    id: alert.id, assetId: alert.assetId, name: String(alert.name || alert.assetId).slice(0, 80),
    target: Number(alert.target), direction: alert.direction,
    createdAt: numberOrNull(alert.createdAt) || 0,
    triggeredAt: numberOrNull(alert.triggeredAt) || null
  }));
}

// Alerts need a quote fetched in this session. A restored cache is never evidence.
export function evaluateAlerts(alerts, rows, now = Date.now(), sessionStarted = 0) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return alerts.filter(alert => {
    if (alert.triggeredAt) return false;
    const row = byId.get(alert.assetId);
    const price = numberOrNull(row?.price);
    const at = numberOrNull(row?.quotedAt);
    if (price === null || price <= 0 || at === null || at < sessionStarted || at > now + 1000 || now - at > 90_000) return false;
    return alert.direction === 'above' ? price >= alert.target : price <= alert.target;
  });
}

export function validateBackup(input) {
  if (!input || input.app !== 'mus-terminal' || input.version !== 2 || !input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
    throw new Error('Choose a MUS Terminal 2.0 backup.');
  }
  const settings = {};
  for (const key of BACKUP_KEYS) {
    const value = input.settings[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 100_000) throw new Error('Backup contains an invalid setting.');
    if (!['mus_theme_v1', 'mus_last_background_v1'].includes(key)) {
      try { JSON.parse(value); } catch { throw new Error('Backup contains invalid JSON.'); }
    }
    settings[key] = value;
  }
  if (settings.mus_theme_v1 && !['black', 'white', 'liquid-glass'].includes(settings.mus_theme_v1)) throw new Error('Unknown theme.');
  if (settings.mus_alerts_v2) settings.mus_alerts_v2 = JSON.stringify(normalizeAlerts(JSON.parse(settings.mus_alerts_v2)));
  if (settings.cc_custom && !Array.isArray(JSON.parse(settings.cc_custom))) throw new Error('Invalid watchlist.');
  return settings;
}
