const CACHE_MS = 15 * 60 * 1000;
const CYCLE_CACHE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 9000;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const BINANCE_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DERIBIT_BASE = 'https://www.deribit.com/api/v2/public';
const DAY_MS = 24 * 60 * 60 * 1000;

const ASSETS = {
  BTC: { name: 'Bitcoin', symbol: 'BTCUSDT', coinId: 'bitcoin' },
  SOL: { name: 'Solana', symbol: 'SOLUSDT', coinId: 'solana' },
  ETH: { name: 'Ethereum', symbol: 'ETHUSDT', coinId: 'ethereum' }
};

let runtimeCache = { updatedAt: 0, payload: null };
let cycleCache = { updatedAt: 0, value: null };

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function fetchJson(url, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'MUS-Terminal/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function jsonValue(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

function eventList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

async function safeJson(url, timeout = REQUEST_TIMEOUT_MS) {
  try {
    return { ok: true, value: await fetchJson(url, timeout) };
  } catch (error) {
    return { ok: false, value: null, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || 'request failed') };
  }
}

function monthName(date) {
  return date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
}

function eventText(event) {
  return `${event?.title || ''} ${event?.slug || ''} ${event?.description || ''}`.toLowerCase();
}

function isAssetEvent(event, asset) {
  const text = eventText(event);
  return text.includes(asset.name.toLowerCase()) || text.includes(asset.symbol.slice(0, -4).toLowerCase());
}

function eventEnd(event) {
  const value = Date.parse(event?.endDate || event?.endDateIso || '');
  return Number.isFinite(value) ? value : null;
}

function chooseEvent(events, asset, horizon, now) {
  const target = new Date(now);
  const currentMonth = monthName(target);
  const day = target.getUTCDate();
  const year = target.getUTCFullYear();
  const nextYear = year + 1;
  const candidates = events.filter(event => isAssetEvent(event, asset));
  if (!candidates.length) return null;

  const scored = candidates.map(event => {
    const text = eventText(event);
    const end = eventEnd(event);
    let score = 0;
    if (event?.closed === true || event?.active === false) score -= 1000;
    if (end !== null && end < now - 2 * 60 * 60 * 1000) score -= 500;
    if (horizon === 'YE') {
      if (text.includes(String(year)) || text.includes(String(nextYear))) score += 180;
      if (end !== null && new Date(end).getUTCFullYear() === nextYear) score += 180;
      if (text.includes('year') || text.includes('before')) score += 40;
    } else if (horizon === '1M') {
      if (text.includes(currentMonth)) score += 220;
      if (end !== null && new Date(end).getUTCMonth() === target.getUTCMonth()) score += 120;
      if (text.includes('month')) score += 30;
    } else {
      if (text.includes(currentMonth)) score += 80;
      if (new RegExp(`\\b${currentMonth}\\s+${day}\\b`).test(text)) score += 240;
      if (text.includes('today')) score += 170;
      if (end !== null) score -= Math.min(100, Math.abs(end - now) / DAY_MS * 8);
    }
    if (text.includes('price')) score += 20;
    return { event, score, end };
  }).sort((a, b) => b.score - a.score || (a.end || Infinity) - (b.end || Infinity));
  return scored[0]?.event || null;
}

async function hydrateEvent(event) {
  if (!event?.slug) return null;
  if (Array.isArray(event.markets) && event.markets.length) return event;
  const result = await safeJson(`${GAMMA_BASE}/events/slug/${encodeURIComponent(event.slug)}`);
  return result.ok ? result.value : null;
}

async function loadPolymarketEvents(now) {
  const year = new Date(now).getUTCFullYear();
  const listResult = await safeJson(`${GAMMA_BASE}/events?active=true&closed=false&archived=false&limit=200&tag_slug=crypto`, 12000);
  const listed = eventList(listResult.value);
  const all = [...listed];

  for (const asset of Object.values(ASSETS)) {
    const yearlySlug = `what-price-will-${asset.name.toLowerCase()}-hit-before-${year + 1}`;
    const direct = await safeJson(`${GAMMA_BASE}/events/slug/${encodeURIComponent(yearlySlug)}`, 10000);
    if (direct.ok) all.push(direct.value);
  }

  const unique = [...new Map(all.filter(Boolean).map(event => [event.slug || event.id, event])).values()];
  const result = {};
  for (const [symbol, asset] of Object.entries(ASSETS)) {
    const directYearly = unique.find(event => event?.slug === `what-price-will-${asset.name.toLowerCase()}-hit-before-${year + 1}`);
    const selected = {
      '1D': chooseEvent(unique, asset, '1D', now),
      '1M': chooseEvent(unique, asset, '1M', now),
      YE: directYearly || chooseEvent(unique, asset, 'YE', now)
    };
    result[symbol] = {};
    for (const horizon of Object.keys(selected)) {
      result[symbol][horizon] = await hydrateEvent(selected[horizon]);
    }
  }
  return result;
}

function parseThreshold(market) {
  const group = String(market?.groupItemTitle || '');
  const question = String(market?.question || '');
  const text = group || question;
  const matches = [...text.matchAll(/(?:\$|USD\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*([KMB]))?/gi)]
    .map(match => {
      const base = Number(String(match[1]).replace(/,/g, ''));
      const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] || '').toUpperCase()] || 1;
      return base * multiplier;
    })
    .filter(value => Number.isFinite(value) && value >= 10 && ![2025, 2026, 2027, 2028].includes(value));
  if (!matches.length) return null;
  return group ? matches[0] : Math.max(...matches);
}

function parseDirection(market, threshold, spot) {
  const text = `${market?.groupItemTitle || ''} ${market?.question || ''}`.toLowerCase();
  if (text.includes('↑') || /reach|above|over|hit/.test(text)) return 'up';
  if (text.includes('↓') || /below|under|dip|drop|fall/.test(text)) return 'down';
  return threshold >= spot ? 'up' : 'down';
}

function horizonPriceBounds(spot, horizon) {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const factors = {
    '1D': [0.65, 1.45],
    '1M': [0.35, 2.75],
    YE: [0.08, 8]
  }[horizon] || [0.08, 8];
  return { min: spot * factors[0], max: spot * factors[1] };
}

function parseLevels(event, spot, horizon) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const bounds = horizonPriceBounds(spot, horizon);
  return markets.map(market => {
    const outcomes = jsonValue(market.outcomes);
    const prices = jsonValue(market.outcomePrices);
    const yesIndex = outcomes.findIndex(outcome => String(outcome).toLowerCase() === 'yes');
    const yes = number(prices[yesIndex >= 0 ? yesIndex : 0]);
    const threshold = parseThreshold(market);
    if (yes === null || threshold === null || yes <= 0 || threshold <= 0) return null;
    if (bounds && (threshold < bounds.min || threshold > bounds.max)) return null;
    return { threshold, yes: clamp(yes, 0, 1), direction: parseDirection(market, threshold, spot) };
  }).filter(Boolean);
}

function weightedQuantile(points, quantile) {
  if (!points.length) return null;
  const total = points.reduce((sum, point) => sum + point.weight, 0);
  if (!total) return null;
  let cumulative = 0;
  for (const point of [...points].sort((a, b) => a.value - b.value)) {
    cumulative += point.weight / total;
    if (cumulative >= quantile) return point.value;
  }
  return points[points.length - 1].value;
}

function normalizeLevels(levels) {
  const total = levels.reduce((sum, level) => sum + level.yes, 0);
  if (!total) return [];
  return levels.map(level => ({ ...level, probability: level.yes / total }));
}

function rangeFromLevels(levels, spot, horizon, marketData) {
  const normalized = normalizeLevels(levels);
  const bounds = horizonPriceBounds(spot, horizon);
  if (!normalized.length || !bounds) return null;
  const points = normalized.map(level => ({ value: level.threshold, weight: level.probability }));
  const low = weightedQuantile(points, 0.18);
  const high = weightedQuantile(points, 0.82);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const volatility = Number.isFinite(marketData?.dailyVolatility) ? marketData.dailyVolatility : 0.025;
  const paddingRatio = horizon === '1D'
    ? Math.min(0.12, Math.max(0.004, volatility * 0.35))
    : horizon === '1M'
      ? Math.min(0.32, Math.max(0.012, volatility * 1.2))
      : Math.min(0.90, Math.max(0.025, volatility * 2.8));
  const padding = spot * paddingRatio;
  const polyMid = normalized.reduce((sum, level) => sum + level.threshold * level.probability, 0);
  return {
    low: clamp(Math.min(spot, low) - padding, bounds.min, spot),
    high: clamp(Math.max(spot, high) + padding, spot, bounds.max),
    normalizedCount: normalized.length,
    polyMid: clamp(polyMid, bounds.min, bounds.max),
    coverage: 0.64
  };
}

function fallbackRange(spot, horizon, marketData) {
  const volatility = Number.isFinite(marketData?.dailyVolatility) ? marketData.dailyVolatility : 0.035;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const factor = horizon === '1D' ? 2 : horizon === '1M' ? Math.sqrt(21) * 2 : Math.sqrt(120) * 2;
  const band = clamp(volatility * factor, horizon === '1D' ? 0.02 : horizon === '1M' ? 0.08 : 0.18, horizon === '1D' ? 0.12 : horizon === '1M' ? 0.45 : 1.5);
  return { low: Math.max(0, spot * (1 - band)), high: spot * (1 + band), normalizedCount: 0, polyMid: null, coverage: null };
}

async function loadMarketData(asset) {
  const tickerResult = await safeJson(`${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${asset.symbol}`);
  const ticker = tickerResult.ok ? tickerResult.value : null;
  const klinesResult = await safeJson(`${BINANCE_BASE}/api/v3/klines?symbol=${asset.symbol}&interval=1d&limit=90`, 10000);
  const closes = Array.isArray(klinesResult.value) ? klinesResult.value.map(row => number(row?.[4])).filter(value => value > 0) : [];
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index])).filter(Number.isFinite);
  const meanReturn = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  const dailyVolatility = returns.length > 1
    ? Math.sqrt(returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (returns.length - 1))
    : null;
  const recentAverage = closes.length ? closes.slice(-20).reduce((sum, value) => sum + value, 0) / Math.min(20, closes.length) : null;
  const price = number(ticker?.lastPrice) || closes.at(-1) || null;
  const momentum = number(ticker?.priceChangePercent) || 0;
  const trend = price && recentAverage ? (price - recentAverage) / recentAverage : 0;
  const derivatives = await loadDerivatives(asset);
  const momentumBias = clamp(momentum / 6, -1, 1);
  const trendBias = clamp(trend / 0.12, -1, 1);
  const fundingBias = derivatives.funding === null ? 0 : clamp(derivatives.funding / 0.001, -1, 1);
  const optionsBias = derivatives.putCallRatio === null ? 0 : clamp((1 - derivatives.putCallRatio) / 0.8, -1, 1);
  return {
    price,
    momentum,
    high: number(ticker?.highPrice),
    low: number(ticker?.lowPrice),
    dailyVolatility,
    marketBias: clamp(momentumBias * 0.48 + fundingBias * 0.22 + optionsBias * 0.18 + derivatives.liquidationBias * 0.12, -1, 1),
    technicalBias: clamp(trendBias * 0.75 + momentumBias * 0.25, -1, 1),
    ...derivatives,
    available: Boolean(price)
  };
}

async function loadDerivatives(asset) {
  const [fundingResult, openInterestResult, liquidationResult] = await Promise.all([
    safeJson(`${FUTURES_BASE}/fapi/v1/premiumIndex?symbol=${asset.symbol}`, 7000),
    safeJson(`${FUTURES_BASE}/fapi/v1/openInterest?symbol=${asset.symbol}`, 7000),
    safeJson(`${FUTURES_BASE}/fapi/v1/allForceOrders?symbol=${asset.symbol}&limit=100`, 7000)
  ]);
  let putCallRatio = null;
  let optionsAvailable = false;
  if (asset.coinId === 'bitcoin' || asset.coinId === 'ethereum') {
    const optionsResult = await safeJson(`${DERIBIT_BASE}/get_book_summary_by_currency?currency=${asset.coinId === 'bitcoin' ? 'BTC' : 'ETH'}&kind=option&expired=false`, 8000);
    optionsAvailable = optionsResult.ok;
    const instruments = Array.isArray(optionsResult.value?.result) ? optionsResult.value.result : [];
    let puts = 0;
    let calls = 0;
    instruments.forEach(instrument => {
      const openInterest = number(instrument?.open_interest) || 0;
      if (String(instrument?.instrument_name || '').endsWith('-P')) puts += openInterest;
      if (String(instrument?.instrument_name || '').endsWith('-C')) calls += openInterest;
    });
    if (calls > 0) putCallRatio = puts / calls;
  }
  const orders = Array.isArray(liquidationResult.value) ? liquidationResult.value : [];
  let longLiquidations = 0;
  let shortLiquidations = 0;
  orders.forEach(order => {
    const notional = (number(order?.origQty) || 0) * (number(order?.price) || 0);
    if (String(order?.side || '').toUpperCase() === 'SELL') longLiquidations += notional;
    if (String(order?.side || '').toUpperCase() === 'BUY') shortLiquidations += notional;
  });
  const liquidationTotal = longLiquidations + shortLiquidations;
  return {
    funding: fundingResult.ok ? number(fundingResult.value?.lastFundingRate) : null,
    openInterest: openInterestResult.ok ? number(openInterestResult.value?.openInterest) : null,
    putCallRatio,
    longLiquidations,
    shortLiquidations,
    liquidationBias: liquidationTotal > 0 ? clamp((shortLiquidations - longLiquidations) / liquidationTotal, -1, 1) : 0,
    derivativesAvailable: Boolean(fundingResult.ok || openInterestResult.ok || optionsAvailable || liquidationResult.ok)
  };
}

async function loadMacroData() {
  const symbols = { dxy: 'DX-Y.NYB', nasdaq: '^NDX', rates: '^TNX' };
  const entries = await Promise.all(Object.entries(symbols).map(async ([key, symbol]) => {
    const result = await safeJson(`${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=5d&interval=1d`, 8000);
    const closes = result.ok ? result.value?.chart?.result?.[0]?.indicators?.quote?.[0]?.close : null;
    const values = Array.isArray(closes) ? closes.map(number).filter(value => value !== null) : [];
    const first = values[0];
    const last = values.at(-1);
    return [key, first && last ? (last - first) / first : null];
  }));
  const macro = Object.fromEntries(entries);
  const values = [macro.dxy, macro.nasdaq, macro.rates].filter(Number.isFinite);
  if (!values.length) return { available: false, bias: 0, values: macro };
  return {
    available: true,
    values: macro,
    bias: clamp((Number(macro.nasdaq || 0) - Number(macro.dxy || 0) - Number(macro.rates || 0) * 0.2) / 0.02, -1, 1)
  };
}

async function loadFallbackSpot() {
  const result = await safeJson(`${COINGECKO_BASE}/simple/price?ids=bitcoin,solana,ethereum&vs_currencies=usd&include_24hr_change=true`, 10000);
  if (!result.ok) return {};
  return Object.fromEntries(Object.entries(result.value || {}).map(([id, value]) => [id, {
    price: number(value?.usd),
    momentum: number(value?.usd_24h_change) || 0,
    dailyVolatility: null,
    marketBias: 0,
    technicalBias: 0,
    available: Boolean(number(value?.usd))
  }]));
}

function extrema(points, type) {
  const window = 90;
  const candidates = [];
  for (let index = window; index < points.length - window; index += 1) {
    const current = points[index][1];
    const left = points.slice(index - window, index).map(point => point[1]);
    const right = points.slice(index + 1, index + window + 1).map(point => point[1]);
    const neighborhood = [...left, ...right];
    const isExtreme = type === 'high' ? current >= Math.max(...neighborhood) : current <= Math.min(...neighborhood);
    if (isExtreme) candidates.push(points[index]);
  }
  const selected = [];
  candidates.forEach(candidate => {
    const last = selected.at(-1);
    if (!last || candidate[0] - last[0] > 180 * DAY_MS) selected.push(candidate);
    else if (type === 'high' ? candidate[1] > last[1] : candidate[1] < last[1]) selected[selected.length - 1] = candidate;
  });
  return selected;
}

function cycleTimingFromPoints(rawPoints, now) {
  const points = rawPoints.map(point => [number(point?.[0]), number(point?.[1])])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  if (points.length < 600) return { available: false, reason: 'insufficient verified history' };
  const highs = extrema(points, 'high');
  const lows = extrema(points, 'low');
  const riseIntervals = [];
  lows.forEach(low => {
    const high = highs.find(candidate => candidate[0] > low[0]);
    if (high) riseIntervals.push((high[0] - low[0]) / DAY_MS);
  });
  const fallIntervals = [];
  highs.forEach(high => {
    const low = lows.find(candidate => candidate[0] > high[0]);
    if (low) fallIntervals.push((low[0] - high[0]) / DAY_MS);
  });
  const riseDays = median(riseIntervals.filter(value => value > 500 && value < 1600));
  const fallDays = median(fallIntervals.filter(value => value > 180 && value < 700));
  const lastLow = lows.at(-1);
  const lastHigh = highs.filter(point => point[0] < (lastLow?.[0] || now)).at(-1);
  if (!lastLow || !lastHigh || !riseDays || !fallDays) return { available: false, reason: 'cycle pivots unavailable' };
  const patternFit = clamp(1 - ((Math.abs(riseDays - 1064) / 1064) + (Math.abs(fallDays - 364) / 364)) / 2, 0, 1);
  const confidence = clamp(patternFit * 0.65 + Math.min(riseIntervals.length, 3) * 0.1 + Math.min(fallIntervals.length, 3) * 0.1, 0, 1);
  const projectedHigh = lastLow[0] + riseDays * DAY_MS;
  const projectedLow = projectedHigh + fallDays * DAY_MS;
  const distanceToHigh = (now - projectedHigh) / DAY_MS;
  const distanceToLow = (now - projectedLow) / DAY_MS;
  let bias = 0;
  let phase = 'neutral';
  if (Math.abs(distanceToHigh) <= 45) {
    bias = -0.8;
    phase = 'distribution window';
  } else if (distanceToHigh > 45 && distanceToLow < -45) {
    bias = -0.35;
    phase = 'post-peak contraction';
  } else if (Math.abs(distanceToLow) <= 45) {
    bias = 0.5;
    phase = 'accumulation window';
  } else if (distanceToLow > 45) {
    bias = 0.35;
    phase = 'expansion window';
  }
  return {
    available: true,
    bias: bias * confidence,
    phase,
    confidence,
    riseDays,
    fallDays,
    projectedHigh,
    projectedLow,
    source: 'CoinGecko historical daily data'
  };
}

async function loadCycleTiming(now) {
  if (cycleCache.value && Date.now() - cycleCache.updatedAt < CYCLE_CACHE_MS) return cycleCache.value;
  const result = await safeJson(`${COINGECKO_BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily`, 15000);
  const value = result.ok ? cycleTimingFromPoints(result.value?.prices, now) : { available: false, reason: 'historical source unavailable' };
  cycleCache = { updatedAt: Date.now(), value };
  return value;
}

function directionForBias(value, hasPolymarket) {
  if (!hasPolymarket && Math.abs(value) < 0.2) return 'neutral';
  if (value >= 0.12) return 'bullish';
  if (value <= -0.12) return 'bearish';
  return 'neutral';
}

function forecastForAsset(symbol, marketData, eventMap, cycle, macro) {
  const asset = ASSETS[symbol];
  const result = { symbol, price: marketData.price, horizons: {} };
  for (const horizon of ['1D', '1M', 'YE']) {
    const levels = parseLevels(eventMap?.[horizon], marketData.price || 0, horizon);
    const range = rangeFromLevels(levels, marketData.price, horizon, marketData) || fallbackRange(marketData.price, horizon, marketData);
    const polyBias = range?.polyMid && marketData.price ? clamp((range.polyMid - marketData.price) / (marketData.price * 0.16), -1, 1) : 0;
    const cycleWeight = symbol === 'BTC' ? (horizon === 'YE' ? 0.20 : horizon === '1M' ? 0.12 : 0.03) : 0.05;
    const cycleBias = cycle?.available ? cycle.bias * (symbol === 'BTC' ? 1 : 0.5) : 0;
    const marketBias = clamp((marketData.marketBias || 0) * 0.85 + (macro?.available ? macro.bias * 0.15 : 0), -1, 1);
    const weights = [
      { value: polyBias, weight: levels.length ? 0.50 : 0 },
      { value: marketBias, weight: 0.25 },
      { value: marketData.technicalBias || 0, weight: 0.10 },
      { value: cycleBias, weight: cycle?.available ? cycleWeight : 0 }
    ];
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0) || 1;
    const bias = weights.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
    result.horizons[horizon] = {
      low: range?.low ?? null,
      high: range?.high ?? null,
      direction: directionForBias(bias, levels.length > 0),
      dataSufficient: levels.length > 0,
      levelCount: levels.length,
      bias: clamp(bias, -1, 1)
    };
  }
  return result;
}

async function buildForecast() {
  const now = Date.now();
  const fallback = await loadFallbackSpot();
  const marketEntries = await Promise.all(Object.entries(ASSETS).map(async ([symbol, asset]) => [symbol, await loadMarketData(asset)]));
  const market = Object.fromEntries(marketEntries.map(([symbol, value]) => {
    const fallbackValue = fallback[ASSETS[symbol].coinId] || {};
    const combined = Object.fromEntries(Object.entries({ ...fallbackValue, ...value }).map(([key, item]) => [
      key,
      item === null || item === undefined || (typeof item === 'number' && !Number.isFinite(item))
        ? fallbackValue[key]
        : item
    ]));
    return [symbol, combined];
  }));
  const [events, cycle, macro] = await Promise.all([
    loadPolymarketEvents(now),
    loadCycleTiming(now),
    loadMacroData()
  ]);
  const assets = Object.keys(ASSETS).map(symbol => forecastForAsset(symbol, market[symbol], events[symbol], cycle, macro));
  return {
    updatedAt: new Date(now).toISOString(),
    refreshMs: 60 * 60 * 1000,
    assets,
    cycle: {
      available: Boolean(cycle?.available),
      phase: cycle?.phase || 'unavailable'
    },
    macro: { available: Boolean(macro?.available) }
  };
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (runtimeCache.payload && Date.now() - runtimeCache.updatedAt < CACHE_MS) {
    return response.status(200).json(runtimeCache.payload);
  }
  try {
    const payload = await buildForecast();
    runtimeCache = { updatedAt: Date.now(), payload };
    return response.status(200).json(payload);
  } catch (error) {
    console.error('[forecast] request failed', String(error));
    if (runtimeCache.payload) return response.status(200).json(runtimeCache.payload);
    return response.status(503).json({ error: 'Crypto forecast is temporarily unavailable' });
  }
}
