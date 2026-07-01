/**
 * TP/SL Bot — Telegram integration
 *
 * Single-user monitoring bot. Responsibilities:
 *   - Periodic status reports (every N minutes, anti-spam)
 *   - Immediate close notifications (always send)
 *   - /close command (manual close via Telegram)
 *
 * Does NOT fetch Meteora data directly — receives clean objects.
 * Close is delegated to the same function used by TP/SL (single source of truth).
 */

import TelegramBot from "node-telegram-bot-api";
import { autoSwapToSol } from "./swap.js";

// ─── State ──────────────────────────────────────────────────────
let _bot = null;
let _chatId = null;
let _closeFn = null;        // injected close function
let _getPositionsFn = null; // injected getPositions function
let _awaitingCloseConfirm = false; // waiting for user to reply with position number after /close picker

// ─── Init ───────────────────────────────────────────────────────
export function init({ token, chatId, closeFn, getPositionsFn }) {
  if (!token) throw new Error("Telegram token required");

  _bot = new TelegramBot(token, { polling: false }); // manual polling, no webhook
  _chatId = chatId;
  _closeFn = closeFn;
  _getPositionsFn = getPositionsFn;

  console.log(`[telegram] Bot ready — chat ${chatId}`);
  return _bot;
}

export function getBot() {
  return _bot;
}

// ─── Formatting helpers ─────────────────────────────────────────

function formatPnL(pnl) {
  if (pnl == null) return "?%";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}${pnl.toFixed(2)}%`;
}

function drawRangeBar(lowerBin, upperBin, activeBin) {
  const WIDTH = 20;

  // Above Range
  if (activeBin > upperBin) {
    return `[${"═".repeat(WIDTH)}] →`;
  }

  // In Range
  if (activeBin >= lowerBin && activeBin <= upperBin) {
    const range = upperBin - lowerBin;
    if (range <= 0) return `[${"═".repeat(10)}●${"═".repeat(9)}]`;

    const pos = Math.round(((activeBin - lowerBin) / range) * WIDTH);
    const left = Math.max(0, Math.min(WIDTH - 1, pos));
    const right = WIDTH - left - 1;

    return `[${"═".repeat(left)}●${"═".repeat(right)}]`;
  }

  // Below Range (should never reach here — already closed by OOR below)
  return `[●${"═".repeat(WIDTH - 1)}] ←`;
}

function statusEmoji(status) {
  return status === "IR" ? "🟢" : "🔴";
}

function classifyCloseReason(reason) {
  if (!reason) return "MANUAL_CLOSE";
  const r = reason.toUpperCase();
  if (r.includes("SL") || r.includes("STOP_LOSS")) return "STOP_LOSS";
  if (r.includes("TP") || r.includes("RSI") || r.includes("TAKE_PROFIT")) return "TAKE_PROFIT";
  if (r.includes("MANUAL")) return "MANUAL_CLOSE";
  if (r.includes("OOR")) return "STOP_LOSS"; // OOR below treated as SL
  return "MANUAL_CLOSE";
}

// ─── MarkdownV2 escape ──────────────────────────────────────────
function escapeMD(text) {
  if (typeof text !== "string") return text;
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── Status message formatter ───────────────────────────────────
function formatStatusMessage(positions, timestamp) {
  const lines = positions.map((p) => {
    const emoji = statusEmoji(p.status);
    const pnl = formatPnL(p.pnl_pct);
    const bar = drawRangeBar(p.lower_bin, p.upper_bin, p.active_bin);

    return [
      `${emoji} *${escapeMD(p.pair)}*`,
      `PnL: ${escapeMD(pnl)}`,
      `Status: ${escapeMD(p.status)}`,
      `Active Bin: ${escapeMD(String(p.active_bin ?? "?"))}`,
      "",
      bar,
    ].join("\n");
  });

  const timeStr = new Date(timestamp).toISOString().slice(11, 16) + " UTC";
  return `📊 *Positions* \\(${timeStr}\\)\n\n${lines.join("\n\n")}`;
}

// ─── Close notification formatter ───────────────────────────────
function formatCloseNotification(data) {
  return [
    "🔴 *POSITION CLOSED*",
    "",
    `Pair: *${escapeMD(data.pair)}*`,
    `PnL: ${escapeMD(formatPnL(data.pnl_pct))}`,
    `Reason: ${escapeMD(classifyCloseReason(data.reason))}`,
    `Range: ${escapeMD(String(data.lower_bin ?? "?"))}–${escapeMD(String(data.upper_bin ?? "?"))}`,
    `Active Bin: ${escapeMD(String(data.active_bin ?? "?"))}`,
    `Closed: ${escapeMD(data.timestamp || new Date().toISOString().slice(0, 16).replace("T", " "))} UTC`,
  ].join("\n");
}

// ─── /close command: interactive position list ─────────────────
function formatClosePicker(positions) {
  if (!positions || positions.length === 0) {
    return "No open positions\\.";
  }

  const lines = positions.map((p, i) => {
    return `${escapeMD(String(i + 1))}\\. ${escapeMD(p.pair)} — PnL: ${escapeMD(formatPnL(p.pnl_pct))}`;
  });

  return "📋 **Active Positions**\n\n" + lines.join("\n") + "\n\n_Reply with position number to close\\._";
}

// ─── Close position by list index ──────────────────────────────
async function closeByIndex(idx) {
  if (!_getPositionsFn || !_closeFn) {
    await _bot.sendMessage(_chatId, "Bot not fully initialized.");
    return;
  }

  try {
    const positions = await _getPositionsFn();
    if (idx < 0 || idx >= positions.length) {
      await _bot.sendMessage(_chatId, `Invalid position number. Use 1–${positions.length}.`);
      return;
    }

    const p = positions[idx];
    const reason = "MANUAL_CLOSE";

    const result = await _closeFn(p.position, reason, p.pool);

    if (result.success || result.dry_run) {
      let finalPnl = p.pnl_pct;
      try {
        const refreshed = await _getPositionsFn();
        const found = refreshed.find((rp) => rp.position === p.position);
        if (found) finalPnl = found.pnl_pct;
      } catch {}

      await sendCloseNotification({
        pair: p.pair,
        pnl_pct: finalPnl,
        reason,
        lower_bin: p.lower_bin,
        upper_bin: p.upper_bin,
        active_bin: p.active_bin,
        timestamp: new Date().toISOString().slice(0, 16).replace("T", " "),
      });

      // Auto-swap base token → SOL (non-blocking)
      if (p.base_mint) {
        autoSwapToSol(p.base_mint, p.pair).catch((e) =>
          console.error(`[tp-sl] auto-swap failed: ${e.message}`)
        );
      }
    } else {
      await _bot.sendMessage(_chatId, `❌ Close failed: ${result.error || "unknown"}`);
    }
  } catch (err) {
    await _bot.sendMessage(_chatId, `❌ Error: ${err.message}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Send periodic status report. Suppresses duplicates (anti-spam).
 */
export async function sendStatus(positions) {
  if (!_bot || !_chatId) return;

  // No positions — send once, then suppress (hash prevents duplicate)
  if (!positions || positions.length === 0) {
    try {
      await _bot.sendMessage(_chatId, "📊 *Positions*\n\n_No open positions_", { parse_mode: "MarkdownV2" });
      console.log("[telegram] Status: no positions");
    } catch (err) {
      console.error(`[telegram] Status send failed: ${err.message}`);
      try { await _bot.sendMessage(_chatId, "📊 Positions\n\nNo open positions"); } catch {}
    }
    return;
  }

  // Compute status for each position
  const enriched = positions.map((p) => {
    let status = "IR";
    if (p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin) {
      status = "AR";
    } else if (p.active_bin != null && p.lower_bin != null && p.active_bin < p.lower_bin) {
      // Below Range — should already be closed. Skip from status.
      status = "BR";
    }
    return { ...p, status };
  }).filter((p) => p.status !== "BR");

  if (enriched.length === 0) return;

  const now = new Date();
  const text = formatStatusMessage(enriched, now);

  try {
    await _bot.sendMessage(_chatId, text, { parse_mode: "MarkdownV2" });
    console.log("[telegram] Status sent");
  } catch (err) {
    console.error(`[telegram] Status send failed: ${err.message}`);
    // Retry with plain text if MarkdownV2 fails
    try {
      await _bot.sendMessage(_chatId, text);
    } catch {}
  }
}

/**
 * Send immediate close notification. Always sends, never suppressed.
 */
export async function sendCloseNotification(data) {
  if (!_bot || !_chatId) return;

  const text = formatCloseNotification({
    ...data,
    timestamp: data.timestamp || new Date().toISOString().slice(0, 16).replace("T", " "),
  });

  try {
    await _bot.sendMessage(_chatId, text, { parse_mode: "MarkdownV2" });
    console.log(`[telegram] Close notification: ${data.pair}`);
  } catch (err) {
    console.error(`[telegram] Close notification failed: ${err.message}`);
    try {
      await _bot.sendMessage(_chatId, text);
    } catch {}
  }
}

/**
 * Handle incoming Telegram messages (called from index.js poll loop).
 */
export async function handleMessage(msg) {
  if (!_bot || !_chatId) return;

  const text = msg.text?.trim();
  const fromId = String(msg.chat?.id || msg.from?.id || "");

  // Only respond to authorized chat
  if (fromId !== String(_chatId)) return;

  // ── Numeric reply after /close picker ────────────────────────
  if (_awaitingCloseConfirm) {
    _awaitingCloseConfirm = false;
    const num = parseInt(text, 10);
    if (Number.isFinite(num)) {
      await closeByIndex(num - 1);
    }
    return;
  }

  // ── /close command ──────────────────────────────────────────
  if (text === "/close" || text?.startsWith("/close")) {
    const parts = text.split(/\s+/);
    const num = parseInt(parts[1], 10);

    if (!Number.isFinite(num)) {
      // Show position picker + await numeric reply
      try {
        let positions = [];
        if (_getPositionsFn) {
          positions = await _getPositionsFn();
        }
        const pickerText = formatClosePicker(positions);
        await _bot.sendMessage(_chatId, pickerText, { parse_mode: "MarkdownV2" });
        _awaitingCloseConfirm = true;
      } catch (err) {
        await _bot.sendMessage(_chatId, `Error: ${err.message}`);
      }
      return;
    }

    // Direct /close 1
    await closeByIndex(num - 1);
  }
}
