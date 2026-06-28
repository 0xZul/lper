/**
 * TP/SL Bot — Jupiter swap to SOL
 *
 * Adapted from /root/meteora/tools/wallet.js (swapToken).
 * Stripped to essentials: no referral, no Helius, no dry_run.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";

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

/**
 * Get SPL token balance for a given mint.
 */
export async function getTokenBalance(mint) {
  const wallet = getWallet();
  const connection = getConnection();
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(mint) }
    );
    let total = 0;
    for (const { account } of tokenAccounts.value) {
      const amount = account.data.parsed.info.tokenAmount;
      total += amount.uiAmount || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Swap token to SOL via Jupiter Swap V2.
 */
export async function swapToSol(inputMint, amount) {
  const wallet = getWallet();
  const connection = getConnection();

  try {
    // Get decimals
    let decimals = 9;
    if (inputMint !== SOL_MINT) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(inputMint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // Get order
    const search = new URLSearchParams({
      inputMint,
      outputMint: SOL_MINT,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });

    const orderRes = await fetch(`${JUPITER_SWAP_V2_API}/order?${search}`, {
      headers: { "x-api-key": "b15d42e9-e0e4-4f90-a424-ae41ceeaa382" },
    });
    if (!orderRes.ok) throw new Error(`Jupiter order: ${orderRes.status}`);

    const order = await orderRes.json();
    if (order.errorCode) throw new Error(`Jupiter: ${order.errorMessage || order.errorCode}`);

    const { transaction: unsignedTx, requestId } = order;

    // Sign
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // Execute
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "b15d42e9-e0e4-4f90-a424-ae41ceeaa382",
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) throw new Error(`Jupiter execute: ${execRes.status}`);

    const result = await execRes.json();
    if (result.status === "Failed") throw new Error(`Swap failed: code=${result.code}`);

    return {
      success: true,
      tx: result.signature,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
    };
  } catch (err) {
    console.warn(`[swap] ${inputMint.slice(0, 8)} → SOL failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Auto-swap all of a token to SOL (if balance > 0).
 */
export async function autoSwapToSol(baseMint, label = "") {
  const balance = await getTokenBalance(baseMint);
  if (balance <= 0) {
    console.log(`[swap] ${label} — no ${baseMint.slice(0, 8)} balance`);
    return null;
  }

  console.log(`[swap] ${label} — swapping ${balance} ${baseMint.slice(0, 8)} → SOL`);
  return await swapToSol(baseMint, balance);
}
