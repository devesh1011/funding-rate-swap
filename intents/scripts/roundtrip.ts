// Mainnet round trip through NEAR Intents, ≤ 5 USDC (plan, phase 3):
//
//   1. in     NEAR USDC → 1Click → swap contract `ft_transfer_call`,
//             msg {"credit_to": trader}  (the one-step deposit, plan 3.4)
//   2. margin rest a small order on a live market, then cancel it
//   3. out    `withdraw` → NEAR USDC → 1Click → Hyperliquid perp / Base / Arbitrum
//
// Every step is a real mainnet transaction or a real 1Click swap. Without
// `--i-confirm-mainnet` it only checks the setup and prints dry quotes.
//
//   NEAR_NETWORK=mainnet SWAP_CONTRACT=<contract> COLLATERAL_TOKEN=17208628…
//   TRADER_ACCOUNT=<you>.near  (key in TRADER_PRIVATE_KEY or ~/.near-credentials/mainnet)
//   pnpm roundtrip --amount 2 --out hyperliquid:0x… [--i-confirm-mainnet]

import { parseArgs } from "node:util";
import { config } from "@fundswap/bots/config";
import { call, loadAccount, swap, view } from "@fundswap/bots/near";
import { aprToTick, formatUsdc } from "@fundswap/bots/units";
import {
  depositToSwapQuote,
  findToken,
  hyperliquidUsdc,
  nearUsdc,
  nep141Contract,
  oneClick,
  withdrawFromNearQuote,
  type QuoteResponse,
  type StatusResponse,
  type Token,
} from "../src/oneclick.ts";

const MAX_USDC = 5;
const ORDER_SIZE = 50_000_000n; // 50 YU: initial margin well under 1 USDC
const STORAGE_DEPOSIT_YOCTO = 100_000_000_000_000_000_000_000n; // 0.1 NEAR

const { values: a } = parseArgs({
  options: {
    amount: { type: "string", default: "2" },
    out: { type: "string" },
    "i-confirm-mainnet": { type: "boolean", default: false },
  },
});
const live = a["i-confirm-mainnet"];

const fail = (msg: string): never => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};
const step = (msg: string, data?: object) => console.log(`\n▸ ${msg}${data ? `\n  ${JSON.stringify(data)}` : ""}`);

// ---------------------------------------------------------------- preflight

if (config.network !== "mainnet") fail("set NEAR_NETWORK=mainnet");
const amountUsdc = Number(a.amount);
if (!(amountUsdc >= 0.5 && amountUsdc <= MAX_USDC)) fail(`--amount must be 0.5–${MAX_USDC} USDC`);
const [outChain, outAddress] = (a.out ?? "").split(":");
if (!outAddress?.match(/^0x[0-9a-fA-F]{40}$/) || !["hyperliquid", "base", "arb"].includes(outChain))
  fail("--out must be hyperliquid:0x…, base:0x… or arb:0x…");

const api = oneClick({ jwt: process.env.ONECLICK_JWT });
const tokens = await api.tokens();
const usdc = nearUsdc(tokens);
const amount = BigInt(Math.round(amountUsdc * 10 ** usdc.decimals));
const destination: Token = outChain === "hyperliquid" ? hyperliquidUsdc(tokens) : findToken(tokens, "USDC", outChain);

const trader = loadAccount("TRADER", "");
const cfg = await view<{ collateral: string; deposit_cap: string | null; intents_contract: string | null }>(config.swap, "get_config");
if (cfg.collateral !== nep141Contract(usdc.assetId)) fail(`contract collateral ${cfg.collateral} is not NEAR USDC`);
if (cfg.collateral !== config.collateral) fail("COLLATERAL_TOKEN does not match the contract");
if (!cfg.deposit_cap || BigInt(cfg.deposit_cap) > BigInt(10 * 10 ** usdc.decimals)) fail("mainnet contract must cap deposits at ≤ 10 USDC");
const balance = BigInt(await view<string>(config.collateral, "ft_balance_of", { account_id: trader.accountId }));
if (balance < amount) fail(`${trader.accountId} holds ${formatUsdc(balance)} USDC, needs ${a.amount}`);
const market = (await swap.markets()).find((m) => m.effective_mode === "Active") ?? fail("no active market");

console.log(`Round trip on mainnet, ${live ? "LIVE" : "dry run (add --i-confirm-mainnet to execute)"}`);
console.log({ trader: trader.accountId, swap: config.swap, amount: `${a.amount} USDC`, out: `${destination.blockchain} ${outAddress}`, market: market.name });

const show = (r: QuoteResponse) => ({
  in: r.quote.amountInFormatted,
  out: r.quote.amountOutFormatted,
  depositAddress: r.quote.depositAddress,
  deadline: r.quote.deadline,
  correlationId: r.correlationId,
});
const inReq = (dry: boolean) =>
  depositToSwapQuote({ dry, origin: usdc, collateral: usdc, amount, refundTo: trader.accountId, swapContract: config.swap, trader: trader.accountId });
const outReq = (dry: boolean, amt: bigint) =>
  withdrawFromNearQuote({ dry, collateral: usdc, destination, amount: amt, recipient: outAddress, trader: trader.accountId });

if (!live) {
  step("dry quote, in", show(await api.quote(inReq(true))));
  step("dry quote, out", show(await api.quote(outReq(true, amount))));
  process.exit(0);
}

// ---------------------------------------------------------------- live

/** ft_transfer to a 1Click deposit address, notify 1Click, wait for a terminal status. */
async function sendToOneClick(q: QuoteResponse): Promise<StatusResponse> {
  const depositAddress = q.quote.depositAddress ?? fail("quote has no deposit address");
  const t = await call(trader, config.collateral, "ft_transfer", { receiver_id: depositAddress, amount: q.quote.amountIn }, { depositYocto: 1n, gasTera: 50 });
  step("ft_transfer to 1Click deposit address", { tx: config.explorer(t.hash) });
  await api.submitDeposit({ txHash: t.hash, depositAddress, nearSenderAccount: trader.accountId }).catch(() => {});
  const s = await api.waitFor(depositAddress, { onChange: (x) => console.log(`  1Click status ${x.status}`) });
  step(`1Click ${s.status}`, s.swapDetails);
  return s;
}

const before = await swap.account(trader.accountId);
if (!before?.storage_paid) {
  const r = await call(trader, config.swap, "storage_deposit", {}, { depositYocto: STORAGE_DEPOSIT_YOCTO });
  step("swap storage_deposit 0.1 NEAR", { tx: config.explorer(r.hash) });
}
const cash0 = BigInt(before?.cash ?? "0");

// 1. in
const qIn = await api.quote(inReq(false));
step("quote, in (committed)", show(qIn));
const sIn = await sendToOneClick(qIn);
if (sIn.status !== "SUCCESS") fail(`deposit ended ${sIn.status}; nothing reached the contract, see refund above`);
let cash1 = cash0;
for (let i = 0; i < 20 && cash1 === cash0; i++) {
  await new Promise((r) => setTimeout(r, 3_000));
  cash1 = BigInt((await swap.account(trader.accountId))?.cash ?? "0");
}
if (cash1 === cash0) fail("1Click reports SUCCESS but the contract has not credited the trader yet; check the destination tx");
step(`margin credited by ft_on_transfer: +${formatUsdc(cash1 - cash0)} USDC`);

// 2. margin in use
const tick = aprToTick(BigInt(market.mark)) - 200; // 2 % APR under mark: rests, doesn't cross
const placed = await call<{ filled: string; order_id: string | null }>(
  trader, config.swap, "place_order",
  { market_id: market.id, side: "Long", size: ORDER_SIZE.toString(), tick, kind: "Limit" },
  { gasTera: 200 },
);
step(`place_order Long 50 YU @ tick ${tick} on ${market.name}`, { tx: config.explorer(placed.hash), result: placed.value });
if (placed.value?.filled !== "0") fail("order filled; a position is open, so withdraw manually after closing it");
const health = (await swap.account(trader.accountId))!.health;
step("health with the resting order", { initial_margin: formatUsdc(BigInt(health.initial_margin)), withdrawable: formatUsdc(BigInt(health.withdrawable)) });
const cancelled = await call(trader, config.swap, "cancel_order", { order_id: placed.value!.order_id }, { gasTera: 50 });
step("cancel_order", { tx: config.explorer(cancelled.hash) });

// 3. out
const withdrawable = BigInt((await swap.account(trader.accountId))!.health.withdrawable);
const w = await call(trader, config.swap, "withdraw", { amount: withdrawable.toString() }, { depositYocto: 1n, gasTera: 100 });
step(`withdraw ${formatUsdc(withdrawable)} USDC`, { tx: config.explorer(w.hash) });
const qOut = await api.quote(outReq(false, withdrawable));
step("quote, out (committed)", show(qOut));
const sOut = await sendToOneClick(qOut);
step(sOut.status === "SUCCESS" ? "round trip complete" : `out leg ended ${sOut.status}`);
process.exitCode = sOut.status === "SUCCESS" ? 0 : 1;

