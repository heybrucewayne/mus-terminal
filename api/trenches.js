const CACHE_MS = 10 * 60 * 1000;
const DISCOVERY_LIMIT = 27;
const REPORT_LIMIT = 12;
const REQUEST_TIMEOUT_MS = 8500;

let runtimeCache = { updatedAt: 0, payload: null };

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function fetchJson(url, timeout = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MUS-Terminal/1.0" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function settleJson(url) {
  try {
    return { ok: true, data: await fetchJson(url) };
  } catch (error) {
    return { ok: false, data: null, error: error?.name === "AbortError" ? "timeout" : error?.message || "request failed" };
  }
}

function addDiscovery(target, item, source) {
  const address = item?.tokenAddress || item?.mint || item?.address;
  if (!addressPattern.test(address || "")) return;
  if (item?.chainId && item.chainId !== "solana") return;

  const existing = target.get(address) || { address, sources: [], symbol: "" };
  if (!existing.sources.includes(source)) existing.sources.push(source);
  if (!existing.symbol && item?.symbol) existing.symbol = item.symbol;
  target.set(address, existing);
}

function pairWeight(pair) {
  return number(pair?.liquidity?.usd) + number(pair?.volume?.h24) * 0.12 + number(pair?.txns?.h24?.buys) + number(pair?.txns?.h24?.sells);
}

function selectPairs(rawPairs) {
  const selected = new Map();
  for (const pair of Array.isArray(rawPairs) ? rawPairs : []) {
    if (pair?.chainId !== "solana" || !pair?.baseToken?.address) continue;
    const address = pair.baseToken.address;
    const current = selected.get(address);
    if (!current || pairWeight(pair) > pairWeight(current)) selected.set(address, pair);
  }
  return selected;
}

function marketBandScore(marketCap) {
  if (!marketCap) return 2;
  const log = Math.log10(Math.max(marketCap, 1));
  return clamp(19 - Math.abs(log - 6) * 5.5, 2, 19);
}

function preScore(pair) {
  const mc = number(pair?.marketCap) || number(pair?.fdv);
  const lp = number(pair?.liquidity?.usd);
  const v1 = number(pair?.volume?.h1);
  const v24 = number(pair?.volume?.h24);
  const tx1 = number(pair?.txns?.h1?.buys) + number(pair?.txns?.h1?.sells);
  const lpRatio = mc ? lp / mc : 0;
  const turnover = mc ? v24 / mc : 0;

  return marketBandScore(mc)
    + clamp(Math.log10(v24 + 1) * 3, 0, 20)
    + clamp(Math.log10(v1 + 1) * 2, 0, 12)
    + clamp(Math.log10(lp + 1) * 2, 0, 12)
    + clamp(lpRatio * 80, 0, 10)
    + clamp(turnover * 6, 0, 10)
    + clamp(tx1 / 20, 0, 8);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function authorityState(...values) {
  const present = values.filter((value) => value !== undefined);
  if (!present.length) return "unknown";
  if (present.some((value) => value !== null && value !== "")) return "open";
  return "revoked";
}

function contradictoryAuthority(...values) {
  const present = values.filter((value) => value !== undefined);
  if (present.length < 2) return false;
  return present.some((value) => String(value) !== String(present[0]));
}

function knownNonHolder(report, holder) {
  const known = report?.knownAccounts || {};
  const labels = [known?.[holder?.address]?.type, known?.[holder?.owner]?.type]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return /AMM|LOCKER|BURN|LIQUIDITY/.test(labels);
}

function securitySnapshot(report, pair) {
  if (!report) {
    return {
      verified: false,
      contradictory: false,
      mint: "unknown",
      freeze: "unknown",
      lpLockedPct: null,
      top1Pct: null,
      top10Pct: null,
      insiderPct: null,
      bundled: "unknown",
      wash: "unknown",
      devSale: "unknown",
      riskScore: null,
      notableRisk: "Güvenlik verisi Doğrulanmadı"
    };
  }

  const mint = authorityState(report?.token?.mintAuthority, report?.mintAuthority);
  const freeze = authorityState(report?.token?.freezeAuthority, report?.freezeAuthority);
  const contradictory = contradictoryAuthority(report?.token?.mintAuthority, report?.mintAuthority)
    || contradictoryAuthority(report?.token?.freezeAuthority, report?.freezeAuthority);
  const holders = (Array.isArray(report?.topHolders) ? report.topHolders : []).filter((holder) => !knownNonHolder(report, holder));
  const top1Pct = holders.length ? number(holders[0]?.pct) : null;
  const top10Pct = holders.length ? holders.slice(0, 10).reduce((sum, holder) => sum + number(holder?.pct), 0) : null;
  const insiderPct = holders.length ? holders.filter((holder) => holder?.insider).reduce((sum, holder) => sum + number(holder?.pct), 0) : null;
  const lockValues = (Array.isArray(report?.markets) ? report.markets : [])
    .map((market) => Number(market?.lp?.lpLockedPct))
    .filter(Number.isFinite);
  const lpLockedPct = lockValues.length ? Math.max(...lockValues) : null;
  const risks = Array.isArray(report?.risks) ? report.risks : [];
  const riskText = risks.map((risk) => `${risk?.name || ""} ${risk?.description || ""} ${risk?.value || ""}`).join(" ").toLowerCase();
  const bundled = /bundl/.test(riskText) ? "flagged" : "clear";
  const wash = /wash trad/.test(riskText) ? "flagged" : "clear";
  const devSale = /(creator|developer|dev).{0,30}(sell|sold|dump)/.test(riskText) ? "flagged" : "clear";
  const notable = risks
    .slice()
    .sort((a, b) => number(b?.score) - number(a?.score))[0];

  return {
    verified: mint !== "unknown" && freeze !== "unknown" && holders.length > 0 && Array.isArray(report?.risks),
    contradictory,
    mint,
    freeze,
    lpLockedPct,
    top1Pct,
    top10Pct,
    insiderPct,
    bundled,
    wash,
    devSale,
    riskScore: Number.isFinite(Number(report?.score_normalised)) ? Number(report.score_normalised) : number(report?.score),
    rugged: report?.rugged === true,
    graphInsiders: number(report?.graphInsidersDetected),
    uniqueTraders: null,
    notableRisk: notable?.name || (lpLockedPct === null ? "LP kilidi Doğrulanmadı" : "Belirgin RugCheck uyarısı yok")
  };
}

function volumeSnapshot(pair) {
  const m5 = number(pair?.volume?.m5);
  const h1 = number(pair?.volume?.h1);
  const h6 = number(pair?.volume?.h6);
  const h24 = number(pair?.volume?.h24);
  const pace5 = m5 * 12;
  const previous5hPace = Math.max(h6 - h1, 0) / 5;
  const previous18hPace = Math.max(h24 - h6, 0) / 18;
  let trend = "steady";
  if (pace5 > Math.max(h1, 1) * 1.12 && h1 > Math.max(previous5hPace, 1) * 1.08) trend = "rising";
  else if (h1 < Math.max(previous5hPace, 1) * 0.68 || previous5hPace < Math.max(previous18hPace, 1) * 0.62) trend = "falling";

  return { m5, h1, h6, h24, pace5, previous5hPace, previous18hPace, trend };
}

function transactionSnapshot(pair) {
  const periods = ["m5", "h1", "h6", "h24"];
  const txns = {};
  for (const period of periods) {
    const buys = number(pair?.txns?.[period]?.buys);
    const sells = number(pair?.txns?.[period]?.sells);
    txns[period] = { buys, sells, total: buys + sells, buyRatio: buys + sells ? buys / (buys + sells) : 0 };
  }
  return txns;
}

function classifyPair(pair, report, discovery) {
  const marketCap = number(pair?.marketCap) || number(pair?.fdv);
  const liquidity = number(pair?.liquidity?.usd) || number(report?.totalMarketLiquidity);
  const ageHours = pair?.pairCreatedAt ? Math.max(0, (Date.now() - number(pair.pairCreatedAt)) / 3600000) : null;
  const volume = volumeSnapshot(pair);
  const txns = transactionSnapshot(pair);
  const price = {
    h1: number(pair?.priceChange?.h1),
    h6: number(pair?.priceChange?.h6),
    h24: number(pair?.priceChange?.h24)
  };
  const security = securitySnapshot(report, pair);
  const lpRatio = marketCap ? liquidity / marketCap : 0;
  const lowLpFloor = marketCap ? Math.max(4500, Math.min(28000, marketCap * 0.006)) : 6000;
  const unsupportedSpike = price.h6 > 100 && (volume.trend === "falling" || (marketCap && volume.h6 / marketCap < 0.12));
  const priceVolumeDivergence = (price.h6 > 35 && volume.trend === "falling")
    || (Math.abs(price.h24) > 90 && marketCap && volume.h24 / marketCap < 0.18);
  const hardReasons = [];

  if (security.rugged) hardReasons.push("RugCheck rugged işareti");
  if (security.contradictory) hardReasons.push("Çelişkili güvenlik verisi");
  if (security.mint === "open") hardReasons.push("Mint authority açık");
  if (security.freeze === "open") hardReasons.push("Freeze authority açık");
  if (liquidity < lowLpFloor || lpRatio > 0 && lpRatio < 0.004) hardReasons.push("Likidite çok düşük");
  if (security.top1Pct !== null && security.top1Pct > 25) hardReasons.push("Tek holder yoğunluğu aşırı");
  if (security.top10Pct !== null && security.top10Pct > 72) hardReasons.push("Top holder yoğunluğu aşırı");
  if (security.insiderPct !== null && security.insiderPct > 20) hardReasons.push("Insider yoğunluğu yüksek");
  if (security.bundled === "flagged") hardReasons.push("Bundled buy işareti");
  if (security.wash === "flagged") hardReasons.push("Wash trading işareti");
  if (security.devSale === "flagged") hardReasons.push("Geliştirici satışı işareti");
  if (unsupportedSpike) hardReasons.push("Hacimsiz dik fiyat hareketi");
  if (security.riskScore !== null && security.riskScore >= 75) hardReasons.push("Yüksek RugCheck risk skoru");

  let score = preScore(pair);
  score += volume.trend === "rising" ? 14 : volume.trend === "steady" ? 6 : -8;
  score += txns.h1.buyRatio >= 0.44 && txns.h1.buyRatio <= 0.68 ? 6 : -5;
  score += clamp(lpRatio * 90, 0, 12);
  score += security.lpLockedPct !== null && security.lpLockedPct >= 80 ? 7 : 0;
  score += ageHours !== null && ageHours >= 12 && ageHours <= 720 ? 4 : 0;
  score -= priceVolumeDivergence ? 10 : 0;
  score -= security.top10Pct !== null && security.top10Pct > 50 ? 8 : 0;
  score = Math.round(clamp(score, 0, 100));

  let decision = "yellow";
  if (hardReasons.length) decision = "red";
  else if (security.verified && !security.contradictory && score >= 69 && security.lpLockedPct !== null) decision = "green";

  const volumeComment = volume.trend === "rising"
    ? "hacim kademeli ivmeleniyor"
    : volume.trend === "falling"
      ? "kısa vadeli hacim zayıflıyor"
      : "hacim dengeli seyrediyor";
  const importantRisk = !security.verified
    ? "güvenlik verisi Doğrulanmadı"
    : priceVolumeDivergence
      ? "fiyat/hacim uyumsuzluğu"
      : security.notableRisk === "Belirgin RugCheck uyarısı yok"
        ? "benzersiz trader sayısı Doğrulanmadı"
        : security.notableRisk;

  return {
    address: pair.baseToken.address,
    symbol: (pair?.baseToken?.symbol || discovery?.symbol || "?").slice(0, 12),
    name: (pair?.baseToken?.name || "").slice(0, 60),
    marketCap,
    liquidity,
    volume,
    price,
    txns,
    ageHours,
    score,
    decision,
    decisionLabel: decision === "green" ? "🟢 İzlemeye değer" : decision === "yellow" ? "🟡 Şartlı izleme" : "🔴 Elendi",
    reason: `${volumeComment}; Mint ${security.mint === "revoked" ? "✅" : "⚠️"} Freeze ${security.freeze === "revoked" ? "✅" : "⚠️"} LP ${security.lpLockedPct !== null && security.lpLockedPct >= 80 && liquidity >= lowLpFloor ? "✅" : "⚠️"}; ${importantRisk}`,
    hardReasons,
    security,
    priceVolumeDivergence,
    dexUrl: pair?.url || `https://dexscreener.com/solana/${pair?.pairAddress || pair.baseToken.address}`,
    rugUrl: `https://rugcheck.xyz/tokens/${pair.baseToken.address}`,
    sources: discovery?.sources || []
  };
}

function reasonSummary(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    for (const reason of token.hardReasons) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

async function discover() {
  const [profiles, latestBoosts, topBoosts, rugNew] = await Promise.all([
    settleJson("https://api.dexscreener.com/token-profiles/latest/v1"),
    settleJson("https://api.dexscreener.com/token-boosts/latest/v1"),
    settleJson("https://api.dexscreener.com/token-boosts/top/v1"),
    settleJson("https://api.rugcheck.xyz/v1/stats/new_tokens")
  ]);
  const discovered = new Map();

  const discoveryGroups = [
    [(Array.isArray(profiles.data) ? profiles.data : []).slice(0, 13), "dex-profile"],
    [(Array.isArray(latestBoosts.data) ? latestBoosts.data : []).slice(0, 7), "dex-boost"],
    [(Array.isArray(topBoosts.data) ? topBoosts.data : []).slice(0, 7), "dex-top"],
    [(Array.isArray(rugNew.data) ? rugNew.data : []).slice(0, 7), "rug-new"]
  ];
  for (const [items, source] of discoveryGroups) {
    for (const item of items) addDiscovery(discovered, item, source);
  }

  const warnings = [profiles, latestBoosts, topBoosts, rugNew]
    .filter((result) => !result.ok)
    .map((result) => result.error);
  return { candidates: [...discovered.values()].slice(0, DISCOVERY_LIMIT), warnings };
}

async function buildScan() {
  const { candidates, warnings } = await discover();
  if (!candidates.length) throw new Error("Token keşif kaynakları şu anda yanıt vermiyor.");

  const addresses = candidates.map((item) => item.address);
  const dexResult = await settleJson(`https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`);
  if (!dexResult.ok) throw new Error("DexScreener piyasa verisi alınamadı.");

  const pairMap = selectPairs(dexResult.data);
  const ranked = candidates
    .map((discovery) => ({ discovery, pair: pairMap.get(discovery.address) }))
    .filter((item) => item.pair)
    .sort((a, b) => preScore(b.pair) - preScore(a.pair))
    .slice(0, REPORT_LIMIT);

  if (!ranked.length) throw new Error("Taranan tokenlerde aktif Solana çifti bulunamadı.");

  const reports = await mapLimit(ranked, 3, async ({ discovery }) => {
    const result = await settleJson(`https://api.rugcheck.xyz/v1/tokens/${discovery.address}/report`);
    return result.ok ? result.data : null;
  });
  const classified = ranked.map((item, index) => classifyPair(item.pair, reports[index], item.discovery));
  const visible = classified
    .filter((token) => token.decision !== "red")
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const eliminated = classified.filter((token) => token.decision === "red");

  return {
    generatedAt: new Date().toISOString(),
    autoRefreshMs: 3 * 60 * 60 * 1000,
    scannedCount: classified.length,
    tokens: visible,
    eliminatedCount: eliminated.length,
    eliminationReasons: reasonSummary(eliminated),
    warning: warnings.length ? "Bazı keşif kaynakları yanıt vermedi; mevcut verilerle tarandı." : ""
  };
}

export default async function handler(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Yalnızca GET desteklenir." });
  }

  const force = request.query?.refresh === "1";
  const fresh = runtimeCache.payload && Date.now() - runtimeCache.updatedAt < CACHE_MS;
  if (!force && fresh) {
    response.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    return response.status(200).json({ ...runtimeCache.payload, cached: true });
  }

  try {
    const payload = await buildScan();
    runtimeCache = { updatedAt: Date.now(), payload };
    response.setHeader("Cache-Control", force ? "no-store" : "s-maxage=600, stale-while-revalidate=3600");
    return response.status(200).json({ ...payload, cached: false });
  } catch (error) {
    if (runtimeCache.payload) {
      response.setHeader("Cache-Control", "no-store");
      return response.status(200).json({ ...runtimeCache.payload, cached: true, warning: "Canlı tarama başarısız; son önbellek gösteriliyor." });
    }
    return response.status(503).json({ error: error?.message || "SOL Meme Trenches taraması şu anda kullanılamıyor." });
  }
}

export { classifyPair, preScore, securitySnapshot, volumeSnapshot };
