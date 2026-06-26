/**
 * TP/SL Bot — Meteora DLMM interaction
 *
 * Reuses patterns from /meteora/tools/dlmm.js but stripped to essentials:
 *   - getOpenPositions: Meteora portfolio API → PnL API enrich
 *   - closePosition: local SDK path (claim → remove liquidity → Jupiter swap)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config } from "./config.js";

// ─── Lazy connection / wallet ──────────────────────────────────
let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(config.rpcUrl, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    _wallet = Keypair.fromSecretKey(bs58.decode(config.walletKey));
  }
  return _wallet;
}

// ─── Lazy DLMM SDK (dynamic import, like /meteora pattern) ─────
let _DLMM = null;
let _getPriceOfBinByBinId = null;
let _getBinIdFromPrice = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
  }
  return { DLMM: _DLMM, getPriceOfBinByBinId: _getPriceOfBinByBinId, getBinIdFromPrice: _getBinIdFromPrice };
}

// ─── Pool cache (TTL 5 min, same as /meteora) ──────────────────
const poolCache = new Map();
setInterval(() => poolCache.clear(), 5 * 60 * 1000);

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    poolCache.set(key, await DLMM.create(getConnection(), new PublicKey(poolAddress)));
  }
  return poolCache.get(key);
}

// ─── Fetch PnL data per pool (lowerBinId, upperBinId, activeBin, etc.) ──
async function fetchPnlForPool(poolAddress, walletAddress) {
  const byPosition = {};
  try {
    const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=50&page=1`;
    const res = await fetch(url);
    if (!res.ok) return byPosition;
    const data = await res.json();
    for (const entry of data.positions || []) {
      byPosition[entry.positionAddress] = entry;
    }
  } catch (e) {
    // silently skip — bin data will be null
  }
  return byPosition;
}

// ─── Get Open Positions ────────────────────────────────────────
export async function getOpenPositions() {
  const wallet = getWallet();
  const walletAddress = wallet.publicKey.toString();

  // Portfolio API
  const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
  const res = await fetch(portfolioUrl);
  if (!res.ok) throw new Error(`Portfolio API ${res.status}`);
  const portfolio = await res.json();
  const pools = portfolio.pools || [];

  // Enrich with PnL data (parallel)
  const pnlMaps = await Promise.all(
    pools.map((pool) => fetchPnlForPool(pool.poolAddress, walletAddress))
  );

  const positions = [];
  pools.forEach((pool, i) => {
    const pnlMap = pnlMaps[i];
    for (const posAddr of pool.listPositions || []) {
      const pnlEntry = pnlMap[posAddr];

      // PnL: use native SOL PnL % (matches solMode)
      const pnlPct = pnlEntry ? parseFloat(pnlEntry.pnlSolPctChange || 0) : null;
      const lowerBin = pnlEntry?.lowerBinId ?? null;
      const upperBin = pnlEntry?.upperBinId ?? null;
      const activeBin = pnlEntry?.poolActiveBinId ?? null;
      const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(posAddr);

      positions.push({
        position: posAddr,
        pool: pool.poolAddress,
        pair: `${pool.tokenX || "?"}/${pool.tokenY || "?"}`,
        base_mint: pool.tokenXMint,
        lower_bin: lowerBin,
        upper_bin: upperBin,
        active_bin: activeBin,
        in_range: pnlEntry ? !pnlEntry.isOutOfRange : !isOOR,
        pnl_pct: pnlPct,
        total_value_sol: pnlEntry
          ? parseFloat(pnlEntry.unrealizedPnl?.balancesSol || 0)
          : null,
        unclaimed_fees_sol: pnlEntry
          ? parseFloat(pnlEntry.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) +
            parseFloat(pnlEntry.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
          : null,
      });
    }
  });

  return positions;
}

// ─── Lookup pool for a position ────────────────────────────────
async function lookupPoolForPosition(positionAddress, walletAddress) {
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );
  for (const [lbPairKey, data] of Object.entries(allPositions)) {
    for (const pos of data.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === positionAddress) return lbPairKey;
    }
  }
  throw new Error(`Position ${positionAddress} not found`);
}

// ─── Close Position (local SDK path) ────────────────────────────
export async function closePosition(positionAddress, reason = "", knownPoolAddress = null) {
  if (config.monitor.dryRun) {
    return { dry_run: true, position: positionAddress, reason };
  }

  const wallet = getWallet();
  const walletAddr = wallet.publicKey.toString();
  const poolAddress = knownPoolAddress || await lookupPoolForPosition(positionAddress, walletAddr);

  const pool = await getPool(poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  const txs = [];

  // Step 1: Claim fees
  try {
    const posData = await pool.getPosition(positionPubKey);
    const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: posData });
    if (claimTxs?.length) {
      for (const tx of claimTxs) {
        const hash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        txs.push({ step: "claim", hash });
      }
    }
  } catch (e) {
    console.warn(`[tp-sl] Claim warning: ${e.message}`);
  }

  // Step 2: Remove liquidity
  let closeFromBinId = -887272;
  let closeToBinId = 887272;
  try {
    const posData = await pool.getPosition(positionPubKey);
    const processed = posData?.positionData;
    if (processed) {
      closeFromBinId = processed.lowerBinId ?? closeFromBinId;
      closeToBinId = processed.upperBinId ?? closeToBinId;
    }
  } catch {}

  const closeTx = await pool.removeLiquidity({
    user: wallet.publicKey,
    position: positionPubKey,
    fromBinId: closeFromBinId,
    toBinId: closeToBinId,
    bps: new BN(10000),
    shouldClaimAndClose: true,
  });

  for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
    const hash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
    txs.push({ step: "close", hash });
  }

  // Invalidate pool cache
  poolCache.delete(poolAddress.toString());

  return {
    success: true,
    position: positionAddress,
    pool: poolAddress,
    reason,
    txs: txs.map((t) => t.hash),
  };
}
