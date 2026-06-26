/**
 * TP/SL Bot — Main entry
 *
 * Standalone TP/SL monitor for Meteora DLMM positions on Solana.
 *
 * Close conditions:
 *   1. Stop Loss:     pnl_pct <= slPct (config.json: stopLoss.pnlPct, default -10%)
 *   2. OOR below:      active_bin < lower_bin (direct close, no grace period)
 *   3. RSI Take Profit: RSI(2) > 90 on 1h via GMGN klines
 *
 * Telegram:
 *   - Status report every N minutes (configurable, default 10)
 *   - Immediate close notifications
 *   - /close command for manual position close
 */

import { runCycle, onClose, onStatus } from "./monitor.js";
import { getOpenPositions, closePosition } from "./meteora.js";
import { init, sendCloseNotification, sendStatus, handleMessage } from "./telegram.js";
import { config } from "./config.js";

const MONITOR_INTERVAL = config.monitor.intervalSeconds * 1000;
const STATUS_INTERVAL = (config.telegram.statusIntervalMinutes || 10) * 60 * 1000;

// ─── Startup banner ─────────────────────────────────────────────
console.log("════════════════════════════════════════");
console.log("  TP/SL Bot — Meteora DLMM Monitor");
console.log("════════════════════════════════════════");
console.log(`  RPC:        ${config.rpcUrl.slice(0, 30)}...`);
console.log(`  SL:         ${config.stopLoss.pnlPct}%`);
console.log(`  RSI TP:     > ${config.takeProfit.rsiOverbought} (${config.takeProfit.rsiTimeframe}, period ${config.takeProfit.rsiPeriod})`);
console.log(`  OOR below:  ${config.oorBelow.enabled ? "on" : "off"}`);
console.log(`  Monitor:    every ${config.monitor.intervalSeconds}s`);
console.log(`  Telegram:   ${config.telegram.token ? `status every ${config.telegram.statusIntervalMinutes}m` : "disabled"}`);
console.log(`  Dry run:    ${config.monitor.dryRun ? "YES" : "no"}`);
console.log("════════════════════════════════════════\n");

// ─── Telegram init ──────────────────────────────────────────────
let telegramPollInterval = null;

if (config.telegram.token && config.telegram.chatId) {
  init({
    token: config.telegram.token,
    chatId: config.telegram.chatId,
    closeFn: closePosition,
    getPositionsFn: getOpenPositions,
  });

  // Wire callbacks: monitor → telegram
  onClose(async (data) => {
    await sendCloseNotification(data);
  });

  // ── Periodic status (dedicated timer, independent of monitor cycle) ──

  async function sendStatusReport() {
    try {
      const positions = await getOpenPositions();

      const data = positions.map((p) => {
        let status = "IR";
        if (p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin) status = "AR";
        return { pair: p.pair, pnl_pct: p.pnl_pct, active_bin: p.active_bin, lower_bin: p.lower_bin, upper_bin: p.upper_bin, status };
      });

      await sendStatus(data);
    } catch (err) {
      console.error(`[telegram] Status error: ${err.message}`);
    }
  }

  // Fire status on clock-aligned 10-min marks (00, 10, 20, 30, 40, 50)
  function scheduleNextReport() {
    const now = new Date();
    const minutes = now.getMinutes();
    const next = (Math.floor(minutes / 10) + 1) * 10;
    const target = new Date(now);
    target.setMinutes(next, 0, 0, 0);
    const delay = target.getTime() - now.getTime();
    return delay;
  }

  // Immediately fire first report, then align to clock
  await sendStatusReport();
  setTimeout(function tickStatus() {
    sendStatusReport().catch(e => console.error('[telegram] Status error:', e.message));
    setTimeout(tickStatus, scheduleNextReport());
  }, scheduleNextReport());

  // ── Telegram polling for /close commands ─────────────────────
  // node-telegram-bot-api polling = false, so we poll manually
  const TELEGRAM_POLL_MS = 5000;
  let _telegramOffset = 0;

  telegramPollInterval = setInterval(async () => {
    try {
      const bot = (await import("./telegram.js")).getBot();
      if (!bot) return;

      const updates = await bot.getUpdates({
        offset: _telegramOffset,
        timeout: 0,
        limit: 5,
      });

      for (const update of updates) {
        _telegramOffset = update.update_id + 1;
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (err) {
      // silently ignore transient polling errors
    }
  }, TELEGRAM_POLL_MS);

  console.log(`[telegram] Polling for commands every ${TELEGRAM_POLL_MS / 1000}s`);
} else {
  console.log("[telegram] Not configured — status/commands disabled");
}

// ─── Monitor cycle ──────────────────────────────────────────────
async function tick() {
  try {
    await runCycle();
  } catch (err) {
    console.error(`[tp-sl] Cycle error: ${err.message}`);
  }
}

// First run immediately
await tick();

// Schedule monitor
setInterval(tick, MONITOR_INTERVAL);
console.log(`[tp-sl] Monitoring every ${config.monitor.intervalSeconds}s`);
console.log(`[tp-sl] Status reports every ${config.telegram.statusIntervalMinutes}m\n`);
