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
    let upstream = null;
    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d&events=history`;
      try {
        const candidate = await fetchWithTimeout(url);
        if (candidate.ok) { upstream = candidate; break; }
      } catch (error) {
        console.warn('[history] upstream failed', { host, error: String(error) });
      }
    }
    if (!upstream) {
      return response.status(502).json({ error: 'History provider is unavailable' });
    }

    const payload = await upstream.json();
    const result = payload?.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = result?.indicators?.adjclose?.[0]?.adjclose || result?.indicators?.quote?.[0]?.close || [];
    const points = timestamps.map((timestamp, index) => [timestamp * 1000, Number(closes[index])])
      .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0);

    if (!points.length) {
      return response.status(404).json({ error: 'No historical prices found' });
    }

    response.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return response.status(200).json({ symbol, points });
  } catch (error) {
    console.error('[history] request failed', { symbol, error: String(error) });
    return response.status(500).json({ error: 'Historical prices could not be loaded' });
  }
}
