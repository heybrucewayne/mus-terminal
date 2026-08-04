const CACHE_MS = 10 * 60 * 1000;
const DISCOVERY_LIMIT = 60;
const DEX_BATCH_LIMIT = 30;
const REPORT_LIMIT = 32;
const BUBBLEMAPS_LIMIT = 16;
const BIRDEYE_LIMIT = 12;
const GOPLUS_LIMIT = 16;
const ONCHAIN_LIMIT = 16;
const REQUEST_TIMEOUT_MS = 8500;
const SOURCE_CACHE_MS = 10 * 60 * 1000;
const GREEN_SCORE_MIN = 78;
const MIN_GREEN_AGE_HOURS = 6;
const HIGH_RUGCHECK_RISK = 70;
const MAX_HISTORY_PER_TOKEN = 8;
const MAX_HISTORY_TOKENS = 400;
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
// Best-effort history for warm Vercel instances. It is deliberately bounded:
// serverless memory is not a database, but keeping recent snapshots prevents
// a single noisy snapshot from being promoted to green during the same run.
const tokenHistory = new Map();

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
  const grouped = new Map();
  for (const pair of Array.isArray(rawPairs) ? rawPairs : []) {
    if (pair?.chainId !== "solana" || !pair?.baseToken?.address) continue;
    const address = pair.baseToken.address;
    const markets = grouped.get(address) || [];
    markets.push(pair);
    grouped.set(address, markets);
  }
  const selected = new Map();
  for (const [address, markets] of grouped) {
    const primary = markets.slice().sort((a, b) => pairWeight(b) - pairWeight(a))[0];
    const periods = ["m5", "h1", "h6", "h24"];
    const volume = Object.fromEntries(periods.map((period) => [
      period,
      markets.reduce((sum, pair) => sum + number(pair?.volume?.[period]), 0)
    ]));
    const txns = Object.fromEntries(periods.map((period) => [
      period,
      {
        buys: markets.reduce((sum, pair) => sum + number(pair?.txns?.[period]?.buys), 0),
        sells: markets.reduce((sum, pair) => sum + number(pair?.txns?.[period]?.sells), 0)
      }
    ]));
    const createdAt = markets
      .map((pair) => number(pair?.pairCreatedAt))
      .filter((value) => value > 0)
      .sort((a, b) => a - b)[0];
    selected.set(address, {
      ...primary,
      liquidity: {
        ...(primary.liquidity || {}),
        usd: markets.reduce((sum, pair) => sum + number(pair?.liquidity?.usd), 0)
      },
      volume,
      txns,
      pairCreatedAt: createdAt || primary.pairCreatedAt,
      pairCount: markets.length,
      pairAddresses: markets.map((pair) => pair?.pairAddress).filter(Boolean),
      primaryPairAddress: primary?.pairAddress || null
    });
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

function historyFor(address) {
  return tokenHistory.get(address) || [];
}

function historyCandidateEntries() {
  return [...tokenHistory.entries()]
    .sort((a, b) => number(b[1]?.at(-1)?.capturedAtMs) - number(a[1]?.at(-1)?.capturedAtMs))
    .slice(0, MAX_HISTORY_TOKENS)
    .map(([address, snapshots]) => ({
      address,
      symbol: String(snapshots.at(-1)?.symbol || ""),
      sources: ["previous-scan"]
    }));
}

function rememberSnapshots(tokens, capturedAt = new Date()) {
  const capturedAtMs = capturedAt instanceof Date ? capturedAt.getTime() : Date.parse(capturedAt);
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!addressPattern.test(String(token?.address || ""))) continue;
    const current = {
      capturedAt: new Date(Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now()).toISOString(),
      capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : Date.now(),
      address: token.address,
      symbol: token.symbol,
      marketCap: token.marketCap,
      liquidity: token.liquidity,
      volume: token.volume,
      price: token.price,
      score: token.score,
      decision: token.decision,
      security: {
        mint: token.security?.mint,
        freeze: token.security?.freeze,
        lpLockedPct: token.security?.lpLockedPct,
        riskScore: token.security?.riskScore,
        effectiveTop10Pct: token.security?.effectiveTop10Pct
      }
    };
    const previous = historyFor(token.address).filter((item) => item?.capturedAtMs !== current.capturedAtMs);
    tokenHistory.set(token.address, [...previous, current].slice(-MAX_HISTORY_PER_TOKEN));
  }

  while (tokenHistory.size > MAX_HISTORY_TOKENS) {
    const oldest = [...tokenHistory.entries()]
      .sort((a, b) => number(a[1]?.at(-1)?.capturedAtMs) - number(b[1]?.at(-1)?.capturedAtMs))[0];
    if (!oldest) break;
    tokenHistory.delete(oldest[0]);
  }
}

function historyAssessment(volume, price, liquidity, history = []) {
  const prior = Array.isArray(history) ? history.at(-1) : null;
  const currentH1 = number(volume?.h1);
  const priorH1 = number(prior?.volume?.h1);
  const currentPace5 = number(volume?.pace5);
  const priorPace5 = number(prior?.volume?.pace5);
  const h1Growth = priorH1 > 0 ? currentH1 / priorH1 : null;
  const pace5Growth = priorPace5 > 0 ? currentPace5 / priorPace5 : null;
  const lpChange = prior && number(prior.liquidity) > 0
    ? number(liquidity) / number(prior.liquidity) - 1
    : null;
  const priceH1 = number(price?.h1);
  const priorPriceH1 = number(prior?.price?.h1);
  const priceChange = prior && Number.isFinite(priceH1) && Number.isFinite(priorPriceH1)
    ? priceH1 - priorPriceH1
    : null;
  const hasPrevious = Boolean(prior);
  const momentumConfirmed = hasPrevious && volume?.trend === "rising"
    && (prior?.volume?.trend === "rising" || number(h1Growth) >= 1.05 || number(pace5Growth) >= 1.05);
  const liquidityStable = hasPrevious && lpChange !== null && lpChange >= -0.10;
  const priceSupported = priceChange === null || priceChange >= -12 || number(volume?.h1) > priorH1;

  return {
    snapshots: (Array.isArray(history) ? history.length : 0) + 1,
    hasPrevious,
    h1Growth,
    pace5Growth,
    lpChange,
    priceChange,
    momentumConfirmed,
    liquidityStable,
    priceSupported
  };
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

function emptyBirdeyeOverview(requested = false) {
  return {
    requested,
    verified: false,
    uniqueTraders: null,
    uniqueTraders24h: null,
    buyVolume1h: null,
    sellVolume1h: null,
    buyVolume24h: null,
    sellVolume24h: null,
    notableRisk: requested ? "Birdeye işlem verisi Doğrulanmadı" : "Birdeye etkin değil"
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

function parseBirdeyeOverview(payload) {
  const data = responseData(payload);
  const uniqueTraders = optionalNumber(
    data?.uniqueWallet1h
      ?? data?.unique_wallets_1h
      ?? data?.uniqueTraders1h
      ?? data?.unique_traders_1h
      ?? data?.uniqueWallet24h
      ?? data?.unique_wallets_24h
      ?? data?.uniqueTraders24h
      ?? data?.unique_traders_24h
      ?? data?.uniqueWallets
      ?? data?.unique_traders
  );
  const uniqueTraders24h = optionalNumber(
    data?.uniqueWallet24h ?? data?.unique_wallets_24h ?? data?.uniqueTraders24h ?? data?.unique_traders_24h
  );
  const buyVolume1h = optionalNumber(
    data?.vBuy1hUSD ?? data?.buy1hUSD ?? data?.buy_volume_1h ?? data?.buyVolume1h
  );
  const sellVolume1h = optionalNumber(
    data?.vSell1hUSD ?? data?.sell1hUSD ?? data?.sell_volume_1h ?? data?.sellVolume1h
  );
  const buyVolume24h = optionalNumber(
    data?.vBuy24hUSD ?? data?.buy24hUSD ?? data?.buy_volume_24h ?? data?.buyVolume24h ?? data?.buy_volume_usd_24h
  );
  const sellVolume24h = optionalNumber(
    data?.vSell24hUSD ?? data?.sell24hUSD ?? data?.sell_volume_24h ?? data?.sellVolume24h ?? data?.sell_volume_usd_24h
  );
  return {
    verified: uniqueTraders !== null || buyVolume1h !== null || sellVolume1h !== null || buyVolume24h !== null || sellVolume24h !== null,
    uniqueTraders,
    uniqueTraders24h,
    buyVolume1h,
    sellVolume1h,
    buyVolume24h,
    sellVolume24h,
    notableRisk: uniqueTraders === null ? "Birdeye benzersiz trader verisi Doğrulanmadı" : "Birdeye trader verisi mevcut"
  };
}

async function fetchBirdeye(address) {
  if (!BIRDEYE_API_KEY) return {
    ok: false,
    fetchedAt: null,
    holder: emptyBirdeyeSnapshot(false),
    firstBuyers: emptyBirdeyeSnapshot(false),
    overview: emptyBirdeyeOverview(false)
  };
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
    const [holderResult, buyersResult, overviewResult] = await Promise.all([
      settleJson(`https://public-api.birdeye.so/holder/v1/distribution?${query}`, { headers }),
      settleJson(`https://public-api.birdeye.so/token/v1/first-buyers?token_address=${encodeURIComponent(address)}&offset=0&limit=50`, { headers }),
      settleJson(`https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(address)}&frames=5m,1h,24h`, { headers })
    ]);
    const fetchedAt = new Date().toISOString();
    return {
      ok: holderResult.ok || buyersResult.ok || overviewResult.ok,
      fetchedAt,
      holder: holderResult.ok ? parseBirdeyeHolder(holderResult.data) : emptyBirdeyeSnapshot(true),
      firstBuyers: buyersResult.ok ? parseBirdeyeFirstBuyers(buyersResult.data) : { verified: false, firstBuyerCount: 0, bundlerCount: 0, insiderCount: 0, devCount: 0, sniperCount: 0, smartTraderCount: 0, buyMoreCount: 0, holdCount: 0, sellPartialCount: 0, sellAllCount: 0, bundledRatio: null },
      overview: overviewResult.ok ? parseBirdeyeOverview(overviewResult.data) : emptyBirdeyeOverview(true)
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
  if (!GOPLUS_API_TOKEN) return { ok: false, fetchedAt: null, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, notableRisk: "GoPlus etkin değil" };
  return cachedSource(`goplus:${address}`, async () => {
    const authorization = GOPLUS_API_TOKEN.toLowerCase().startsWith("bearer ")
      ? GOPLUS_API_TOKEN
      : `Bearer ${GOPLUS_API_TOKEN}`;
    const result = await settleJson(
      `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`,
      { headers: { Authorization: authorization } }
    );
    return result.ok
      ? { ok: true, fetchedAt: new Date().toISOString(), ...parseGoplus(result.data, address) }
      : { ok: false, fetchedAt: null, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, lpLockedPct: null, notableRisk: "GoPlus verisi Doğrulanmadı" };
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
  if (!ONCHAIN_RPC_URL) return { ok: false, fetchedAt: null, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, notableRisk: "On-chain doğrulama etkin değil" };
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
    if (!result.ok || !Array.isArray(result.data)) return { ok: false, fetchedAt: null, verified: false, mint: "unknown", freeze: "unknown", top1Pct: null, top10Pct: null, notableRisk: "On-chain verisi Doğrulanmadı" };
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
    return { ok: true, fetchedAt: new Date().toISOString(), verified: top10Pct !== null || authorities.mint !== "unknown" || authorities.freeze !== "unknown", ...authorities, top1Pct, top10Pct, notableRisk: "On-chain doğrulama mevcut" };
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
  const overview = sources?.birdeye?.overview || emptyBirdeyeOverview(Boolean(BIRDEYE_API_KEY));
  const birdeye = {
    ...emptyBirdeyeSnapshot(Boolean(BIRDEYE_API_KEY)),
    ...holder,
    ...firstBuyers,
    ...overview,
    holderVerified: Boolean(holder.verified),
    firstBuyersVerified: Boolean(firstBuyers.verified),
    overviewVerified: Boolean(overview.verified),
    verified: Boolean(holder.verified || firstBuyers.verified || overview.verified)
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
  const maxKnown = (...values) => {
    const known = values.filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value))).map(Number);
    return known.length ? Math.max(...known) : null;
  };

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
    effectiveTop1Pct: maxKnown(security.top1Pct, birdeye.top1Pct, goplus.top1Pct),
    effectiveTop10Pct: maxKnown(security.top10Pct, birdeye.top10Pct, goplus.top10Pct),
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
  // A flat flow scores around 1. Values well above 1 can be acceleration,
  // but an extreme one-period spike is treated as less healthy than a
  // repeated, moderate increase.
  const recent5mRatio = h1 > 0 ? pace5 / h1 : null;
  const recent1hRatio = h6 > 0 ? h1 * 6 / h6 : null;
  const recent6hRatio = h24 > 0 ? h6 * 4 / h24 : null;
  let trend = "steady";
  if (ageHours === null || ageHours < 1) {
    trend = "unconfirmed";
  } else if (ageHours < 6) {
    if (number(recent5mRatio) >= 1.18 && number(recent1hRatio) >= 1.02) trend = "rising";
    else if (number(recent5mRatio) < 0.45 || number(recent1hRatio) < 0.62) trend = "falling";
  } else if (number(recent5mRatio) >= 1.10 && number(recent1hRatio) >= 1.04
      && h1 > Math.max(previous5hPace, 1) * 1.05) {
    trend = "rising";
  } else if (number(recent5mRatio) < 0.52 || number(recent1hRatio) < 0.68
      || previous5hPace < Math.max(previous18hPace, 1) * 0.62) {
    trend = "falling";
  }

  return {
    m5,
    h1,
    h6,
    h24,
    pace5,
    previous5hPace,
    previous18hPace,
    recent5mRatio,
    recent1hRatio,
    recent6hRatio,
    trend
  };
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

function healthyRatioScore(value, low, idealLow, idealHigh, high, points) {
  if (!Number.isFinite(value) || value <= low) return 0;
  if (value >= high) return points * 0.35;
  if (value >= idealLow && value <= idealHigh) return points;
  if (value < idealLow) return clamp((value - low) / (idealLow - low) * points, 0, points);
  return clamp((high - value) / (high - idealHigh) * points, points * 0.35, points);
}

function marketEarlynessScore(marketCap) {
  if (!marketCap) return 0;
  // Preference is continuous rather than a hard MC gate. The peak is around
  // $1M, while healthy $5M-$10M markets still receive meaningful points.
  return clamp(6 - Math.abs(Math.log10(Math.max(marketCap, 1)) - 6) * 1.8, 0, 6);
}

function qualityScore({ marketCap, liquidity, lpRatio, ageHours, volume, txns, price, security, priceVolumeDivergence, history }) {
  const historyState = historyAssessment(volume, price, liquidity, history);
  const turnover24h = marketCap ? volume.h24 / marketCap : 0;
  const liquidityTurnover = liquidity ? volume.h1 / liquidity : 0;

  // 30 points: size of the flow plus three normalized acceleration ratios.
  const accelerationScore = healthyRatioScore(volume.recent5mRatio, 0.30, 0.95, 1.55, 2.40, 4)
    + healthyRatioScore(volume.recent1hRatio, 0.45, 0.95, 1.35, 1.90, 4)
    + healthyRatioScore(volume.recent6hRatio, 0.45, 0.90, 1.25, 1.70, 4);
  const volumeContinuity = volume.trend === "rising" ? 4 : volume.trend === "steady" ? 2 : 0;
  const historyContinuity = historyState.momentumConfirmed ? 4 : historyState.hasPrevious ? 2 : 0;
  let volumeScore = logarithmicScore(volume.h24, 5000, 2000000, 8)
    + accelerationScore
    + volumeContinuity
    + historyContinuity;
  if (priceVolumeDivergence) volumeScore -= 5;
  if (!historyState.priceSupported) volumeScore -= 3;
  if (price.h6 <= -35 || price.h24 <= -55) volumeScore -= 3;
  volumeScore = clamp(volumeScore, 0, 30);

  // 20 points: enough LP for the observed flow, not just a large nominal LP.
  const lockPct = security.lpLockedPct !== null && security.lpLockedPct !== undefined
    ? security.lpLockedPct
    : security.goplus?.lpLockedPct;
  let liquidityScore = logarithmicScore(liquidity, 5000, 250000, 8)
    + healthyRatioScore(lpRatio, 0.001, 0.008, 0.05, 0.20, 5)
    + healthyRatioScore(liquidityTurnover, 0.01, 0.05, 0.70, 2.50, 4)
    + (lockPct !== null && lockPct >= 80 ? 2 : lockPct !== null ? 1 : 0)
    + (historyState.liquidityStable ? 1 : 0);
  if (historyState.lpChange !== null && historyState.lpChange < -0.20) liquidityScore -= 3;
  liquidityScore = clamp(liquidityScore, 0, 20);

  // 15 points: transactions are discounted when they come from few wallets.
  const buyRatio = txns.h1.buyRatio;
  const balanceScore = txns.h1.total
    ? healthyRatioScore(buyRatio, 0.25, 0.45, 0.64, 0.82, 4)
    : 0;
  const uniqueTraders = optionalNumber(security.birdeye?.uniqueTraders);
  const traderScore = uniqueTraders === null ? 0 : logarithmicScore(uniqueTraders, 5, 1500, 4);
  const tradesPerTrader = uniqueTraders && uniqueTraders > 0 ? txns.h1.total / uniqueTraders : null;
  const traderDistribution = tradesPerTrader === null ? 0 : tradesPerTrader <= 18 ? 2 : tradesPerTrader <= 35 ? 1 : 0;
  const flowBuyVolume = optionalNumber(security.birdeye?.buyVolume1h ?? security.birdeye?.buyVolume24h);
  const flowSellVolume = optionalNumber(security.birdeye?.sellVolume1h ?? security.birdeye?.sellVolume24h);
  const flowBalance = flowBuyVolume !== null && flowSellVolume !== null && flowBuyVolume + flowSellVolume > 0
    ? healthyRatioScore(flowBuyVolume / (flowBuyVolume + flowSellVolume), 0.20, 0.42, 0.68, 0.86, 2)
    : 0;
  let flowScore = logarithmicScore(txns.h1.total, 20, 2000, 5)
    + balanceScore + traderScore + traderDistribution + flowBalance;
  if (uniqueTraders !== null && txns.h1.total > 250 && tradesPerTrader > 35) flowScore -= 3;
  flowScore = clamp(flowScore, 0, 15);

  // 25 points: unknown or conflicting security data cannot earn these points.
  const riskQuality = security.riskScore === null ? 0
    : security.riskScore <= 20 ? 4
      : security.riskScore <= 40 ? 2
        : security.riskScore <= 60 ? 1
          : 0;
  let securityScore = (security.mint === "revoked" ? 4 : 0)
    + (security.freeze === "revoked" ? 4 : 0)
    + (security.verified ? 2 : 0)
    + (security.compositeVerified ? 4 : 0)
    + Math.min(2, security.externalVerifiedCount || 0)
    + (lockPct !== null && lockPct >= 80 ? 3 : lockPct !== null ? 1 : 0)
    + riskQuality;
  if (security.effectiveTop1Pct !== null && security.effectiveTop1Pct <= 8) securityScore += 1;
  if (security.effectiveTop10Pct !== null && security.effectiveTop10Pct <= 35) securityScore += 1;
  if (security.birdeye?.holderVerified) securityScore += 1;
  if (security.goplus?.verified) securityScore += 1;
  if (security.onchain?.verified) securityScore += 1;
  securityScore -= Math.min(6, security.riskWarningCount * 2);
  if (security.copycat) securityScore -= 3;
  if (security.lowLiquidityWarning) securityScore -= 2;
  if (security.creatorRugHistory) securityScore -= 6;
  if (security.graphInsiders > 10) securityScore -= clamp(security.graphInsiders / 20, 1, 5);
  if (security.effectiveTop1Pct > 12) securityScore -= 2;
  if (security.effectiveTop10Pct > 45) securityScore -= 2;
  if (security.insiderPct !== null && security.insiderPct > 5) securityScore -= 3;
  if (security.crossSourceConflict) securityScore = 0;
  securityScore = clamp(securityScore, 0, 25);

  // 10 points: earlyness is a ranking preference, never an elimination rule.
  const ageScore = ageHours === null ? 0
    : ageHours < 6 ? 4
      : ageHours < 24 ? 3
        : ageHours < 168 ? 2
          : ageHours < 720 ? 1
            : 0;
  const components = {
    volume: volumeScore,
    liquidity: liquidityScore,
    traderFlow: flowScore,
    security: securityScore,
    earlyness: clamp(marketEarlynessScore(marketCap) + ageScore, 0, 10)
  };
  const score = Math.round(clamp(Object.values(components).reduce((sum, value) => sum + value, 0), 0, 100));
  return {
    score,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value)])),
    history: historyState
  };
}

function classifyPair(pair, report, discovery, bubblemapsMetrics = null, bubblemapsRequested = false, externalSources = {}, context = {}) {
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
  const history = Array.isArray(context.history) ? context.history : historyFor(pair?.baseToken?.address);
  const historyState = historyAssessment(volume, price, liquidity, history);
  const lpRatio = marketCap ? liquidity / marketCap : 0;
  const effectiveLpLockedPct = security.lpLockedPct !== null ? security.lpLockedPct : security.goplus?.lpLockedPct;
  const criticalLpFloor = marketCap ? Math.max(5000, Math.min(30000, marketCap * 0.005)) : 6000;
  const greenLpFloor = marketCap ? Math.max(15000, Math.min(120000, marketCap * 0.015)) : 20000;
  const unsupportedSpike = (price.h6 > 100 && (volume.trend === "falling" || (marketCap && volume.h6 / marketCap < 0.12)))
    || (volume.recent5mRatio !== null && volume.recent5mRatio > 2.40 && volume.recent1hRatio !== null && volume.recent1hRatio < 0.85);
  const priceVolumeDivergence = (price.h6 > 35 && volume.trend === "falling")
    || (price.h6 < -30 && volume.trend === "falling")
    || (Math.abs(price.h24) > 90 && marketCap && volume.h24 / marketCap < 0.18)
    || (price.h6 > 45 && volume.recent1hRatio !== null && volume.recent1hRatio < 0.70);
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
  if (volume.h1 > 10000 && liquidity > 0 && liquidity / volume.h1 < 0.08) hardReasons.push("Likidite hacme göre çok ince");
  if (security.effectiveTop1Pct > 22) hardReasons.push("Tek holder yoğunluğu aşırı");
  if (security.effectiveTop10Pct > 65) hardReasons.push("Top holder yoğunluğu aşırı");
  if (security.insiderPct !== null && security.insiderPct > 15) hardReasons.push("Insider yoğunluğu yüksek");
  if (security.bundled === "flagged") hardReasons.push("Bundled buy işareti");
  if (security.birdeye?.bundledRatio !== null && security.birdeye.bundledRatio >= 0.30) hardReasons.push("Birdeye bundled buy yoğunluğu yüksek");
  if (security.wash === "flagged") hardReasons.push("Wash trading işareti");
  if (security.devSale === "flagged") hardReasons.push("Geliştirici satışı işareti");
  if (security.creatorRugHistory) hardReasons.push("Geliştiricinin rug geçmişi");
  if (security.graphInsiders >= 100) hardReasons.push("Cluster/insider yoğunluğu aşırı");
  if (security.birdeye?.uniqueTraders !== null && security.birdeye.uniqueTraders < 5 && txns.h1.total > 120) hardReasons.push("Benzersiz trader sayısı çok düşük");
  if (security.birdeye?.uniqueTraders !== null && txns.h1.total > 250 && txns.h1.total / Math.max(security.birdeye.uniqueTraders, 1) > 45) hardReasons.push("İşlem/trader oranı yapay görünüyor");
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
  if (volume.h1 > 10000 && liquidity > 0 && liquidity / volume.h1 < 0.16) cautionReasons.push("Likidite hacme göre ince");
  if (volume.trend === "falling") cautionReasons.push("Kısa vadeli hacim zayıflıyor");
  if (volume.trend === "unconfirmed") cautionReasons.push("Hacim geçmişi yetersiz");
  if (historyState.snapshots < 2) cautionReasons.push("İvme için ikinci snapshot bekleniyor");
  else if (!historyState.momentumConfirmed && volume.trend === "rising") cautionReasons.push("Hacim ivmesi henüz tekrarlanmadı");
  if (historyState.hasPrevious && !historyState.liquidityStable) cautionReasons.push("Likidite önceki snapshota göre zayıfladı");
  if (historyState.hasPrevious && !historyState.priceSupported) cautionReasons.push("Fiyat hareketi hacimle desteklenmiyor");
  if (txns.h1.total < 30) cautionReasons.push("İşlem sayısı yetersiz");
  if (security.birdeye?.uniqueTraders === null) cautionReasons.push("Benzersiz trader verisi Doğrulanmadı");
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
    priceVolumeDivergence,
    history
  });
  const cautionPenalty = Math.min(14, cautionReasons.length * 1.5);
  const hardPenalty = Math.min(36, hardReasons.length * 12);
  const score = Math.round(clamp(quality.score + bubbleAssessment.adjustment - cautionPenalty - hardPenalty, 0, 100));

  let decision = "yellow";
  if (hardReasons.length) decision = "red";
  else if (score >= GREEN_SCORE_MIN
      && cautionReasons.length === 0
      && security.compositeVerified
      && security.mint === "revoked"
      && security.freeze === "revoked"
      && effectiveLpLockedPct !== null
      && effectiveLpLockedPct >= 80
      && historyState.snapshots >= 2
      && historyState.momentumConfirmed) decision = "green";

  const volumeComment = volume.trend === "rising"
    ? "hacim kademeli ivmeleniyor"
    : volume.trend === "falling"
      ? "kısa vadeli hacim zayıflıyor"
      : volume.trend === "unconfirmed"
        ? "hacim geçmişi henüz yetersiz"
        : "hacim dengeli seyrediyor";
  const importantRisk = !security.compositeVerified
    ? "bağımsız güvenlik verisi Doğrulanmadı"
    : bubblemaps.requested && !bubblemaps.verified
      ? "Bubblemaps verisi Doğrulanmadı"
      : bubblemaps.verified && bubblemaps.notableRisk !== "Belirgin Bubblemaps dağılım uyarısı yok"
        ? bubblemaps.notableRisk
        : cautionReasons[0]
          || (security.notableRisk === "Belirgin RugCheck uyarısı yok"
            ? "benzersiz trader sayısı Doğrulanmadı"
            : security.notableRisk);

  const result = {
    address: pair.baseToken.address,
    symbol: String(pair?.baseToken?.symbol || discovery?.symbol || "?").slice(0, 12),
    name: String(pair?.baseToken?.name || "").slice(0, 60),
    marketCap,
    liquidity,
    pairCount: Number(pair?.pairCount) || 1,
    pairAddresses: Array.isArray(pair?.pairAddresses) ? pair.pairAddresses : [pair?.pairAddress].filter(Boolean),
    volume,
    price,
    txns,
    ageHours,
    score,
    scoreBreakdown: { ...quality.components, bubblemaps: bubbleAssessment.adjustment, cautionPenalty: -cautionPenalty, hardPenalty: -hardPenalty },
    decision,
    decisionLabel: decision === "green" ? "🟢 İzlemeye değer" : decision === "yellow" ? "🟡 Şartlı izleme" : "🔴 Elendi",
    reason: `${volumeComment}; Mint ${security.mint === "revoked" ? "✅" : "⚠️"} Freeze ${security.freeze === "revoked" ? "✅" : "⚠️"} LP ${effectiveLpLockedPct !== null && effectiveLpLockedPct >= 80 && liquidity >= greenLpFloor ? "✅" : "⚠️"}; ${importantRisk}`,
    hardReasons,
    cautionReasons,
    security,
    bubblemaps,
    priceVolumeDivergence,
    history: historyState,
    reasonCodes: [],
    sourceMeta: context.sourceMeta || {},
    dexUrl: pair?.url || `https://dexscreener.com/solana/${pair?.pairAddress || pair.baseToken.address}`,
    rugUrl: `https://rugcheck.xyz/tokens/${pair.baseToken.address}`,
    sources: discovery?.sources || []
  };
  result.reasonCodes = deriveReasonCodes(result);
  return result;
}

function deriveReasonCodes(token) {
  const text = [...(token?.hardReasons || []), ...(token?.cautionReasons || [])].join(" ").toLowerCase();
  const codes = [];
  const add = (condition, code) => { if (condition && !codes.includes(code)) codes.push(code); };
  add(token?.volume?.trend === "rising" || token?.history?.momentumConfirmed, "volume_acceleration");
  add(token?.scoreBreakdown?.traderFlow >= 9 && !/trader sayısı|benzersiz trader|işlem\/trader|wash/i.test(text), "healthy_trader_flow");
  add(/likidite.*(düşük|ince)|lp kilidi/i.test(text), "thin_liquidity");
  add(/mint authority açık|mintable açık|freeze authority açık|freezable açık/i.test(text), "active_authority");
  add(/lp kilidi doğrulanmadı/i.test(text), "lp_unverified");
  add(/cluster|holder yoğunluğu|insider/i.test(text), "cluster_concentration");
  add(/geliştirici|creator|dev/i.test(text), "dev_selling");
  add(/wash|işlem\/trader oranı yapay/i.test(text), "wash_trading");
  add(/fiyat\/hacim|hacimsiz dik|momentum|hacim.*zayıflıyor/i.test(text), "momentum_reversal");
  add(/çelişkili|kaynak.*çeliş/i.test(text), "source_conflict");
  add(number(token?.history?.snapshots) < 2, "insufficient_history");
  add(/bundled/i.test(text), "bundled_buy_risk");
  add(/rug geçmişi|rugcheck risk|rugged/i.test(text), "rug_risk");
  return codes;
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

function reasonCodeSummary(tokens) {
  const counts = new Map();
  for (const token of Array.isArray(tokens) ? tokens : []) {
    for (const code of token.reasonCodes || []) counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count }));
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

  // Keep previously observed contracts in the candidate pool so an early
  // token is not forgotten just because it is no longer boosted or trending.
  for (const item of historyCandidateEntries()) addDiscovery(discovered, item, "previous-scan");

  const warnings = [profiles, latestBoosts, topBoosts, rugNew]
    .filter((result) => !result.ok)
    .map((result) => result.error);
  return { candidates: [...discovered.values()].slice(0, DISCOVERY_LIMIT), warnings };
}

async function buildScan() {
  const scanFetchedAt = new Date().toISOString();
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
    return { report: result.ok ? result.data : null, fetchedAt: result.ok ? new Date().toISOString() : null };
  });
  const preliminary = ranked.map((item, index) => classifyPair(
    item.pair,
    reports[index].report,
    item.discovery,
    null,
    false,
    {},
    { history: historyFor(item.discovery.address), fetchedAt: scanFetchedAt }
  ));
  const bubblemapsByAddress = new Map();
  const externalByAddress = new Map();

  const externalTargets = preliminary
    .filter((token) => token.decision !== "red")
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(BIRDEYE_LIMIT, GOPLUS_LIMIT));
  if (BIRDEYE_API_KEY || GOPLUS_API_TOKEN || ONCHAIN_RPC_URL) {
    const externalResults = await mapLimit(externalTargets, 4, async (token, index) => {
      const [birdeye, goplus, onchain] = await Promise.all([
        index < BIRDEYE_LIMIT ? fetchBirdeye(token.address) : Promise.resolve({ ok: false, fetchedAt: null }),
        index < GOPLUS_LIMIT ? fetchGoplus(token.address) : Promise.resolve({ ok: false, fetchedAt: null }),
        index < ONCHAIN_LIMIT ? fetchOnchain(token.address) : Promise.resolve({ ok: false, fetchedAt: null })
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

  const classified = ranked.map((item, index) => {
    const external = externalByAddress.get(item.discovery.address) || {};
    const bubbleMetrics = bubblemapsByAddress.get(item.discovery.address) || null;
    const sourceMeta = {
      dexScreener: { verified: true, fetchedAt: scanFetchedAt, pairAddress: item.pair?.pairAddress || null },
      rugCheck: { requested: true, verified: Boolean(reports[index].report), fetchedAt: reports[index].fetchedAt },
      birdeye: { requested: Boolean(BIRDEYE_API_KEY), verified: Boolean(external.birdeye?.ok), fetchedAt: external.birdeye?.fetchedAt || null },
      goPlus: { requested: Boolean(GOPLUS_API_TOKEN), verified: Boolean(external.goplus?.ok), fetchedAt: external.goplus?.fetchedAt || null },
      onchain: { requested: Boolean(ONCHAIN_RPC_URL), verified: Boolean(external.onchain?.ok), fetchedAt: external.onchain?.fetchedAt || null },
      bubblemaps: { requested: Boolean(BUBBLEMAPS_API_KEY), verified: Boolean(bubbleMetrics), fetchedAt: bubbleMetrics ? scanFetchedAt : null }
    };
    return classifyPair(
      item.pair,
      reports[index].report,
      item.discovery,
      bubbleMetrics,
      Boolean(BUBBLEMAPS_API_KEY),
      external,
      { history: historyFor(item.discovery.address), fetchedAt: scanFetchedAt, sourceMeta }
    );
  });
  const generatedAt = new Date().toISOString();
  rememberSnapshots(classified, generatedAt);
  const visible = classified
    .filter((token) => token.decision !== "red")
    .sort((a, b) => b.score - a.score);
  const eliminated = classified.filter((token) => token.decision === "red");

  return {
    modelVersion: 5,
    generatedAt,
    autoRefreshMs: 16 * 60 * 1000,
    candidateCount: candidates.length,
    scannedCount: classified.length,
    tokens: visible,
    history: {
      trackedTokens: tokenHistory.size,
      tokensWithPreviousSnapshot: classified.filter((token) => token.history?.snapshots >= 2).length
    },
    eliminatedCount: eliminated.length,
    eliminationReasons: reasonSummary(eliminated),
    reasonCodeSummary: reasonCodeSummary(classified),
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

export { classifyPair, preScore, qualityScore, securitySnapshot, volumeSnapshot, historyAssessment, deriveReasonCodes };
