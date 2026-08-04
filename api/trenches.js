const CACHE_MS = 10 * 60 * 1000;
const DISCOVERY_LIMIT = 60;
const DEX_BATCH_LIMIT = 30;
const REPORT_LIMIT = 24;
const VISIBLE_LIMIT = 12;
const BUBBLEMAPS_LIMIT = 16;
const BIRDEYE_LIMIT = 12;
const GOPLUS_LIMIT = 16;
const REQUEST_TIMEOUT_MS = 8500;
const SOURCE_CACHE_MS = 10 * 60 * 1000;
const GREEN_SCORE_MIN = 76;
const MIN_GREEN_AGE_HOURS = 6;
const HIGH_RUGCHECK_RISK = 70;
const BUBBLEMAPS_API_KEY = typeof process !== "undefined"
  ? String(process.env?.BUBBLEMAPS_API_KEY || "").trim()
  : "";
const BIRDEYE_API_KEY = typeof process !== "undefined"
  ? String(process.env?.BIRDEYE_API_KEY || "").trim()
  : "";
const GOPLUS_API_TOKEN = typeof process !== "undefined"
  ? String(process.env?.GOPLUS_API_TOKEN || "").trim()
  : "";
const HELIUS_API_KEY = typeof process !== "undefined"
  ? String(process.env?.HELIUS_API_KEY || "").trim()
  : "";
const SOLANA_RPC_URL = typeof process !== "undefined"
  ? String(process.env?.SOLANA_RPC_URL || "").trim()
  : "";
const ONCHAIN_RPC_URL = SOLANA_RPC_URL || (HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}`
  : "");

let runtimeCache = { updatedAt: 0, payload: null };
const sourceCache = new Map();

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const addressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function fetchJson(url, timeout = REQUEST_TIMEOUT_MS, extraHeaders = {}, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "MUS-Terminal/1.0", ...(init.headers || {}), ...extraHeaders }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cachedSource(key, worker, ttl = SOURCE_CACHE_MS) {
  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.updatedAt < ttl) return hit.value;
  const value = await worker();
  if (value?.ok || value?.verified) sourceCache.set(key, { updatedAt: Date.now(), value });
  return value;
}

async function settleJson(url, options = {}) {
  try {
    return {
      ok: true,
      data: await fetchJson(url, options.timeout || REQUEST_TIMEOUT_MS, options.headers || {}, options.init || {})
    };
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

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function responseData(payload) {
  if (payload?.data && typeof payload.data === "object") return payload.data;
  if (payload?.result && typeof payload.result === "object") return payload.result;
  return payload || {};
}

function providerPercent(value, fraction = false) {
  const parsed = optionalNumber(value);
  if (parsed === null) return null;
  return fraction && parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function providerStatus(value) {
  if (value === undefined || value === null || value === "") return "unknown";
  const normalized = String(value).toLowerCase();
  if (["1", "true", "open", "enabled", "available"].includes(normalized)) return "open";
  if (["0", "false", "closed", "disabled", "revoked"].includes(normalized)) return "revoked";
  return "unknown";
}

function emptyBirdeyeSnapshot(requested = false) {
  return {
    requested,
    verified: false,
    top1Pct: null,
    top10Pct: null,
    holderCount: null,
    firstBuyersVerified: false,
    firstBuyerCount: 0,
    bundlerCount: 0,
    insiderCount: 0,
    devCount: 0,
    sniperCount: 0,
    smartTraderCount: 0,
    buyMoreCount: 0,
    holdCount: 0,
    sellPartialCount: 0,
    sellAllCount: 0,
    bundledRatio: null,
    notableRisk: requested ? "Birdeye verisi Doğrulanmadı" : "Birdeye etkin değil"
  };
}

function parseBirdeyeHolder(payload) {
  const data = responseData(payload);
  const summary = data?.summary || data?.stats || {};
  const holders = firstArray(data?.items, data?.holders, data?.list, data?.data);
  const percentages = holders
    .map((holder) => providerPercent(holder?.percent_of_supply ?? holder?.percentage ?? holder?.percent ?? holder?.pct))
    .filter((value) => value !== null);
  const top1Pct = percentages.length ? Math.max(...percentages) : null;
  const summaryPct = providerPercent(summary?.percent_of_supply ?? summary?.percentage ?? summary?.percent);
  const top10Pct = summaryPct !== null ? summaryPct : percentages.length ? percentages.reduce((sum, value) => sum + value, 0) : null;
  return {
    verified: top10Pct !== null || holders.length > 0,
    top1Pct,
    top10Pct,
    holderCount: optionalNumber(summary?.wallet_count ?? summary?.holder_count ?? summary?.count)
  };
}

function parseBirdeyeFirstBuyers(payload) {
  const data = responseData(payload);
  const summary = data?.summary || data?.stats || {};
  const buyers = firstArray(data?.items, data?.buyers, data?.first_buyers, data?.list);
  const tagCounts = { bundler: 0, insider: 0, dev: 0, sniper: 0, smartTrader: 0 };
  const statusCounts = { buyMore: 0, hold: 0, sellPartial: 0, sellAll: 0 };
  for (const buyer of buyers) {
    const tags = [buyer?.tag, buyer?.tags, buyer?.labels, buyer?.wallet_tags]
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    for (const key of ["bundler", "insider", "dev", "sniper"]) {
      if (tags.includes(key)) tagCounts[key] += 1;
    }
    if (tags.includes("smart_trader") || tags.includes("smart trader")) tagCounts.smartTrader += 1;
    const status = String(buyer?.position_status ?? buyer?.positionStatus ?? buyer?.status ?? "").toLowerCase();
    if (status === "buy_more") statusCounts.buyMore += 1;
    else if (status === "hold") statusCounts.hold += 1;
    else if (status === "sell_partial") statusCounts.sellPartial += 1;
    else if (status === "sell_all") statusCounts.sellAll += 1;
  }
  const summaryCount = optionalNumber(summary?.total_count ?? summary?.count ?? summary?.buyer_count);
  const firstBuyerCount = buyers.length || summaryCount || 0;
  return {
    verified: buyers.length > 0 || summaryCount !== null,
    firstBuyerCount,
    bundlerCount: tagCounts.bundler,
    insiderCount: tagCounts.insider,
    devCount: tagCounts.dev,
    sniperCount: tagCounts.sniper,
    smartTraderCount: tagCounts.smartTrader,
    buyMoreCount: statusCounts.buyMore,
    holdCount: statusCounts.hold,
    sellPartialCount: statusCounts.sellPartial,
    sellAllCount: statusCounts.sellAll,
    bundledRatio: firstBuyerCount ? tagCounts.bundler / firstBuyerCount : null
  };
}

async function fetchBirdeye(address) {
  if (!BIRDEYE_API_KEY) return { holder: emptyBirdeyeSnapshot(false), firstBuyers: emptyBirdeyeSnapshot(false) };
  return cachedSource(`birdeye:${address}`, async () => {
    const query = new URLSearchParams({
      token_address: address,
      address_type: "wallet",
      mode: "top",
      top_n: "10",
      include_list: "true",
      limit: "10"
    });
    const headers = { "X-API-KEY": BIRDEYE_API_KEY, "x-chain": "solana" };
    const [holderResult, buyersResult] = await Promise.all([
      settleJson(`https://public-api.birdeye.so/holder/v1/distribution?${query}`, { headers }),
      settleJson(`https://public-api.birdeye.so/token/v1/first-buyers?token_address=${encodeURIComponent(address)}&offset=0&limit=50`, { headers })
    ]);
    return {
      ok: holderResult.ok || buyersResult.ok,
      holder: holderResult.ok ? parseBirdeyeHolder(holderResult.data) : emptyBirdeyeSnapshot(true),
      firstBuyers: buyersResult.ok ? parseBirdeyeFirstBuyers(buyersResult.data) : { verified: false, firstBuyerCount: 0, bundlerCount: 0, insiderCount: 0, devCount: 0, sniperCount: 0, smartTraderCount: 0, buyMoreCount: 0, holdCount: 0, sellPartialCount: 0, sellAllCount: 0, bundledRatio: null }
    };
  });
}

function parseGoplus(payload, address) {
  const data = responseData(payload);
  const token = data?.[address] || data?.[address.toLowerCase()] || (data?.token_security && (data.token_security[address] || data.token_security[address.toLowerCase()])) || (Array.isArray(data) ? data[0] : data);
  if (!token || typeof token !== "object") return { verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, creatorMalicious: false, transferHookMalicious: false, notableRisk: "GoPlus verisi Doğrulanmadı" };
  const holders = firstArray(token?.holders, token?.top_holders).map((holder) => providerPercent(holder?.percent, true)).filter((value) => value !== null);
  const lpHolders = firstArray(token?.lp_holders, token?.lpHolders);
  const lpLockedPct = lpHolders.length
    ? lpHolders.filter((holder) => providerStatus(holder?.is_locked) === "open").reduce((sum, holder) => sum + (providerPercent(holder?.percent, true) || 0), 0)
    : null;
  const risks = [
    token?.other_potential_risks,
    token?.note,
    token?.transfer_hook?.malicious_address === "1" ? "malicious transfer hook" : "",
    token?.creator?.malicious_address === "1" ? "malicious creator" : ""
  ].filter(Boolean).join(" ");
  const mint = providerStatus(token?.mintable?.status ?? token?.mintable);
  const freeze = providerStatus(token?.freezable?.status ?? token?.freezable);
  return {
    verified: Boolean(token?.metadata || token?.mintable || token?.freezable || holders.length || token?.dexname),
    mint,
    freeze,
    top1Pct: holders.length ? Math.max(...holders) : null,
    top10Pct: holders.length ? holders.reduce((sum, value) => sum + value, 0) : null,
    lpLockedPct,
    creatorMalicious: String(token?.creator?.malicious_address || "") === "1",
    transferHookMalicious: String(token?.transfer_hook?.malicious_address || "") === "1",
    metadataMutable: providerStatus(token?.metadata_mutable?.status ?? token?.metadata_mutable),
    transferFeeRate: optionalNumber(token?.transfer_fee?.current_fee_rate),
    notableRisk: risks || "Belirgin GoPlus uyarısı yok"
  };
}

async function fetchGoplus(address) {
  if (!GOPLUS_API_TOKEN) return { verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, notableRisk: "GoPlus etkin değil" };
  return cachedSource(`goplus:${address}`, async () => {
    const authorization = GOPLUS_API_TOKEN.toLowerCase().startsWith("bearer ")
      ? GOPLUS_API_TOKEN
      : `Bearer ${GOPLUS_API_TOKEN}`;
    const result = await settleJson(
      `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`,
      { headers: { Authorization: authorization } }
    );
    return result.ok ? { ok: true, ...parseGoplus(result.data, address) } : { ok: false, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, notableRisk: "GoPlus verisi Doğrulanmadı" };
  });
}

function parseMintAuthorities(accountInfo) {
  const raw = accountInfo?.value?.data;
  if (!Array.isArray(raw) || raw[1] !== "base64" || typeof Buffer === "undefined") return { mint: "unknown", freeze: "unknown" };
  const bytes = Buffer.from(raw[0], "base64");
  if (bytes.length < 82) return { mint: "unknown", freeze: "unknown" };
  const optionAt = (offset) => bytes.readUInt32LE(offset) === 0 ? "revoked" : "open";
  return { mint: optionAt(0), freeze: optionAt(46) };
}

async function fetchOnchain(address) {
  if (!ONCHAIN_RPC_URL) return { verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, notableRisk: "On-chain doğrulama etkin değil" };
  return cachedSource(`onchain:${address}`, async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [address] },
      { jsonrpc: "2.0", id: 2, method: "getTokenSupply", params: [address] },
      { jsonrpc: "2.0", id: 3, method: "getAccountInfo", params: [address, { encoding: "base64" }] }
    ];
    const result = await settleJson(ONCHAIN_RPC_URL, {
      timeout: 8000,
      headers: { "Content-Type": "application/json" },
      init: { method: "POST", body: JSON.stringify(batch) }
    });
    if (!result.ok || !Array.isArray(result.data)) return { ok: false, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, notableRisk: "On-chain verisi Doğrulanmadı" };
    const byId = new Map(result.data.map((item) => [item.id, item.result]));
    const supply = byId.get(2)?.value;
    const decimals = Number(supply?.decimals);
    const total = optionalNumber(supply?.uiAmountString ?? supply?.uiAmount);
    const accounts = Array.isArray(byId.get(1)?.value) ? byId.get(1).value : [];
    const amounts = accounts.map((item) => {
      const ui = optionalNumber(item?.uiAmountString ?? item?.uiAmount);
      if (ui !== null) return ui;
      const rawAmount = optionalNumber(item?.amount);
      return rawAmount !== null && Number.isFinite(decimals) ? rawAmount / (10 ** decimals) : null;
    }).filter((value) => value !== null);
    const top1Pct = total && amounts.length ? amounts[0] / total * 100 : null;
    const top10Pct = total && amounts.length ? amounts.slice(0, 10).reduce((sum, value) => sum + value, 0) / total * 100 : null;
    const authorities = parseMintAuthorities(byId.get(3));
    return { ok: true, verified: top10Pct !== null || authorities.mint !== "unknown" || authorities.freeze !== "unknown", ...authorities, top1Pct, top10Pct, notableRisk: "On-chain doğrulama mevcut" };
  });
}

function bubblemapsSnapshot(metrics, requested = false) {
  const scores = metrics?.scores || metrics?.metrics?.scores || null;
  const rawScore = optionalNumber(scores?.bubblemaps_score);
  const rawGini = optionalNumber(scores?.gini_index);
  const rawHhi = optionalNumber(scores?.herfindahl_hirschman_index);
  const rawNakamoto = optionalNumber(scores?.nakamoto_coefficient);
  const score = rawScore !== null && rawScore >= 0 && rawScore <= 100
    ? clamp(rawScore <= 1 ? rawScore * 100 : rawScore, 0, 100)
    : null;

  return {
    requested,
    verified: Boolean(scores) && score !== null,
    score,
    giniIndex: rawGini,
    hhi: rawHhi,
    nakamotoCoefficient: rawNakamoto,
    notableRisk: !requested
      ? "Bubblemaps etkin değil"
      : score === null
        ? "Bubblemaps verisi Doğrulanmadı"
        : score < 25
          ? "Holder dağılım skoru çok düşük"
          : score < 45
            ? "Holder dağılım skoru zayıf"
            : rawNakamoto !== null && rawNakamoto <= 3
              ? "Nakamoto katsayısı düşük"
              : "Belirgin Bubblemaps dağılım uyarısı yok"
  };
}

function bubblemapsAssessment(snapshot, security) {
  const hardReasons = [];
  const cautionReasons = [];
  let adjustment = 0;

  if (!snapshot.requested) return { adjustment, hardReasons, cautionReasons };
  if (!snapshot.verified) {
    cautionReasons.push("Bubblemaps verisi Doğrulanmadı");
    return { adjustment, hardReasons, cautionReasons };
  }

  if (snapshot.score < 25) {
    adjustment -= 8;
    cautionReasons.push("Bubblemaps holder dağılımı çok zayıf");
  } else if (snapshot.score < 45) {
    adjustment -= 4;
    cautionReasons.push("Bubblemaps holder dağılımı zayıf");
  } else if (snapshot.score >= 75) {
    adjustment += 4;
  }

  if (snapshot.nakamotoCoefficient !== null && snapshot.nakamotoCoefficient <= 2) {
    adjustment -= 6;
    cautionReasons.push("Bubblemaps Nakamoto katsayısı çok düşük");
  } else if (snapshot.nakamotoCoefficient !== null && snapshot.nakamotoCoefficient <= 5) {
    adjustment -= 2;
    cautionReasons.push("Bubblemaps Nakamoto katsayısı düşük");
  }

  const corroboratedConcentration = (security.top10Pct !== null && security.top10Pct > 45)
    || (security.insiderPct !== null && security.insiderPct > 5)
    || security.graphInsiders > 10;
  if (snapshot.score < 20 && snapshot.nakamotoCoefficient !== null
      && snapshot.nakamotoCoefficient <= 2 && corroboratedConcentration) {
    hardReasons.push("Bubblemaps ve RugCheck holder yoğunluğu aşırı");
  }

  return { adjustment: clamp(adjustment, -14, 4), hardReasons, cautionReasons };
}

function authorityState(...values) {
  const present = values.filter((value) => value !== undefined);
  if (!present.length) return "unknown";
  if (present.some((value) => value !== null && value !== "")) return "open";
  return "revoked";
}

function contradictoryAuthority(...values) {
  const present = values
    .filter((value) => value !== undefined)
    .map((value) => value === null || value === "" ? null : value);
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
  const holders = (Array.isArray(report?.topHolders) ? report.topHolders : [])
    .filter((holder) => !knownNonHolder(report, holder))
    .sort((a, b) => number(b?.pct) - number(a?.pct));
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

function mergeSecuritySources(security, sources = {}) {
  const holder = sources?.birdeye?.holder || emptyBirdeyeSnapshot(Boolean(BIRDEYE_API_KEY));
  const firstBuyers = sources?.birdeye?.firstBuyers || {};
  const birdeye = {
    ...emptyBirdeyeSnapshot(Boolean(BIRDEYE_API_KEY)),
    ...holder,
    ...firstBuyers,
    holderVerified: Boolean(holder.verified),
    firstBuyersVerified: Boolean(firstBuyers.verified),
    verified: Boolean(holder.verified || firstBuyers.verified)
  };
  const goplus = sources?.goplus || { verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, notableRisk: GOPLUS_API_TOKEN ? "GoPlus verisi Doğrulanmadı" : "GoPlus etkin değil" };
  const onchain = sources?.onchain || { verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, notableRisk: ONCHAIN_RPC_URL ? "On-chain verisi Doğrulanmadı" : "On-chain doğrulama etkin değil" };
  const authoritySources = [security.mint, security.freeze, birdeye.mint, birdeye.freeze, goplus.mint, goplus.freeze, onchain.mint, onchain.freeze]
    .filter((value) => value && value !== "unknown");
  const mintValues = [security.mint, goplus.mint, onchain.mint].filter((value) => value && value !== "unknown");
  const freezeValues = [security.freeze, goplus.freeze, onchain.freeze].filter((value) => value && value !== "unknown");
  const authorityConflict = new Set(mintValues).size > 1 || new Set(freezeValues).size > 1;
  const resolvedMint = mintValues.includes("open") ? "open" : mintValues.includes("revoked") ? "revoked" : "unknown";
  const resolvedFreeze = freezeValues.includes("open") ? "open" : freezeValues.includes("revoked") ? "revoked" : "unknown";
  // RPC largest-account data is a useful cross-check, but may include LP or
  // program-owned token accounts that providers exclude from holder metrics.
  // Keep it out of the contradiction test to avoid false eliminations.
  const holderValues = [security.top10Pct, birdeye.top10Pct, goplus.top10Pct].filter((value) => value !== null && value !== undefined);
  const holderConflict = holderValues.length >= 2 && Math.max(...holderValues) - Math.min(...holderValues) > 25;
  const externalVerifiedCount = [birdeye.verified, goplus.verified, onchain.verified].filter(Boolean).length;
  const compositeVerified = !authorityConflict && !holderConflict
    && (security.verified && externalVerifiedCount >= 1 || externalVerifiedCount >= 2);

  return {
    ...security,
    mint: resolvedMint,
    freeze: resolvedFreeze,
    birdeye,
    goplus,
    onchain,
    authoritySources,
    externalVerifiedCount,
    compositeVerified,
    crossSourceConflict: authorityConflict || holderConflict,
    effectiveTop1Pct: Math.max(...[security.top1Pct, birdeye.top1Pct, goplus.top1Pct].filter((value) => value !== null && value !== undefined), 0),
    effectiveTop10Pct: Math.max(...[security.top10Pct, birdeye.top10Pct, goplus.top10Pct].filter((value) => value !== null && value !== undefined), 0),
    notableRisk: security.verified ? security.notableRisk : birdeye.verified ? "Birdeye holder verisi mevcut" : goplus.verified ? goplus.notableRisk : onchain.notableRisk
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
  if (security.birdeye?.holderVerified) securityScore += 1;
  if (security.goplus?.verified) securityScore += 2;
  if (security.onchain?.verified) securityScore += 1;
  if (security.compositeVerified) securityScore += 2;
  securityScore -= Math.min(4, security.riskWarningCount * 2);
  if (security.copycat) securityScore -= 3;
  if (security.lowLiquidityWarning) securityScore -= 2;
  if (security.creatorRugHistory) securityScore -= 6;
  if (security.graphInsiders > 10) securityScore -= clamp(security.graphInsiders / 20, 1, 5);
  if (security.top1Pct !== null && security.top1Pct > 12) securityScore -= 2;
  if (security.top10Pct !== null && security.top10Pct > 45) securityScore -= 2;
  if (security.insiderPct !== null && security.insiderPct > 5) securityScore -= 3;
  securityScore = clamp(securityScore, 0, 18);

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

function classifyPair(pair, report, discovery, bubblemapsMetrics = null, bubblemapsRequested = false, externalSources = {}) {
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
  const security = mergeSecuritySources(securitySnapshot(report), externalSources);
  const bubblemaps = bubblemapsSnapshot(bubblemapsMetrics, bubblemapsRequested);
  const bubbleAssessment = bubblemapsAssessment(bubblemaps, security);
  const lpRatio = marketCap ? liquidity / marketCap : 0;
  const effectiveLpLockedPct = security.lpLockedPct !== null ? security.lpLockedPct : security.goplus?.lpLockedPct;
  const criticalLpFloor = marketCap ? Math.max(5000, Math.min(30000, marketCap * 0.005)) : 6000;
  const greenLpFloor = marketCap ? Math.max(15000, Math.min(120000, marketCap * 0.015)) : 20000;
  const unsupportedSpike = price.h6 > 100 && (volume.trend === "falling" || (marketCap && volume.h6 / marketCap < 0.12));
  const priceVolumeDivergence = (price.h6 > 35 && volume.trend === "falling")
    || (price.h6 < -30 && volume.trend === "falling")
    || (Math.abs(price.h24) > 90 && marketCap && volume.h24 / marketCap < 0.18);
  const severeSelloff = price.h6 <= -65 || price.h24 <= -80;
  const hardReasons = [];

  if (security.rugged) hardReasons.push("RugCheck rugged işareti");
  if (security.contradictory || security.crossSourceConflict) hardReasons.push("Çelişkili güvenlik verisi");
  if (security.mint === "open") hardReasons.push("Mint authority açık");
  if (security.freeze === "open") hardReasons.push("Freeze authority açık");
  if (security.goplus?.mint === "open") hardReasons.push("GoPlus mintable açık");
  if (security.goplus?.freeze === "open") hardReasons.push("GoPlus freezable açık");
  if (security.goplus?.creatorMalicious) hardReasons.push("GoPlus kötü niyetli geliştirici işareti");
  if (security.goplus?.transferHookMalicious) hardReasons.push("GoPlus kötü niyetli transfer hook");
  if (liquidity < criticalLpFloor || lpRatio > 0 && lpRatio < 0.003) hardReasons.push("Likidite çok düşük");
  if (security.effectiveTop1Pct > 22) hardReasons.push("Tek holder yoğunluğu aşırı");
  if (security.effectiveTop10Pct > 65) hardReasons.push("Top holder yoğunluğu aşırı");
  if (security.insiderPct !== null && security.insiderPct > 15) hardReasons.push("Insider yoğunluğu yüksek");
  if (security.bundled === "flagged") hardReasons.push("Bundled buy işareti");
  if (security.birdeye?.bundledRatio !== null && security.birdeye.bundledRatio >= 0.30) hardReasons.push("Birdeye bundled buy yoğunluğu yüksek");
  if (security.wash === "flagged") hardReasons.push("Wash trading işareti");
  if (security.devSale === "flagged") hardReasons.push("Geliştirici satışı işareti");
  if (security.creatorRugHistory) hardReasons.push("Geliştiricinin rug geçmişi");
  if (security.graphInsiders >= 100) hardReasons.push("Cluster/insider yoğunluğu aşırı");
  if (unsupportedSpike) hardReasons.push("Hacimsiz dik fiyat hareketi");
  if (severeSelloff) hardReasons.push("Şiddetli fiyat çöküşü");
  if (security.riskScore !== null && security.riskScore >= HIGH_RUGCHECK_RISK) hardReasons.push("Yüksek RugCheck risk skoru");
  hardReasons.push(...bubbleAssessment.hardReasons);

  const cautionReasons = [];
  if (!security.compositeVerified && !bubblemaps.verified) cautionReasons.push("Bağımsız güvenlik doğrulaması Doğrulanmadı");
  if (security.crossSourceConflict) cautionReasons.push("Güvenlik kaynakları çelişiyor");
  if (effectiveLpLockedPct === null) cautionReasons.push("LP kilidi Doğrulanmadı");
  else if (effectiveLpLockedPct < 80) cautionReasons.push("LP kilidi yetersiz");
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
  if (security.effectiveTop1Pct > 12) cautionReasons.push("Tek holder yoğunluğu yüksek");
  if (security.effectiveTop10Pct > 45) cautionReasons.push("Top holder yoğunluğu yüksek");
  if (security.insiderPct !== null && security.insiderPct > 5) cautionReasons.push("Insider yoğunluğu dikkat istiyor");
  if (security.graphInsiders > 10) cautionReasons.push("Cluster/insider sayısı yüksek");
  if (security.birdeye?.bundledRatio !== null && security.birdeye.bundledRatio >= 0.15 && security.birdeye.bundledRatio < 0.30) cautionReasons.push("Birdeye bundled buy oranı yüksek");
  if (security.birdeye?.devCount > 0 && security.birdeye.sellAllCount > 0) cautionReasons.push("Erken geliştirici/ilk alıcı çıkışı işareti");
  cautionReasons.push(...bubbleAssessment.cautionReasons);

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
  const score = Math.round(clamp(quality.score + bubbleAssessment.adjustment - hardPenalty, 0, 100));

  let decision = "yellow";
  if (hardReasons.length) decision = "red";
  else if (score >= GREEN_SCORE_MIN && cautionReasons.length === 0 && (security.compositeVerified || bubblemaps.verified)) decision = "green";

  const volumeComment = volume.trend === "rising"
    ? "hacim kademeli ivmeleniyor"
    : volume.trend === "falling"
      ? "kısa vadeli hacim zayıflıyor"
      : volume.trend === "unconfirmed"
        ? "hacim geçmişi henüz yetersiz"
        : "hacim dengeli seyrediyor";
  const importantRisk = !security.compositeVerified && !bubblemaps.verified
    ? "bağımsız güvenlik verisi Doğrulanmadı"
    : bubblemaps.requested && !bubblemaps.verified
      ? "Bubblemaps verisi Doğrulanmadı"
      : bubblemaps.verified && bubblemaps.notableRisk !== "Belirgin Bubblemaps dağılım uyarısı yok"
        ? bubblemaps.notableRisk
        : cautionReasons[0]
          || (security.notableRisk === "Belirgin RugCheck uyarısı yok"
            ? "benzersiz trader sayısı Doğrulanmadı"
            : security.notableRisk);

  return {
    address: pair.baseToken.address,
    symbol: String(pair?.baseToken?.symbol || discovery?.symbol || "?").slice(0, 12),
    name: String(pair?.baseToken?.name || "").slice(0, 60),
    marketCap,
    liquidity,
    volume,
    price,
    txns,
    ageHours,
    score,
    scoreBreakdown: { ...quality.components, bubblemaps: bubbleAssessment.adjustment, hardPenalty: -hardPenalty },
    decision,
    decisionLabel: decision === "green" ? "🟢 İzlemeye değer" : decision === "yellow" ? "🟡 Şartlı izleme" : "🔴 Elendi",
    reason: `${volumeComment}; Mint ${security.mint === "revoked" ? "✅" : "⚠️"} Freeze ${security.freeze === "revoked" ? "✅" : "⚠️"} LP ${effectiveLpLockedPct !== null && effectiveLpLockedPct >= 80 && liquidity >= greenLpFloor ? "✅" : "⚠️"}; ${importantRisk}`,
    hardReasons,
    cautionReasons,
    security,
    bubblemaps,
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
    [(Array.isArray(profiles.data) ? profiles.data : []).slice(0, 30), "dex-profile"],
    [(Array.isArray(latestBoosts.data) ? latestBoosts.data : []).slice(0, 20), "dex-boost"],
    [(Array.isArray(topBoosts.data) ? topBoosts.data : []).slice(0, 20), "dex-top"],
    [(Array.isArray(rugNew.data) ? rugNew.data : []).slice(0, 30), "rug-new"]
  ];
  const longestGroup = Math.max(...discoveryGroups.map(([items]) => items.length), 0);
  for (let index = 0; index < longestGroup; index++) {
    for (const [items, source] of discoveryGroups) {
      if (items[index]) addDiscovery(discovered, items[index], source);
    }
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
  const dexResults = await mapLimit(chunk(addresses, DEX_BATCH_LIMIT), 2, (batch) => (
    settleJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`)
  ));
  const successfulDexResults = dexResults.filter((result) => result.ok);
  if (!successfulDexResults.length) throw new Error("DexScreener piyasa verisi alınamadı.");
  if (successfulDexResults.length !== dexResults.length) warnings.push("DexScreener toplu sorgularından biri başarısız oldu.");

  const pairMap = selectPairs(successfulDexResults.flatMap((result) => Array.isArray(result.data) ? result.data : []));
  const ranked = candidates
    .map((discovery) => ({ discovery, pair: pairMap.get(discovery.address) }))
    .filter((item) => item.pair)
    .sort((a, b) => preScore(b.pair) - preScore(a.pair))
    .slice(0, REPORT_LIMIT);

  if (!ranked.length) throw new Error("Taranan tokenlerde aktif Solana çifti bulunamadı.");

  const reports = await mapLimit(ranked, 6, async ({ discovery }) => {
    const result = await settleJson(`https://api.rugcheck.xyz/v1/tokens/${discovery.address}/report`);
    return result.ok ? result.data : null;
  });
  const preliminary = ranked.map((item, index) => classifyPair(item.pair, reports[index], item.discovery));
  const bubblemapsByAddress = new Map();
  const externalByAddress = new Map();

  const externalTargets = preliminary
    .filter((token) => token.decision !== "red")
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(BIRDEYE_LIMIT, GOPLUS_LIMIT));
  if (BIRDEYE_API_KEY || GOPLUS_API_TOKEN || ONCHAIN_RPC_URL) {
    const externalResults = await mapLimit(externalTargets, 4, async (token) => {
      const [birdeye, goplus, onchain] = await Promise.all([
        fetchBirdeye(token.address),
        fetchGoplus(token.address),
        fetchOnchain(token.address)
      ]);
      return { address: token.address, birdeye, goplus, onchain };
    });
    for (const result of externalResults) externalByAddress.set(result.address, result);
    if (BIRDEYE_API_KEY && externalResults.some((result) => result.birdeye?.ok === false)) {
      warnings.push("Bazı Birdeye verileri alınamadı.");
    }
    if (GOPLUS_API_TOKEN && externalResults.some((result) => result.goplus?.ok === false)) warnings.push("Bazı GoPlus verileri alınamadı.");
    if (ONCHAIN_RPC_URL && externalResults.some((result) => result.onchain?.ok === false)) warnings.push("Bazı on-chain doğrulamaları alınamadı.");
  }

  if (BUBBLEMAPS_API_KEY) {
    const bubbleTargets = preliminary
      .filter((token) => token.decision !== "red")
      .sort((a, b) => b.score - a.score)
      .slice(0, BUBBLEMAPS_LIMIT);
    const bubbleResults = await mapLimit(bubbleTargets, 4, async (token) => {
      const result = await settleJson(
        `https://api.bubblemaps.io/v0/tokens/metrics/solana/${token.address}`,
        { timeout: 7000, headers: { "X-ApiKey": BUBBLEMAPS_API_KEY } }
      );
      return { address: token.address, ...result };
    });
    for (const result of bubbleResults) {
      if (result.ok) bubblemapsByAddress.set(result.address, result.data);
    }
    if (bubbleResults.some((result) => !result.ok)) warnings.push("Bazı Bubblemaps güvenlik verileri alınamadı.");
  }

  const classified = ranked.map((item, index) => classifyPair(
    item.pair,
    reports[index],
    item.discovery,
    bubblemapsByAddress.get(item.discovery.address) || null,
    Boolean(BUBBLEMAPS_API_KEY),
    externalByAddress.get(item.discovery.address) || {}
  ));
  const visible = classified
    .filter((token) => token.decision !== "red")
    .sort((a, b) => b.score - a.score)
    .slice(0, VISIBLE_LIMIT);
  const eliminated = classified.filter((token) => token.decision === "red");

  return {
    modelVersion: 4,
    generatedAt: new Date().toISOString(),
    autoRefreshMs: 16 * 60 * 1000,
    candidateCount: candidates.length,
    scannedCount: classified.length,
    tokens: visible,
    eliminatedCount: eliminated.length,
    eliminationReasons: reasonSummary(eliminated),
    bubblemapsEnabled: Boolean(BUBBLEMAPS_API_KEY),
    providers: {
      dexScreener: true,
      rugCheck: true,
      bubblemaps: Boolean(BUBBLEMAPS_API_KEY),
      birdeye: Boolean(BIRDEYE_API_KEY),
      goPlus: Boolean(GOPLUS_API_TOKEN),
      onchainRpc: Boolean(ONCHAIN_RPC_URL)
    },
    warning: warnings.length ? "Bazı veri kaynakları yanıt vermedi; mevcut verilerle tarandı." : ""
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
