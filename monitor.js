/**
 * TP/SL Bot — Position monitor
 *
 * Runs one check cycle over all open positions.
 * Close conditions (adopted from /meteora/index.js):
 *   1. Stop Loss: pnl_pct <= slPct (Rule 1, percentage-based)
 *   2. OOR below: active_bin < lower_bin (Rule 6, direct close)
 *   3. RSI TP: RSI(2) > 90 on 1h via GMGN (new)
 */

import { getOpenPositions, closePosition } from "./meteora.js";
import { checkRSI } from "./indicator.js";
import { config } from "./config.js";

/**
 * Run one monitoring cycle.
 * @returns {Promise<{checked: number, closed: Array<{position:string, pair:string, reason:string}>}>}
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
    let closeAction = null;

    // ── Check 1: Stop Loss (percentage) ─────────────────────────
    if (p.pnl_pct != null && p.pnl_pct <= config.stopLoss.pnlPct) {
      reasons.push(`SL: PnL ${p.pnl_pct.toFixed(2)}% <= ${config.stopLoss.pnlPct}%`);
    }

    // ── Check 2: OOR below (direct close) ───────────────────────
    if (
      config.oorBelow.enabled &&
      p.active_bin != null &&
      p.lower_bin != null &&
      p.active_bin < p.lower_bin
    ) {
      reasons.push(`OOR below: active bin ${p.active_bin} < lower ${p.lower_bin}`);
    }

    // ── Check 3: RSI TP (indicator) ─────────────────────────────
    if (reasons.length === 0 && p.base_mint) {
      const rsi = await checkRSI(p.base_mint);
      if (rsi.triggered) {
        reasons.push(`TP: ${rsi.reason}`);
      } else {
        console.log(`  ${p.pair.padEnd(14)} RSI ${rsi.rsi ?? "?"} — ${rsi.reason}`);
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
      const result = await closePosition(p.position, reason);
      if (result.success || result.dry_run) {
        closed.push({ position: p.position, pair: p.pair, reason });
        console.log(`[tp-sl]   ✓ closed${result.dry_run ? " (dry run)" : ""}`);
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

  return { checked: positions.length, closed };
}
