// Live dry quotes for every route the app uses. Nothing is executed and no
// deposit address is created (`dry: true`), so this is safe to run anytime.
//
//   pnpm quotes [--amount 5] [--trader alice.near] [--evm 0x…] [--swap <contract>]
//
// 1Click answers 500 if a NEAR account in the request does not exist; the
// defaults are the mainnet contract and an existing stand-in trader.

import { parseArgs } from "node:util";
import {
  depositToSwapQuote,
  findToken,
  hyperliquidUsdc,
  nearUsdc,
  oneClick,
  withdrawFromNearQuote,
  type QuoteRequest,
} from "../src/oneclick.ts";

const { values: a } = parseArgs({
  options: {
    amount: { type: "string", default: "5" },
    trader: { type: "string", default: "near" },
    swap: { type: "string", default: process.env.MAINNET_SWAP_CONTRACT ?? "fundswap.near" },
    // Any well-formed address works for a dry quote; 1Click rejects burn addresses.
    evm: { type: "string", default: "0x1111111111111111111111111111111111111111" },
  },
});

const api = oneClick({ jwt: process.env.ONECLICK_JWT });
const tokens = await api.tokens();
const usdc = nearUsdc(tokens);
const units = (decimals: number) => BigInt(Math.round(Number(a.amount) * 10 ** decimals));

const routes: [string, QuoteRequest][] = [
  ...(["base", "arb", "eth", "near"] as const).map((chain): [string, QuoteRequest] => {
    const origin = findToken(tokens, "USDC", chain);
    return [
      `deposit  USDC ${chain.padEnd(4)} → margin of ${a.trader}`,
      depositToSwapQuote({
        dry: true,
        origin,
        collateral: usdc,
        amount: units(origin.decimals),
        refundTo: chain === "near" ? a.trader : a.evm,
        swapContract: a.swap,
        trader: a.trader,
      }),
    ];
  }),
  ...[findToken(tokens, "USDC", "base"), findToken(tokens, "USDC", "arb"), hyperliquidUsdc(tokens)].map(
    (destination): [string, QuoteRequest] => [
      `withdraw NEAR USDC → ${destination.blockchain === "hypercore" ? "Hyperliquid perp" : `USDC ${destination.blockchain}`}`,
      withdrawFromNearQuote({ dry: true, collateral: usdc, destination, amount: units(usdc.decimals), recipient: a.evm, trader: a.trader }),
    ],
  ),
];

console.log(`1Click dry quotes, ${a.amount} USDC in, swap contract ${a.swap}\n`);
let failed = 0;
for (const [label, req] of routes) {
  try {
    const { quote: q } = await api.quote(req);
    const fee = Number(a.amount) - Number(q.amountOutFormatted);
    console.log(`${label.padEnd(48)} out ${q.amountOutFormatted.padStart(10)}  cost ${fee.toFixed(4).padStart(7)}  ~${q.timeEstimate}s`);
  } catch (e) {
    failed++;
    console.log(`${label.padEnd(48)} ERROR ${(e as Error).message}`);
  }
}
process.exitCode = failed ? 1 : 0;
