/**
 * TP/SL Bot — Main entry
 *
 * Standalone TP/SL monitor for Meteora DLMM positions on Solana.
 *
 * Usage:  node index.js
 *
 * Close conditions:
 *   1. Stop Loss:     pnl_pct <= slPct (config.json: stopLoss.pnlPct, default -10%)
 *   2. OOR below:      active_bin < lower_bin (direct close, no grace period)
 *   3. RSI Take Profit: RSI(2) > 90 on 1h via GMGN klines
 *
 * Config:
 *   .env        — RPC_URL, WALLET_PRIVATE_KEY, DRY_RUN
 *   config.json — thresholds (optional, defaults used if missing)
 */

import { runCycle } from "./monitor.js";
import { config } from "./config.js";

const INTERVAL = config.monitor.intervalSeconds * 1000;

console.log("════════════════════════════════════════");
console.log("  TP/SL Bot — Meteora DLMM Monitor");
console.log("════════════════════════════════════════");
console.log(`  RPC:        ${config.rpcUrl.slice(0, 30)}...`);
console.log(`  SL:         ${config.stopLoss.pnlPct}%`);
console.log(`  RSI TP:     > ${config.takeProfit.rsiOverbought} (${config.takeProfit.rsiTimeframe}, period ${config.takeProfit.rsiPeriod})`);
console.log(`  OOR below:  ${config.oorBelow.enabled ? "on" : "off"}`);
console.log(`  Interval:   ${config.monitor.intervalSeconds}s`);
console.log(`  Dry run:    ${config.monitor.dryRun ? "YES" : "no"}`);
console.log("════════════════════════════════════════\n");

// ─── Run immediately, then on interval ─────────────────────────
async function tick() {
  try {
    await runCycle();
  } catch (err) {
    console.error(`[tp-sl] Cycle error: ${err.message}`);
  }
}

// First run
await tick();

// Schedule
setInterval(tick, INTERVAL);
console.log(`[tp-sl] Next check in ${config.monitor.intervalSeconds}s...`);
