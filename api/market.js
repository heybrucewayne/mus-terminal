const FRESH_MS = 15_000;
const MAX_STALE_MS = 5 * 60_000;
const TIMEOUT_MS = 8000;
let cached = null;
let inFlight = null;

async function refresh() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await fetch('https://api.binance.com/api/v3/ticker/24hr', {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!result.ok) throw new Error(`Market provider returned ${result.status}`);
    const payload = await result.json();
    if (!Array.isArray(payload)) throw new Error('Invalid market response');
    const tickers = payload.filter(row => /(?:USDT|USDTTRY)$/.test(String(row?.symbol || ''))
      && !/(?:UP|DOWN|BULL|BEAR)USDT$/.test(row.symbol)
      && row.lastPrice != null && Number.isFinite(Number(row.lastPrice)) && Number(row.lastPrice) > 0
      && row.priceChangePercent != null && Number.isFinite(Number(row.priceChangePercent)))
      .map(({ symbol, lastPrice, priceChangePercent, highPrice, lowPrice, quoteVolume, volume }) =>
        ({ symbol, lastPrice, priceChangePercent, highPrice, lowPrice, quoteVolume, volume }));
    if (!tickers.length) throw new Error('Empty market response');
    cached = { tickers, updatedAt: new Date().toISOString(), source: 'Binance' };
    return cached;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Only GET is supported.' });
  }
  try {
    if (!cached || Date.now() - Date.parse(cached.updatedAt) >= FRESH_MS) {
      // All callers on this instance share the same upstream request.
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      await inFlight;
    }
    response.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=15');
    return response.status(200).json({ ...cached, stale: false });
  } catch {
    response.setHeader('Cache-Control', 'no-store');
    if (cached && Date.now() - Date.parse(cached.updatedAt) <= MAX_STALE_MS) {
      return response.status(200).json({ ...cached, stale: true, warning: 'Live feed unavailable; showing the last received quotes.' });
    }
    return response.status(503).json({ error: 'Market feed is temporarily unavailable.' });
  }
}
