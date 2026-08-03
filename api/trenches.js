const CACHE_MS = 10 * 60 * 1000;
const DISCOVERY_LIMIT = 27;
const REPORT_LIMIT = 12;
const REQUEST_TIMEOUT_MS = 8500;
const GREEN_SCORE_MIN = 76;
const MIN_GREEN_AGE_HOURS = 6;
const HIGH_RUGCHECK_RISK = 70;

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

function securitySnapshot(report) {
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
      riskWarningCount: 0,
      riskDangerCount: 0,
      creatorRugHistory: false,
      copycat: false,
      lowLiquidityWarning: false,
      rugged: false,
      graphInsiders: 0,
      uniqueTraders: null,
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
  const lockValues = [
    ...(report?.lpLockedPct === null || report?.lpLockedPct === undefined ? [] : [Number(report.lpLockedPct)]),
    ...(Array.isArray(report?.markets) ? report.markets : []).map((market) => Number(market?.lp?.lpLockedPct))
  ]
    .filter(Number.isFinite);
  const lpLockedPct = lockValues.length ? Math.max(...lockValues) : null;
  const risks = Array.isArray(report?.risks) ? report.risks : [];
  const riskText = risks.map((risk) => `${risk?.name || ""} ${risk?.description || ""} ${risk?.value || ""}`).join(" ").toLowerCase();
  const bundled = /bundl/.test(riskText) ? "flagged" : "clear";
  const wash = /wash trad/.test(riskText) ? "flagged" : "clear";
  const devSale = /(creator|developer|dev).{0,30}(sell|sold|dump)/.test(riskText) ? "flagged" : "clear";
  const creatorRugHistory = /(creator|developer|dev).{0,45}(rug|scam)|history.{0,45}(rug|scam)/.test(riskText);
  const copycat = /copycat|impersonat/.test(riskText);
  const lowLiquidityWarning = /low liquidity|low amount of lp|few lp provider/.test(riskText);
  const riskDangerCount = risks.filter((risk) => String(risk?.level || "").toLowerCase() === "danger").length;
  const normalizedRiskScore = report?.score_normalised === null || report?.score_normalised === undefined
    ? Number.NaN
    : Number(report.score_normalised);
  const riskScore = Number.isFinite(normalizedRiskScore) ? clamp(normalizedRiskScore, 0, 100) : null;
  const notable = risks
    .slice()
    .sort((a, b) => number(b?.score) - number(a?.score))[0];

  return {
    verified: mint !== "unknown" && freeze !== "unknown" && holders.length > 0 && riskScore !== null,
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
    riskScore,
    riskWarningCount: risks.length,
    riskDangerCount,
    creatorRugHistory,
    copycat,
    lowLiquidityWarning,
    rugged: report?.rugged === true,
    graphInsiders: number(report?.graphInsidersDetected),
    uniqueTraders: null,
    notableRisk: notable?.name || (lpLockedPct === null ? "LP kilidi Doğrulanmadı" : "Belirgin RugCheck uyarısı yok")
  };
}

function volumeSnapshot(pair, ageHours = null) {
  const m5 = number(pair?.volume?.m5);
  const h1 = number(pair?.volume?.h1);
  const h6 = number(pair?.volume?.h6);
  const h24 = number(pair?.volume?.h24);
  const pace5 = m5 * 12;
  const previous5hPace = Math.max(h6 - h1, 0) / 5;
  const previous18hPace = Math.max(h24 - h6, 0) / 18;
  let trend = "steady";
  if (ageHours === null || ageHours < 1) {
    trend = "unconfirmed";
  } else if (ageHours < 6) {
    if (pace5 > Math.max(h1, 1) * 1.2) trend = "rising";
    else if (pace5 < Math.max(h1, 1) * 0.42) trend = "falling";
  } else if (pace5 > Math.max(h1, 1) * 1.12 && h1 > Math.max(previous5hPace, 1) * 1.08) {
    trend = "rising";
  } else if (h1 < Math.max(previous5hPace, 1) * 0.68 || previous5hPace < Math.max(previous18hPace, 1) * 0.62) {
    trend = "falling";
  }

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

function logarithmicScore(value, floor, ceiling, points) {
  if (!Number.isFinite(value) || value <= floor) return 0;
  if (value >= ceiling) return points;
  const progress = (Math.log(value) - Math.log(floor)) / (Math.log(ceiling) - Math.log(floor));
  return clamp(progress * points, 0, points);
}

function qualityMarketScore(marketCap) {
  if (!marketCap) return 2;
  return clamp(8 - Math.abs(Math.log10(Math.max(marketCap, 1)) - 6) * 1.8, 2, 8);
}

function qualityScore({ marketCap, liquidity, lpRatio, ageHours, volume, txns, price, security, priceVolumeDivergence }) {
  const liquidityScore = logarithmicScore(liquidity, 5000, 200000, 12)
    + clamp((lpRatio - 0.004) / (0.03 - 0.004) * 8, 0, 8);

  const turnover24h = marketCap ? volume.h24 / marketCap : 0;
  const recentLiquidityTurnover = liquidity ? volume.h1 / liquidity : 0;
  const trendScore = volume.trend === "rising" ? 4 : volume.trend === "steady" ? 3 : 0;
  const volumeScore = logarithmicScore(volume.h24, 5000, 1000000, 8)
    + logarithmicScore(turnover24h, 0.03, 1.2, 8)
    + logarithmicScore(recentLiquidityTurnover, 0.03, 1.2, 4)
    + trendScore;

  const buyRatio = txns.h1.buyRatio;
  const balanceScore = txns.h1.total
    ? clamp(6 - Math.max(0, Math.abs(buyRatio - 0.55) - 0.05) * 35, 0, 6)
    : 0;
  const transactionScore = logarithmicScore(txns.h1.total, 20, 1500, 8) + balanceScore;

  const ageScore = ageHours === null ? 0
    : ageHours < 1 ? 0
      : ageHours < 6 ? 2
        : ageHours < 24 ? 5
          : ageHours < 720 ? 8
            : 10;

  let priceHealthScore = 10;
  if (priceVolumeDivergence) priceHealthScore -= 6;
  if (price.h6 <= -35) priceHealthScore -= 3;
  if (price.h24 <= -50) priceHealthScore -= 3;
  if (price.h6 >= 120) priceHealthScore -= 2;
  if (price.h24 >= 250) priceHealthScore -= 2;
  if (volume.trend === "falling") priceHealthScore -= 2;
  priceHealthScore = clamp(priceHealthScore, 0, 10);

  const riskQuality = security.riskScore === null ? 0
    : security.riskScore <= 20 ? 3
      : security.riskScore <= 40 ? 2
        : security.riskScore <= 60 ? 1
          : 0;
  let securityScore = (security.verified ? 4 : 0)
    + (security.mint === "revoked" ? 2 : 0)
    + (security.freeze === "revoked" ? 2 : 0)
    + (security.lpLockedPct !== null && security.lpLockedPct >= 80 ? 3 : 0)
    + riskQuality;
  securityScore -= Math.min(4, security.riskWarningCount * 2);
  if (security.copycat) securityScore -= 3;
  if (security.lowLiquidityWarning) securityScore -= 2;
  if (security.creatorRugHistory) securityScore -= 6;
  if (security.graphInsiders > 10) securityScore -= clamp(security.graphInsiders / 20, 1, 5);
  if (security.top1Pct !== null && security.top1Pct > 12) securityScore -= 2;
  if (security.top10Pct !== null && security.top10Pct > 45) securityScore -= 2;
  if (security.insiderPct !== null && security.insiderPct > 5) securityScore -= 3;
  securityScore = clamp(securityScore, 0, 14);

  const components = {
    liquidity: liquidityScore,
    volume: volumeScore,
    transactions: transactionScore,
    market: qualityMarketScore(marketCap),
    age: ageScore,
    priceHealth: priceHealthScore,
    security: securityScore
  };
  const score = Math.round(clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));
  return {
    score,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value)]))
  };
}

function classifyPair(pair, report, discovery) {
  const marketCap = number(pair?.marketCap) || number(pair?.fdv);
  const liquidity = number(pair?.liquidity?.usd) || number(report?.totalMarketLiquidity);
  const ageHours = pair?.pairCreatedAt ? Math.max(0, (Date.now() - number(pair.pairCreatedAt)) / 3600000) : null;
  const volume = volumeSnapshot(pair, ageHours);
  const txns = transactionSnapshot(pair);
  const price = {
    h1: number(pair?.priceChange?.h1),
    h6: number(pair?.priceChange?.h6),
    h24: number(pair?.priceChange?.h24)
  };
  const security = securitySnapshot(report);
  const lpRatio = marketCap ? liquidity / marketCap : 0;
  const criticalLpFloor = marketCap ? Math.max(5000, Math.min(30000, marketCap * 0.005)) : 6000;
  const greenLpFloor = marketCap ? Math.max(15000, Math.min(120000, marketCap * 0.015)) : 20000;
  const unsupportedSpike = price.h6 > 100 && (volume.trend === "falling" || (marketCap && volume.h6 / marketCap < 0.12));
  const priceVolumeDivergence = (price.h6 > 35 && volume.trend === "falling")
    || (price.h6 < -30 && volume.trend === "falling")
    || (Math.abs(price.h24) > 90 && marketCap && volume.h24 / marketCap < 0.18);
  const severeSelloff = price.h6 <= -65 || price.h24 <= -80;
  const hardReasons = [];

  if (security.rugged) hardReasons.push("RugCheck rugged işareti");
  if (security.contradictory) hardReasons.push("Çelişkili güvenlik verisi");
  if (security.mint === "open") hardReasons.push("Mint authority açık");
  if (security.freeze === "open") hardReasons.push("Freeze authority açık");
  if (liquidity < criticalLpFloor || lpRatio > 0 && lpRatio < 0.003) hardReasons.push("Likidite çok düşük");
  if (security.top1Pct !== null && security.top1Pct > 22) hardReasons.push("Tek holder yoğunluğu aşırı");
  if (security.top10Pct !== null && security.top10Pct > 65) hardReasons.push("Top holder yoğunluğu aşırı");
  if (security.insiderPct !== null && security.insiderPct > 15) hardReasons.push("Insider yoğunluğu yüksek");
  if (security.bundled === "flagged") hardReasons.push("Bundled buy işareti");
  if (security.wash === "flagged") hardReasons.push("Wash trading işareti");
  if (security.devSale === "flagged") hardReasons.push("Geliştirici satışı işareti");
  if (security.creatorRugHistory) hardReasons.push("Geliştiricinin rug geçmişi");
  if (security.graphInsiders >= 100) hardReasons.push("Cluster/insider yoğunluğu aşırı");
  if (unsupportedSpike) hardReasons.push("Hacimsiz dik fiyat hareketi");
  if (severeSelloff) hardReasons.push("Şiddetli fiyat çöküşü");
  if (security.riskScore !== null && security.riskScore >= HIGH_RUGCHECK_RISK) hardReasons.push("Yüksek RugCheck risk skoru");

  const cautionReasons = [];
  if (!security.verified) cautionReasons.push("Güvenlik verisi Doğrulanmadı");
  if (security.lpLockedPct === null) cautionReasons.push("LP kilidi Doğrulanmadı");
  else if (security.lpLockedPct < 80) cautionReasons.push("LP kilidi yetersiz");
  if (ageHours === null) cautionReasons.push("Token yaşı Doğrulanmadı");
  else if (ageHours < MIN_GREEN_AGE_HOURS) cautionReasons.push("Token çok yeni");
  if (liquidity < greenLpFloor || lpRatio > 0 && lpRatio < 0.01) cautionReasons.push("Yeşil için likidite yetersiz");
  if (volume.trend === "falling") cautionReasons.push("Kısa vadeli hacim zayıflıyor");
  if (volume.trend === "unconfirmed") cautionReasons.push("Hacim geçmişi yetersiz");
  if (txns.h1.total < 30) cautionReasons.push("İşlem sayısı yetersiz");
  if (txns.h1.total && (txns.h1.buyRatio < 0.42 || txns.h1.buyRatio > 0.70)) cautionReasons.push("Alış/satış dengesi zayıf");
  if (priceVolumeDivergence) cautionReasons.push("Fiyat/hacim uyumsuzluğu");
  if (price.h6 <= -25 || price.h24 <= -40) cautionReasons.push("Sert fiyat kaybı");
  if (price.h6 >= 100 || price.h24 >= 200) cautionReasons.push("Aşırı fiyat oynaklığı");
  if (security.riskScore === null) cautionReasons.push("RugCheck puanı Doğrulanmadı");
  else if (security.riskScore > 30) cautionReasons.push("RugCheck riski düşük değil");
  if (security.riskWarningCount > 0) cautionReasons.push(`RugCheck: ${security.notableRisk}`);
  if (security.top1Pct !== null && security.top1Pct > 12) cautionReasons.push("Tek holder yoğunluğu yüksek");
  if (security.top10Pct !== null && security.top10Pct > 45) cautionReasons.push("Top holder yoğunluğu yüksek");
  if (security.insiderPct !== null && security.insiderPct > 5) cautionReasons.push("Insider yoğunluğu dikkat istiyor");
  if (security.graphInsiders > 10) cautionReasons.push("Cluster/insider sayısı yüksek");

  const quality = qualityScore({
    marketCap,
    liquidity,
    lpRatio,
    ageHours,
    volume,
    txns,
    price,
    security,
    priceVolumeDivergence
  });
  const hardPenalty = Math.min(36, hardReasons.length * 12);
  const score = Math.round(clamp(quality.score - hardPenalty, 0, 100));

  let decision = "yellow";
  if (hardReasons.length) decision = "red";
  else if (score >= GREEN_SCORE_MIN && cautionReasons.length === 0) decision = "green";

  const volumeComment = volume.trend === "rising"
    ? "hacim kademeli ivmeleniyor"
    : volume.trend === "falling"
      ? "kısa vadeli hacim zayıflıyor"
      : volume.trend === "unconfirmed"
        ? "hacim geçmişi henüz yetersiz"
        : "hacim dengeli seyrediyor";
  const importantRisk = !security.verified
    ? "güvenlik verisi Doğrulanmadı"
    : cautionReasons[0]
      || (security.notableRisk === "Belirgin RugCheck uyarısı yok"
        ? "benzersiz trader sayısı Doğrulanmadı"
        : security.notableRisk);

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
    scoreBreakdown: { ...quality.components, hardPenalty: -hardPenalty },
    decision,
    decisionLabel: decision === "green" ? "🟢 İzlemeye değer" : decision === "yellow" ? "🟡 Şartlı izleme" : "🔴 Elendi",
    reason: `${volumeComment}; Mint ${security.mint === "revoked" ? "✅" : "⚠️"} Freeze ${security.freeze === "revoked" ? "✅" : "⚠️"} LP ${security.lpLockedPct !== null && security.lpLockedPct >= 80 && liquidity >= greenLpFloor ? "✅" : "⚠️"}; ${importantRisk}`,
    hardReasons,
    cautionReasons,
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
    modelVersion: 2,
    generatedAt: new Date().toISOString(),
    autoRefreshMs: 16 * 60 * 1000,
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

export { classifyPair, preScore, qualityScore, securitySnapshot, volumeSnapshot };
