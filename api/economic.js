const BLS_ENDPOINT = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_SERIES = 'CUUR0000SA0';
const REQUEST_TIMEOUT_MS = 10000;

async function fetchBls(startyear, endyear) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(BLS_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; MUS-Terminal/1.0)'
      },
      body: JSON.stringify({ seriesid: [BLS_SERIES], startyear, endyear })
    });
  } finally {
    clearTimeout(timer);
  }
}

function monthlyCpi(payload) {
  const data = payload?.Results?.series?.[0]?.data;
  if (!Array.isArray(data)) return [];
  return data.map(entry => {
    const month = Number(String(entry.period || '').slice(1));
    const year = Number(entry.year);
    const value = Number(entry.value);
    return { year, month, value };
  }).filter(entry => Number.isInteger(entry.year)
    && entry.month >= 1 && entry.month <= 12
    && Number.isFinite(entry.value) && entry.value > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

function inflationPoints(records) {
  const byMonth = new Map(records.map(item => [`${item.year}-${item.month}`, item.value]));
  return records.map(item => {
    const prior = byMonth.get(`${item.year - 1}-${item.month}`);
    if (!Number.isFinite(prior) || prior <= 0) return null;
    const inflation = (item.value / prior - 1) * 100;
    return [Date.UTC(item.year, item.month - 1, 1), inflation];
  }).filter(Boolean);
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const symbol = String(request.query.symbol || '').trim().toUpperCase();
  if (symbol !== 'USIRYY') {
    return response.status(400).json({ error: 'Unsupported economic indicator' });
  }

  const currentYear = new Date().getUTCFullYear();
  try {
    const upstream = await fetchBls(String(currentYear - 3), String(currentYear));
    if (!upstream.ok) {
      return response.status(502).json({ error: 'BLS data provider is unavailable' });
    }
    const payload = await upstream.json();
    if (payload?.status !== 'REQUEST_SUCCEEDED') {
      return response.status(502).json({ error: 'BLS data request failed' });
    }

    const points = inflationPoints(monthlyCpi(payload));
    const latest = points.at(-1);
    const previous = points.at(-2);
    if (!latest) {
      return response.status(404).json({ error: 'Inflation data was not found' });
    }

    const price = latest[1];
    const chgPct = previous ? price - previous[1] : 0;
    response.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return response.status(200).json({
      symbol,
      name: 'United States Inflation Rate YoY',
      source: 'U.S. Bureau of Labor Statistics',
      series: BLS_SERIES,
      price,
      chgPct,
      prev: previous?.[1] ?? null,
      high: null,
      low: null,
      vol: null,
      releaseDate: new Date(latest[0]).toISOString().slice(0, 10),
      points
    });
  } catch (error) {
    console.error('[economic] request failed', { symbol, error: String(error) });
    return response.status(500).json({ error: 'Economic indicator could not be loaded' });
  }
}
