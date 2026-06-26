/**
 * TP/SL Bot — Position monitor
 *
 * Runs one check cycle over all open positions.
 * Close conditions (adopted from /meteora/index.js):
 *   1. Stop Loss: pnl_pct <= slPct (Rule 1, percentage-based)
 *   2. OOR below: active_bin < lower_bin (Rule 6, direct close)
 *   3. RSI TP: RSI(2) > 90 on 1h via GMGN (new)
 *
 * Hooks (set by index.js):
 *   onClose(positionData) — called after each close (for Telegram notification)
 *   onStatus(positions)   — called after each check cycle (for status report)
 */

import { getOpenPositions, closePosition } from "./meteora.js";
import { checkRSI } from "./indicator.js";
import { config } from "./config.js";

// ─── Callback hooks ─────────────────────────────────────────────
let _onClose = null;
let _onStatus = null;

/** @param {(data: object) => Promise<void>} fn */
export function onClose(fn) { _onClose = fn; }

/** @param {(positions: object[]) => Promise<void>} fn */
export function onStatus(fn) { _onStatus = fn; }

// ─── Derive status ─────────────────────────────────────────────
function deriveStatus(p) {
  if (p.active_bin != null && p.lower_bin != null && p.active_bin < p.lower_bin) return "BR";
  if (p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin) return "AR";
  return "IR";
}

// ─── Build close notification data ─────────────────────────────
function buildCloseData(p, reason) {
  return {
    position: p.position,
    pair: p.pair,
    pnl_pct: p.pnl_pct,
    reason,
    lower_bin: p.lower_bin,
    upper_bin: p.upper_bin,
    active_bin: p.active_bin,
    timestamp: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
}

// ─── Build status data (clean object for telegram.js) ──────────
function buildStatusData(p) {
  return {
    pair: p.pair,
    pnl_pct: p.pnl_pct,
    active_bin: p.active_bin,
    lower_bin: p.lower_bin,
    upper_bin: p.upper_bin,
    status: deriveStatus(p),
  };
}

/**
 * Run one monitoring cycle.
 * @returns {Promise<{checked: number, closed: Array}>}
 */
export async function runCycle() {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ── TP/SL check ──`);

  // ── Fetch positions ──────────────────────────────────────────
  let positions;
  try {
    positions = await getOpenPositions();
  } catch (err) {
    console.error(`[tp-sl] Failed to fetch positions: ${err.message}`);
    return { checked: 0, closed: [] };
  }

  if (positions.length === 0) {
    console.log("[tp-sl] No open positions");
    return { checked: 0, closed: [] };
  }

  console.log(`[tp-sl] Checking ${positions.length} position(s)...`);

  // ── Evaluate each position ────────────────────────────────────
  const toClose = [];

  for (const p of positions) {
    const reasons = [];

    // Check 1: Stop Loss (percentage)
    if (p.pnl_pct != null && p.pnl_pct <= config.stopLoss.pnlPct) {
      reasons.push(`SL: PnL ${p.pnl_pct.toFixed(2)}% <= ${config.stopLoss.pnlPct}%`);
    }

    // Check 2: OOR below (direct close)
    if (
      config.oorBelow.enabled &&
      p.active_bin != null &&
      p.lower_bin != null &&
      p.active_bin < p.lower_bin
    ) {
      reasons.push(`OOR below: active bin ${p.active_bin} < lower ${p.lower_bin}`);
    }

    // Check 3: RSI TP (indicator) — only if PnL >= minPnlPct
    if (reasons.length === 0 && p.base_mint) {
      const rsi = await checkRSI(p.base_mint);
      if (rsi.triggered) {
        if (p.pnl_pct != null && p.pnl_pct >= config.takeProfit.minPnlPct) {
          reasons.push(`TP: ${rsi.reason} | PnL ${p.pnl_pct.toFixed(2)}%`);
        } else {
          console.log(`  ${p.pair.padEnd(14)} RSI ${rsi.rsi} — skipped (PnL ${p.pnl_pct?.toFixed(2) ?? "?"}% < ${config.takeProfit.minPnlPct}%)`);
        }
      } else if (rsi.rsi == null) {
        console.warn(`[tp-sl] RSI unavailable for ${p.pair}: ${rsi.reason}`);
      } else {
        console.log(`  ${p.pair.padEnd(14)} RSI ${rsi.rsi} — ${rsi.reason}`);
      }
    }

    if (reasons.length > 0) {
      toClose.push({ ...p, closeReasons: reasons });
    }
  }

  // ── Execute closes ────────────────────────────────────────────
  const closed = [];
  for (const p of toClose) {
    const reason = p.closeReasons.join(" | ");
    console.log(`[tp-sl] CLOSE ${p.pair} (${p.position.slice(0, 8)}): ${reason}`);

    try {
      const result = await closePosition(p.position, reason, p.pool);
      if (result.success || result.dry_run) {
        const closeData = buildCloseData(p, reason);
        closed.push(closeData);
        console.log(`[tp-sl]   ✓ closed${result.dry_run ? " (dry run)" : ""}`);

        // Immediate close notification (always send)
        if (_onClose) {
          await _onClose(closeData).catch((e) =>
            console.error(`[tp-sl] onClose hook failed: ${e.message}`)
          );
        }
      } else {
        console.error(`[tp-sl]   ✗ failed: ${result.error || "unknown"}`);
      }
    } catch (err) {
      console.error(`[tp-sl]   ✗ error: ${err.message}`);
    }
  }

  const summary = closed.length > 0
    ? closed.map((c) => `  ${c.pair}: ${c.reason}`).join("\n")
    : "  no action";

  console.log(`[tp-sl] Done — checked ${positions.length}, closed ${closed.length}`);
  if (closed.length > 0) console.log(summary);

  // ── Status hook (for periodic Telegram report) ────────────────
  if (_onStatus) {
    const statusData = positions
      .filter((p) => !closed.some((c) => c.position === p.position)) // exclude just-closed
      .map(buildStatusData);
    await _onStatus(statusData).catch((e) =>
      console.error(`[tp-sl] onStatus hook failed: ${e.message}`)
    );
  }

  return { checked: positions.length, closed };
}
