/**
 * TP/SL Bot — config loader
 *
 * Secrets from .env, thresholds from config.json (with defaults).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");

// ─── .env ───────────────────────────────────────────────────────
import "dotenv/config";

// ─── config.json (optional) ────────────────────────────────────
let user = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.error(`[tp-sl] Invalid config.json: ${e.message}`);
    process.exit(1);
  }
}

// ─── Exports ────────────────────────────────────────────────────
export const config = {
  // RPC & wallet
  rpcUrl: process.env.RPC_URL || "",
  walletKey: process.env.WALLET_PRIVATE_KEY || "",

  // TP thresholds
  takeProfit: {
    rsiPeriod: user.takeProfit?.rsiPeriod ?? 2,
    rsiOverbought: user.takeProfit?.rsiOverbought ?? 90,
    rsiTimeframe: user.takeProfit?.rsiTimeframe ?? "1h",
    minPnlPct: user.takeProfit?.minPnlPct ?? 1,
  },

  // SL thresholds
  stopLoss: {
    pnlPct: user.stopLoss?.pnlPct ?? -10,
  },

  // OOR below — close immediately
  oorBelow: {
    enabled: user.oorBelow?.enabled ?? true,
  },

  // Schedule
  monitor: {
    intervalSeconds: user.monitor?.intervalSeconds ?? 60,
    dryRun: user.monitor?.dryRun ?? (process.env.DRY_RUN === "true"),
  },

  // Telegram
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || user.telegram?.token || "",
    chatId: process.env.TELEGRAM_CHAT_ID || String(user.telegram?.chatId || ""),
    statusIntervalMinutes: user.telegram?.statusIntervalMinutes ?? 10,
  },
};

// Validate required
if (!config.rpcUrl) {
  console.error("[tp-sl] RPC_URL is required in .env");
  process.exit(1);
}
if (!config.walletKey) {
  console.error("[tp-sl] WALLET_PRIVATE_KEY is required in .env");
  process.exit(1);
}
