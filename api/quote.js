const ALLOWED_SYMBOL = /^[A-Z0-9.^=@-]{1,24}$/i;
const REQUEST_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; MUS-Terminal/1.0)'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const symbol = String(request.query.symbol || '').trim();
  if (!ALLOWED_SYMBOL.test(symbol)) {
    return response.status(400).json({ error: 'Invalid symbol' });
  }

  try {
    let result = null;
    for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m`;
      try {
        const upstream = await fetchWithTimeout(url);
        if (!upstream.ok) continue;
        const payload = await upstream.json();
        result = payload?.chart?.result?.[0] || null;
        if (result) break;
      } catch (error) {
        console.warn('[quote] upstream failed', { host, error: String(error) });
      }
    }

    if (!result) {
      return response.status(502).json({ error: 'Quote provider is unavailable' });
    }

    const meta = result.meta || {};
    const quote = result.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quote.close) ? quote.close.filter(Number.isFinite) : [];
    const price = finiteNumber(meta.regularMarketPrice, closes.at(-1));
    if (!price || price <= 0) {
      return response.status(404).json({ error: 'Quote not found' });
    }

    const previous = finiteNumber(meta.previousClose, meta.chartPreviousClose);
    const chgPct = previous && previous > 0 ? (price - previous) / previous * 100 : 0;
    const high = finiteNumber(meta.regularMarketDayHigh);
    const low = finiteNumber(meta.regularMarketDayLow);
    const volume = finiteNumber(meta.regularMarketVolume);

    response.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return response.status(200).json({
      symbol,
      name: meta.longName || meta.shortName || symbol,
      price,
      chgPct,
      prev: previous,
      high,
      low,
      vol: volume
    });
  } catch (error) {
    console.error('[quote] request failed', { symbol, error: String(error) });
    return response.status(500).json({ error: 'Quote could not be loaded' });
  }
}
