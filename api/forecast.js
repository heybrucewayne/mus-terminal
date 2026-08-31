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
    const daysToEnd = end === null ? null : (end - now) / DAY_MS;
    const hasExactDay = new RegExp(`\\b${currentMonth}\\s+${day}\\b`).test(text);
    const isShortHorizon = /today|tomorrow|daily|24\\s*h|24-hour|next day/.test(text);
    const isCurrentMonth = text.includes(currentMonth);
    const isMonthly = /month|monthly/.test(text) || isCurrentMonth;
    const isYearly = /year|year-end|year end|before/.test(text) || text.includes(String(nextYear));
    let score = 0;
    if (event?.closed === true || event?.active === false || (daysToEnd !== null && daysToEnd <= 0)) return { event, score: -Infinity, end };
    if (horizon === 'YE') {
      if (isYearly) score += 260;
      if (end !== null && daysToEnd >= 45 && daysToEnd <= 430) score += 260 - Math.abs(daysToEnd - 150) * 0.45;
      if (end !== null && daysToEnd < 45) score -= 240;
      if (isShortHorizon || hasExactDay) score -= 220;
    } else if (horizon === '1M') {
      if (isCurrentMonth) score += 360;
      else if (isMonthly) score += 220;
      if (end !== null && isCurrentMonth && daysToEnd >= 0 && daysToEnd <= 45) score += 220;
      if (end !== null && daysToEnd >= 10 && daysToEnd <= 75) score += 260 - Math.abs(daysToEnd - 30) * 1.5;
      if (end !== null && daysToEnd < 7 && !isCurrentMonth) score -= 260;
      if (isShortHorizon || hasExactDay) score -= 180;
    } else {
      if (hasExactDay || isShortHorizon) score += 420;
      if (end !== null && daysToEnd >= 0 && daysToEnd <= 4) score += 260 - daysToEnd * 45;
      if (end !== null && daysToEnd > 10) score -= Math.min(260, (daysToEnd - 10) * 8);
      if (isMonthly || isYearly) score -= 180;
    }
    if (text.includes('price')) score += 20;
    return { event, score, end };
  }).sort((a, b) => b.score - a.score || (a.end || Infinity) - (b.end || Infinity));
  const best = scored[0];
  return best && Number.isFinite(best.score) && best.score > -180 ? best.event : null;
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
  if (text.includes('↓') || /below|under|dip|drop|fall|lower/.test(text)) return 'down';
  if (text.includes('↑') || /above|over|rise|higher|exceed/.test(text)) return 'up';
  return threshold >= spot ? 'up' : 'down';
}

function horizonPriceBounds(spot, horizon) {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const factors = {
    '1D': [0.88, 1.16],
    '1M': [0.62, 1.55],
    YE: [0.35, 2.25]
  }[horizon] || [0.35, 2.25];
  return { min: spot * factors[0], max: spot * factors[1] };
}

function calendarDaysToEnd(horizon, now = Date.now()) {
  const date = new Date(now);
  let end;
  if (horizon === '1D') return 1;
  if (horizon === '1M') {
    end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  } else if (horizon === 'YE') {
    end = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  } else {
    return 21;
  }
  return Math.max(1, Math.ceil((end - now) / DAY_MS));
}

function forecastSettings(horizon, now = Date.now()) {
  const profiles = {
    '1D': { referenceDays: 1, minWidth: 0.012, maxWidth: 0.045, noDataWidth: 0.028, targetCap: 0.025, signalScale: 0.035 },
    '1M': { referenceDays: 21, minWidth: 0.025, maxWidth: 0.10, noDataWidth: 0.065, targetCap: 0.06, signalScale: 0.08 },
    YE: { referenceDays: 100, minWidth: 0.04, maxWidth: 0.15, noDataWidth: 0.10, targetCap: 0.09, signalScale: 0.16 }
  };
  const profile = profiles[horizon] || profiles['1M'];
  const tradingDays = calendarDaysToEnd(horizon, now);
  const scale = Math.sqrt(tradingDays / profile.referenceDays);
  return {
    tradingDays,
    minWidth: clamp(profile.minWidth * scale, profile.minWidth * 0.60, profile.maxWidth * 0.65),
    maxWidth: clamp(profile.maxWidth * scale, profile.maxWidth * 0.65, profile.maxWidth * 1.15),
    noDataWidth: clamp(profile.noDataWidth * scale, profile.minWidth, profile.maxWidth),
    targetCap: clamp(profile.targetCap * scale, 0.015, profile.targetCap * 1.25),
    signalScale: profile.signalScale
  };
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
    const text = `${market?.groupItemTitle || ''} ${market?.question || ''}`.toLowerCase();
    const cumulativeHint = /\b(above|below|over|under|at least|at most|more than|less than|higher than|lower than|exceed)\b/.test(text);
    return {
      threshold,
      yes: clamp(yes, 0, 1),
      direction: parseDirection(market, threshold, spot),
      cumulativeHint
    };
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

function isotonicProbabilities(levels, direction) {
  const sorted = levels
    .slice()
    .sort((a, b) => a.threshold - b.threshold);
  const blocks = sorted.map(level => ({ sum: clamp(level.yes, 0, 1), count: 1 }));
  const increasing = direction === 'down';
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    const violates = increasing
      ? previous.sum / previous.count > current.sum / current.count
      : previous.sum / previous.count < current.sum / current.count;
    if (!violates) continue;
    blocks.splice(index - 1, 2, {
      sum: previous.sum + current.sum,
      count: previous.count + current.count
    });
    index = Math.max(0, index - 2);
  }
  const probabilities = [];
  blocks.forEach(block => {
    probabilities.push(...Array(block.count).fill(clamp(block.sum / block.count, 0, 1)));
  });
  return sorted.map((level, index) => ({ ...level, probability: probabilities[index] }));
}

function cumulativeDistribution(levels, spot, direction) {
  const sorted = isotonicProbabilities(levels, direction);
  if (!sorted.length) return [];
  const points = [];
  if (direction === 'up') {
    const first = sorted[0].probability;
    if (first < 1) points.push({ value: spot, weight: 1 - first });
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const weight = sorted[index].probability - sorted[index + 1].probability;
      if (weight > 0) points.push({ value: sorted[index].threshold, weight });
    }
    points.push({ value: sorted.at(-1).threshold, weight: sorted.at(-1).probability });
  } else {
    points.push({ value: sorted[0].threshold, weight: sorted[0].probability });
    for (let index = 1; index < sorted.length; index += 1) {
      const weight = sorted[index].probability - sorted[index - 1].probability;
      if (weight > 0) points.push({ value: sorted[index].threshold, weight });
    }
    const spotWeight = 1 - sorted.at(-1).probability;
    if (spotWeight > 0) points.push({ value: spot, weight: spotWeight });
  }
  return points.filter(point => Number.isFinite(point.value) && point.weight > 0);
}

function impliedDistribution(levels, spot) {
  const valid = levels.filter(level => Number.isFinite(level.threshold) && level.threshold > 0 && Number.isFinite(level.yes));
  if (!valid.length) return [];
  const cumulative = valid.some(level => level.cumulativeHint);
  if (!cumulative) {
    const total = valid.reduce((sum, level) => sum + level.yes, 0);
    return total > 0
      ? valid.map(level => ({ value: level.threshold, weight: level.yes / total }))
      : [];
  }

  const up = valid.filter(level => level.direction === 'up' && level.threshold >= spot);
  const down = valid.filter(level => level.direction === 'down' && level.threshold < spot);
  const upPoints = cumulativeDistribution(up, spot, 'up');
  const downPoints = cumulativeDistribution(down, spot, 'down');
  if (!upPoints.length) return downPoints;
  if (!downPoints.length) return upPoints;
  // Upward and downward threshold books are two views of the same future
  // distribution. Blend them equally, then normalize the combined masses.
  const blended = [
    ...upPoints.map(point => ({ ...point, weight: point.weight * 0.5 })),
    ...downPoints.map(point => ({ ...point, weight: point.weight * 0.5 }))
  ];
  const total = blended.reduce((sum, point) => sum + point.weight, 0);
  return total > 0 ? blended.map(point => ({ ...point, weight: point.weight / total })) : [];
}

function rangeFromLevels(levels, spot, horizon, marketData, now = Date.now()) {
  const distribution = impliedDistribution(levels, spot);
  const bounds = horizonPriceBounds(spot, horizon);
  if (!distribution.length || !bounds) return null;
  const low = weightedQuantile(distribution, 0.25);
  const high = weightedQuantile(distribution, 0.75);
  const medianPrice = weightedQuantile(distribution, 0.50);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const settings = forecastSettings(horizon, now);
  const volatility = Number.isFinite(marketData?.dailyVolatility) ? marketData.dailyVolatility : 0.025;
  const volatilityHalfLogWidth = volatility * Math.sqrt(settings.tradingDays) * 0.67;
  const polymarketHalfLogWidth = Math.abs(Math.log(Math.max(high, 1) / Math.max(low, 1))) * 0.5;
  const halfLogWidth = clamp(
    polymarketHalfLogWidth * 0.65 + volatilityHalfLogWidth * 0.35,
    Math.log1p(settings.minWidth),
    Math.log1p(settings.maxWidth)
  );
  const widthRatio = Math.expm1(halfLogWidth);
  const polyMid = Number.isFinite(medianPrice) ? medianPrice : spot;
  return {
    low: clamp(spot * Math.exp(-halfLogWidth), bounds.min, bounds.max),
    high: clamp(spot * Math.exp(halfLogWidth), bounds.min, bounds.max),
    widthRatio,
    normalizedCount: distribution.length,
    polyMid: clamp(polyMid, bounds.min, bounds.max),
    coverage: 0.50
  };
}

function fallbackRange(spot, horizon, marketData, now = Date.now()) {
  const settings = forecastSettings(horizon, now);
  const volatility = Number.isFinite(marketData?.dailyVolatility) ? marketData.dailyVolatility : 0.035;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const volatilityWidth = volatility * Math.sqrt(settings.tradingDays) * 0.67;
  const band = clamp(Math.max(settings.noDataWidth, Math.expm1(volatilityWidth)), settings.minWidth, settings.maxWidth);
  return {
    low: Math.max(0, spot * (1 - band)),
    high: spot * (1 + band),
    widthRatio: band,
    normalizedCount: 0,
    polyMid: null,
    coverage: null
  };
}

function ewmaVolatility(returns, lambda = 0.94) {
  const values = returns.filter(Number.isFinite);
  if (!values.length) return null;
  let variance = values.slice(0, Math.min(10, values.length)).reduce((sum, value) => sum + value ** 2, 0)
    / Math.min(10, values.length);
  for (const value of values) variance = lambda * variance + (1 - lambda) * value ** 2;
  return Math.sqrt(Math.max(variance, 0));
}

function blendedVolatility(returns) {
  const values = returns.filter(Number.isFinite);
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sample = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
    : null;
  const ewma = ewmaVolatility(values);
  const available = [sample, ewma].filter(Number.isFinite);
  if (!available.length) return null;
  // EWMA reacts to the current volatility regime while the sample estimate
  // prevents a single recent shock from making the interval unstable.
  return clamp((Number.isFinite(ewma) ? ewma * 0.65 : 0) + (Number.isFinite(sample) ? sample * 0.35 : 0), 0.008, 0.12);
}

async function loadMarketData(asset) {
  const tickerResult = await safeJson(`${BINANCE_BASE}/api/v3/ticker/24hr?symbol=${asset.symbol}`);
  const ticker = tickerResult.ok ? tickerResult.value : null;
  const klinesResult = await safeJson(`${BINANCE_BASE}/api/v3/klines?symbol=${asset.symbol}&interval=1d&limit=90`, 10000);
  const closes = Array.isArray(klinesResult.value) ? klinesResult.value.map(row => number(row?.[4])).filter(value => value > 0) : [];
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index])).filter(Number.isFinite);
  const dailyVolatility = blendedVolatility(returns);
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

function extrema(points, type, window = 90, minimumSeparationDays = 180) {
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
    if (!last || candidate[0] - last[0] > minimumSeparationDays * DAY_MS) selected.push(candidate);
    else if (type === 'high' ? candidate[1] > last[1] : candidate[1] < last[1]) selected[selected.length - 1] = candidate;
  });
  return selected;
}

function majorCycleExtrema(points, type) {
  // A 180-day neighborhood plus a 650-day separation keeps minor rallies and
  // pullbacks out of the cycle model while retaining the 2015/2017, 2018/2021
  // and 2022/2025-style macro pivots.
  return extrema(points, type, 180, 650);
}

function cycleTimingFromPoints(rawPoints, now) {
  const points = rawPoints.map(point => [number(point?.[0]), number(point?.[1])])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0)
    .sort((a, b) => a[0] - b[0]);
  if (points.length < 600) return { available: false, reason: 'insufficient verified history' };
  const highs = majorCycleExtrema(points, 'high');
  const lows = majorCycleExtrema(points, 'low');
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

function compactForecastRange(range, spot, horizon, bias, now = Date.now()) {
  const bounds = horizonPriceBounds(spot, horizon);
  const settings = forecastSettings(horizon, now);
  if (!range || !bounds || !Number.isFinite(spot) || spot <= 0) return range;
  const widthRatio = clamp(Number(range.widthRatio) || settings.noDataWidth, settings.minWidth, settings.maxWidth);
  const targetShift = clamp((Number(bias) || 0) * settings.targetCap, -settings.targetCap, settings.targetCap);
  const center = spot * Math.exp(targetShift);
  const halfLogWidth = Math.log1p(widthRatio);
  return {
    ...range,
    low: clamp(center * Math.exp(-halfLogWidth), bounds.min, bounds.max),
    high: clamp(center * Math.exp(halfLogWidth), bounds.min, bounds.max),
    center
  };
}

function forecastForAsset(symbol, marketData, eventMap, cycle, macro) {
  const asset = ASSETS[symbol];
  const result = { symbol, price: marketData.price, horizons: {} };
  const now = Date.now();
  for (const horizon of ['1D', '1M', 'YE']) {
    const settings = forecastSettings(horizon, now);
    const levels = parseLevels(eventMap?.[horizon], marketData.price || 0, horizon);
    const range = rangeFromLevels(levels, marketData.price, horizon, marketData, now)
      || fallbackRange(marketData.price, horizon, marketData, now);
    const polyBias = range?.polyMid && marketData.price
      ? clamp(Math.log(range.polyMid / marketData.price) / settings.signalScale, -1, 1)
      : 0;
    const cycleWeight = symbol === 'BTC'
      ? (horizon === 'YE' ? 0.20 : horizon === '1M' ? 0.12 : 0.03)
      : (horizon === 'YE' ? 0.08 : horizon === '1M' ? 0.06 : 0.03);
    const cycleBias = cycle?.available ? cycle.bias * (symbol === 'BTC' ? 1 : 0.5) : 0;
    const marketBias = clamp((marketData.marketBias || 0) * 0.85 + (macro?.available ? macro.bias * 0.15 : 0), -1, 1);
    const weights = [
      { value: polyBias, weight: levels.length >= 2 ? 0.50 : levels.length === 1 ? 0.25 : 0 },
      { value: marketBias, weight: 0.25 },
      { value: marketData.technicalBias || 0, weight: 0.10 },
      { value: cycleBias, weight: cycle?.available ? cycleWeight : 0 }
    ];
    const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0) || 1;
    const bias = weights.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
    const finalRange = compactForecastRange(range, marketData.price, horizon, bias, now);
    result.horizons[horizon] = {
      low: finalRange?.low ?? null,
      high: finalRange?.high ?? null,
      direction: directionForBias(bias, levels.length >= 2),
      dataSufficient: levels.length >= 2,
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

export {
  horizonPriceBounds,
  forecastSettings,
  parseLevels,
  impliedDistribution,
  rangeFromLevels,
  fallbackRange,
  ewmaVolatility,
  blendedVolatility,
  compactForecastRange,
  forecastForAsset
};
