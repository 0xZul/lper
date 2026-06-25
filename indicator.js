/**
 * TP/SL Bot — RSI indicator (GMGN klines)
 */

import { OpenApiClient } from "gmgn-cli/dist/client/OpenApiClient.js";
import { getConfig as getGMGNConfig } from "gmgn-cli/dist/config.js";
import { config } from "./config.js";

// ─── Lazy GMGN client ──────────────────────────────────────────
let _gmgn = null;
function gmgn() {
  if (!_gmgn) _gmgn = new OpenApiClient(getGMGNConfig());
  return _gmgn;
}

// ─── RSI(2) with Wilder's smoothing ────────────────────────────
function calculateRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── RSI Take Profit check ─────────────────────────────────────
/**
 * @param {string} mint - Token mint
 * @returns {Promise<{triggered: boolean, reason: string, rsi: number|null}>}
 */
export async function checkRSI(mint) {
  if (!mint) return { triggered: false, reason: "no mint", rsi: null };

  const { rsiPeriod, rsiOverbought, rsiTimeframe } = config.takeProfit;

  try {
    const fromMs = Date.now() - 24 * 60 * 60 * 1000; // 24h of 1h candles
    const data = await gmgn().getTokenKline("sol", mint, rsiTimeframe, fromMs);
    const bars = data?.list;

    if (!bars || bars.length < 6) {
      return { triggered: false, reason: `insufficient data (${bars?.length ?? 0})`, rsi: null };
    }

    const closes = bars.map((b) => parseFloat(b.close));
    const rsi = calculateRSI(closes, rsiPeriod);
    if (rsi == null) return { triggered: false, reason: "calculation failed", rsi: null };

    if (rsi > rsiOverbought) {
      return {
        triggered: true,
        reason: `RSI(${rsiPeriod})=${rsi.toFixed(1)} > ${rsiOverbought} on ${rsiTimeframe}`,
        rsi: Math.round(rsi * 10) / 10,
      };
    }

    return { triggered: false, reason: `ok (${rsi.toFixed(1)})`, rsi: Math.round(rsi * 10) / 10 };
  } catch (err) {
    return { triggered: false, reason: `error: ${err.message}`, rsi: null };
  }
}
