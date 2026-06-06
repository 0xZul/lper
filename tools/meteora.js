/**
 * Meteora.js — Modular AI Tools for Meteora DLMM (Solana)
 *
 * Fetch-based, no SDK dependencies. All functions return plain objects.
 *
 * === USAGE ===
 *   import { getPoolInfo, searchPools, getOpenPositions, discoverPools, getPoolPnl } from "./meteora.js";
 *
 * === ENDPOINTS ===
 *   Pool Discovery API   → https://pool-discovery-api.datapi.meteora.ag
 *   DLMM Data API        → https://dlmm.datapi.meteora.ag
 *   Jupiter API          → https://datapi.jup.ag/v1
 *   Jupiter Price API    → https://api.jup.ag/price/v3
 *   Helius (optional)    → https://api.helius.xyz
 */

// ─── Configuration ─────────────────────────────────────────────
// Override via environment or direct assignment
const CONFIG = {
  poolDiscoveryBase: process.env.METEORA_POOL_DISCOVERY_BASE || "https://pool-discovery-api.datapi.meteora.ag",
  dlmmDataBase: process.env.METEORA_DLMM_BASE || "https://dlmm.datapi.meteora.ag",
  jupDataBase: process.env.METEORA_JUP_BASE || "https://datapi.jup.ag/v1",
  jupPriceBase: process.env.METEORA_JUP_PRICE_BASE || "https://api.jup.ag/price/v3",
  heliusKey: process.env.HELIUS_API_KEY || null,
};

// ─── Helpers ───────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeStr(v, fallback = "?") {
  return v != null ? String(v) : fallback;
}

// ════════════════════════════════════════════════════════════════
//  1. POOL DISCOVERY API
//  Base: https://pool-discovery-api.datapi.meteora.ag
// ════════════════════════════════════════════════════════════════

/**
 * Discover pools from Meteora Pool Discovery API with built-in filters.
 *
 * @param {Object} opts
 * @param {number}  [opts.pageSize=50]         - Results per page
 * @param {string}  [opts.timeframe="5m"]       - Time window: 5m, 15m, 30m, 1h, 2h, 4h, 24h
 * @param {string}  [opts.category="trending"]  - Category: trending, top_volume, new, discord_signals
 * @param {Object}  [opts.filters]              - Override filters (see defaults below)
 * @param {number}  [opts.filters.minMcap=150000]
 * @param {number}  [opts.filters.maxMcap=10000000]
 * @param {number}  [opts.filters.minHolders=500]
 * @param {number}  [opts.filters.minVolume=500]
 * @param {number}  [opts.filters.minTvl=10000]
 * @param {number}  [opts.filters.maxTvl=150000]
 * @param {number}  [opts.filters.minBinStep=80]
 * @param {number}  [opts.filters.maxBinStep=125]
 * @param {number}  [opts.filters.minFeeActiveTvlRatio=0.05]
 * @param {number}  [opts.filters.minOrganic=60]
 * @param {number}  [opts.filters.minTokenFeesSol=30]
 * @param {number}  [opts.filters.maxBotHoldersPct=30]
 * @param {string[]} [opts.filters.allowedLaunchpads]  - e.g. ["pump", "moonshot"]
 * @param {number}  [opts.filters.minTokenAgeHours]
 * @param {number}  [opts.filters.maxTokenAgeHours]
 * @returns {Promise<{ pools: Array, total: number, timeframe: string }>}
 */
export async function discoverPools(opts = {}) {
  const {
    pageSize = 50,
    timeframe = "5m",
    category = "trending",
    filters: overrides = {},
  } = opts;

  const f = {
    minMcap: 150_000,
    maxMcap: 10_000_000,
    minHolders: 500,
    minVolume: 500,
    minTvl: 10_000,
    maxTvl: 150_000,
    minBinStep: 80,
    maxBinStep: 125,
    minFeeActiveTvlRatio: 0.05,
    minOrganic: 60,
    minTokenFeesSol: 30,
    maxBotHoldersPct: 30,
    ...overrides,
  };

  const parts = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${f.minMcap}`,
    `base_token_market_cap<=${f.maxMcap}`,
    `base_token_holders>=${f.minHolders}`,
    `volume>=${f.minVolume}`,
    `tvl>=${f.minTvl}`,
    `tvl<=${f.maxTvl}`,
    `dlmm_bin_step>=${f.minBinStep}`,
    `dlmm_bin_step<=${f.maxBinStep}`,
    `fee_active_tvl_ratio>=${f.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${f.minOrganic}`,
  ];

  if (f.minTokenAgeHours != null) {
    parts.push(`base_token_created_at<=${Date.now() - f.minTokenAgeHours * 3_600_000}`);
  }
  if (f.maxTokenAgeHours != null) {
    parts.push(`base_token_created_at>=${Date.now() - f.maxTokenAgeHours * 3_600_000}`);
  }
  if (Array.isArray(f.allowedLaunchpads) && f.allowedLaunchpads.length > 0) {
    parts.push(`base_token_launchpad=[${f.allowedLaunchpads.join(",")}]`);
  }

  const url =
    `${CONFIG.poolDiscoveryBase}/pools?` +
    `page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(parts.join("&&"))}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  const data = await fetchJson(url);
  const pools = Array.isArray(data.data) ? data.data : [];

  return {
    pools: pools.map(normalizePool),
    total: pools.length,
    timeframe,
    category,
  };
}

/**
 * Get detailed info for a single pool by address.
 *
 * @param {string} poolAddress
 * @param {Object} [opts]
 * @param {string} [opts.timeframe="5m"]   - Time window for metrics
 * @returns {Promise<Object|null>}
 */
export async function getPoolDetail(poolAddress, opts = {}) {
  const { timeframe = "5m" } = opts;
  const url =
    `${CONFIG.poolDiscoveryBase}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const data = await fetchJson(url);
  const pool = Array.isArray(data.data) ? data.data[0] : null;
  return pool ? normalizePool(pool) : null;
}

// ════════════════════════════════════════════════════════════════
//  2. DLMM DATA API
//  Base: https://dlmm.datapi.meteora.ag
// ════════════════════════════════════════════════════════════════

/**
 * Get pool metadata (name, token symbols) from DLMM data API.
 *
 * GET /pools/{address}
 *
 * @param {string} poolAddress
 * @returns {Promise<{ address: string, name: string|null, token_x_symbol: string|null, token_y_symbol: string|null }>}
 */
export async function getPoolInfo(poolAddress) {
  try {
    const data = await fetchJson(`${CONFIG.dlmmDataBase}/pools/${poolAddress}`);
    return {
      address: data?.address || poolAddress,
      name: data?.name || null,
      token_x_symbol: data?.token_x?.symbol || null,
      token_y_symbol: data?.token_y?.symbol || null,
    };
  } catch {
    return { address: poolAddress, name: null, token_x_symbol: null, token_y_symbol: null };
  }
}

/**
 * Search pools by query (symbol, mint, name).
 *
 * GET /pools?query=...
 *
 * @param {string} query      - Search term (symbol, mint address, or name)
 * @param {Object} [opts]
 * @param {number} [opts.limit=10]  - Max results
 * @returns {Promise<{ query: string, total: number, pools: Array }>}
 */
export async function searchPools(query, opts = {}) {
  const { limit = 10 } = opts;
  const url = `${CONFIG.dlmmDataBase}/pools?query=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  const pools = Array.isArray(data)
    ? data
    : Array.isArray(data.data)
      ? data.data
      : [];

  return {
    query,
    total: Math.min(pools.length, limit),
    pools: pools.slice(0, limit).map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

/**
 * Get PnL for open positions in a specific pool for a wallet.
 *
 * GET /positions/{poolAddress}/pnl?user={wallet}&status=open
 *
 * @param {string} poolAddress
 * @param {string} walletAddress
 * @returns {Promise<Object>}  - { byPosition: { [positionAddress]: pnlData } }
 */
export async function getPoolPnl(poolAddress, walletAddress) {
  const url =
    `${CONFIG.dlmmDataBase}/positions/${poolAddress}/pnl?` +
    `user=${walletAddress}&status=open&pageSize=100&page=1`;

  const data = await fetchJson(url);
  const positions = data.positions || data.data || [];
  const byPosition = {};
  for (const p of positions) {
    const addr = p.positionAddress || p.address || p.position;
    if (addr) byPosition[addr] = p;
  }
  return { byPosition };
}

/**
 * Get all open positions for a wallet across all pools.
 *
 * GET /portfolio/open?user={wallet}
 *
 * @param {string} walletAddress
 * @returns {Promise<{ wallet: string, pools: Array, total_positions: number }>}
 */
export async function getOpenPositions(walletAddress) {
  const url = `${CONFIG.dlmmDataBase}/portfolio/open?user=${walletAddress}`;
  const data = await fetchJson(url);

  const pools = data.pools || [];
  const positions = [];
  for (const pool of pools) {
    for (const positionAddress of pool.listPositions || []) {
      positions.push({
        position: positionAddress,
        pool: pool.poolAddress,
        pool_name: pool.poolName,
        out_of_range: pool.outOfRange || false,
        lower_bin: pool.lowerBinId ?? null,
        upper_bin: pool.upperBinId ?? null,
        active_bin: pool.activeBinId ?? null,
        total_value_usd: numeric(pool.totalValueUsd),
        pnl_usd: numeric(pool.pnlUsd),
        pnl_pct: numeric(pool.pnlPct),
        fees_usd: numeric(pool.claimedFeeUsd),
      });
    }
  }

  return {
    wallet: walletAddress,
    total_positions: positions.length,
    positions,
  };
}

// ════════════════════════════════════════════════════════════════
//  3. JUPITER DATA API
//  Base: https://datapi.jup.ag/v1
// ════════════════════════════════════════════════════════════════

/**
 * Search Jupiter assets (tokens) by symbol or mint.
 *
 * GET /assets/search?query=...
 *
 * @param {string} query  - Symbol or mint address
 * @returns {Promise<Array>}
 */
export async function searchAssets(query) {
  const data = await fetchJson(`${CONFIG.jupDataBase}/assets/search?query=${encodeURIComponent(query)}`);
  return Array.isArray(data) ? data : [data];
}

// ════════════════════════════════════════════════════════════════
//  4. JUPITER PRICE API
//  Base: https://api.jup.ag/price/v3
// ════════════════════════════════════════════════════════════════

/**
 * Get token prices from Jupiter price API.
 *
 * @param {string|string[]} mints  - One or more mint addresses
 * @returns {Promise<Object>}  - { [mint]: { price, confidence, usdChange24h } }
 */
export async function getTokenPrices(mints) {
  const ids = Array.isArray(mints) ? mints.join(",") : mints;
  const data = await fetchJson(`${CONFIG.jupPriceBase}?ids=${encodeURIComponent(ids)}`);
  return data?.data || {};
}

// ════════════════════════════════════════════════════════════════
//  5. WALLET / BALANCE (Helius or RPC)
// ════════════════════════════════════════════════════════════════

/**
 * Get SOL and token balances for a wallet via Helius.
 *
 * GET /v1/wallet/{address}/balances
 *
 * @param {string} walletAddress
 * @param {Object} [opts]
 * @param {string} [opts.heliusApiKey]  - Falls back to HELIUS_API_KEY env
 * @returns {Promise<{ sol: number, tokens: Array }>}
 */
export async function getWalletBalances(walletAddress, opts = {}) {
  const key = opts.heliusApiKey || CONFIG.heliusKey;
  if (!key) throw new Error("Helius API key required — set HELIUS_API_KEY or pass opts.heliusApiKey");

  const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`;
  const data = await fetchJson(url);

  return {
    sol: numeric(data?.solana_balance ?? 0) / 1e9,
    tokens: (data?.tokens || []).map((t) => ({
      mint: t.mint,
      symbol: t.symbol,
      amount: numeric(t.amount) / Math.pow(10, t.decimals || 0),
      decimals: t.decimals,
      usd_value: numeric(t.usd_value),
    })),
  };
}

// ════════════════════════════════════════════════════════════════
//  6. PVP / RIVAL DETECTION
// ════════════════════════════════════════════════════════════════

/**
 * Search for PVP rival pools — other mints with the same symbol
 * that have active Meteora pools.
 *
 * @param {string} symbol      - Token symbol to check
 * @param {string} ownMint     - Your token's mint to exclude
 * @param {Object} [opts]
 * @param {number} [opts.minTvl=5000]
 * @param {number} [opts.minHolders=500]
 * @param {number} [opts.minFeesSol=30]
 * @returns {Promise<Array>}  - Array of rival info objects
 */
export async function findPvpRivals(symbol, ownMint, opts = {}) {
  const { minTvl = 5_000, minHolders = 500, minFeesSol = 30 } = opts;
  const assets = await searchAssets(symbol);
  const rivals = [];

  const normSymbol = String(symbol || "").trim().toUpperCase();
  const normOwnMint = String(ownMint || "").trim();

  for (const asset of assets) {
    const id = asset?.id;
    if (!id || id === normOwnMint) continue;
    if (String(asset?.symbol || "").trim().toUpperCase() !== normSymbol) continue;
    if (Number(asset?.holderCount || 0) < minHolders) continue;
    if (Number(asset?.fees || 0) < minFeesSol) continue;

    // Search for this rival's pool
    const poolUrl =
      `${CONFIG.dlmmDataBase}/pools?query=${encodeURIComponent(id)}` +
      `&sort_by=${encodeURIComponent("tvl:desc")}` +
      `&filter_by=${encodeURIComponent(`tvl>${minTvl}`)}`;

    try {
      const poolData = await fetchJson(poolUrl);
      const poolList = Array.isArray(poolData?.data) ? poolData.data : [];
      const rivalPool = poolList.find(
        (p) => p?.token_x?.address === id || p?.token_y?.address === id
      );
      if (rivalPool) {
        rivals.push({
          symbol,
          mint: id,
          name: asset.name || asset.symbol,
          pool_address: rivalPool.address,
          tvl: numeric(rivalPool.tvl),
          holders: asset.holderCount,
          fees_sol: numeric(asset.fees),
        });
      }
    } catch {
      // Silently skip failed lookups
    }
  }

  return rivals;
}

// ════════════════════════════════════════════════════════════════
//  7. NORMALIZATION
// ════════════════════════════════════════════════════════════════

function normalizePool(pool) {
  if (!pool) return null;
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};

  return {
    // Identity
    pool_address: pool.pool_address || pool.address,
    name: pool.name || `${base.symbol || "?"}-${quote.symbol || "?"}`,
    pair: `${safeStr(base.symbol)}-${safeStr(quote.symbol)}`,

    // Base token
    base_mint: base.address || pool.base_token_address || pool.base_mint || pool.base?.mint,
    base_symbol: base.symbol,
    base_market_cap: numeric(base.market_cap),
    base_organic_score: numeric(base.organic_score),
    base_launchpad: base.launchpad || base.launchpad_platform || null,
    base_created_at: base.created_at ? new Date(base.created_at).getTime() : null,

    // DLMM params
    bin_step: numeric(pool.dlmm_params?.bin_step),
    fee_pct: pool.base_fee_percentage ?? pool.fee_pct,
    fee_active_tvl_ratio: numeric(pool.fee_active_tvl_ratio),

    // Metrics
    tvl: numeric(pool.tvl ?? pool.active_tvl),
    volume: numeric(pool.volume ?? pool.volume_window),
    volume_timeframe: pool.volume_timeframe,
    volatility: numeric(pool.volatility),
    volatility_timeframe: pool.volatility_timeframe || "30m",
    organic_score: numeric(pool.organic_score),

    // Risk
    risk_level: pool.risk_level,
    bundle_pct: numeric(pool.bundle_pct),
    sniper_pct: numeric(pool.sniper_pct),
    suspicious_pct: numeric(pool.suspicious_pct),
    new_wallet_pct: numeric(pool.new_wallet_pct),
    is_rugpull: pool.is_rugpull ?? null,
    is_wash: pool.is_wash ?? null,
    is_honeypot: pool.is_honeypot ?? null,
    is_pvp: pool.is_pvp ?? false,

    // Tags
    smart_money_buy: pool.smart_money_buy ?? false,
    dev_sold_all: pool.dev_sold_all ?? false,
    dex_boost: pool.dex_boost ?? false,
    kols_present: pool.kol_in_clusters ?? false,

    // Raw
    raw: pool,
  };
}

// ════════════════════════════════════════════════════════════════
//  8. UTILITY
// ════════════════════════════════════════════════════════════════

/**
 * Estimate bins_below based on volatility (standard Meteora formula).
 *
 * Formula:
 *   round(minBinsBelow + (vol / 5) * (maxBinsBelow - minBinsBelow))
 *   clamped to [minBinsBelow, maxBinsBelow]
 *
 * @param {number} volatility
 * @param {Object} [opts]
 * @param {number} [opts.minBins=35]
 * @param {number} [opts.maxBins=69]
 * @returns {number|null}  - null if volatility is invalid (<=0)
 */
export function estimateBinsBelow(volatility, opts = {}) {
  const { minBins = 35, maxBins = 69 } = opts;
  const v = numeric(volatility);
  if (v == null || v <= 0) return null;
  const raw = Math.round(minBins + (v / 5) * (maxBins - minBins));
  return Math.max(minBins, Math.min(maxBins, raw));
}

/**
 * Format a pool for LLM-friendly display.
 *
 * @param {Object} pool  - Normalized pool object
 * @returns {string}
 */
export function formatPoolForLLM(pool) {
  if (!pool) return "(no pool data)";
  return [
    `POOL: ${pool.name} (${pool.pool_address})`,
    `  metrics: bin_step=${pool.bin_step}, fee=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume}, tvl=$${pool.tvl}, volatility=${pool.volatility} (${pool.volatility_timeframe})`,
    pool.base_mcap != null ? `  mcap=$${pool.base_market_cap}, organic=${pool.organic_score}` : "",
    pool.risk_level != null ? `  okx: risk=${pool.risk_level}${pool.bundle_pct != null ? `, bundle=${pool.bundle_pct}%` : ""}${pool.is_rugpull != null ? `, rugpull=${pool.is_rugpull ? "YES" : "NO"}` : ""}` : "",
    pool.is_pvp ? `  pvp: HIGH` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
