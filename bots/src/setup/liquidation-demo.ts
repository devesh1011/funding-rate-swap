// Staged liquidation on testnet, every step a real transaction between
// separate accounts:
//   1. whale rests an ask of 1,000,000 YU at 7.00 %; victim buys it with
//      barely more than initial margin → mark prints 7.00 %.
//   2. after the mark EMA window, whale rests a tiny bid at −10.00 % and bear
//      sells into it → mark prints −10.00 %.
//   3. the victim's long is now worth (−10 % − 7 %) × 1M × τ and falls below
//      maintenance; the running keeper bot liquidates it.
// Run the maker with MAKER_SKIP_MARKETS=<market> while this runs, or its bid
// would absorb the bear's sale.
// Usage: pnpm demo:liquidation [market_id]

import { config } from "../lib/config.ts";
import { log, sleep } from "../lib/log.ts";
import { call, keychainAccount, swap } from "../lib/near.ts";
import { USDC, formatPct, formatUsdc, tickToApr } from "../lib/units.ts";

const MARKET = Number(process.argv[2] ?? 0);
const SIZE = 1_000_000n * USDC;
const whale = keychainAccount("demo-whale.fundswap-treasury.testnet");
const victim = keychainAccount("demo-victim.fundswap-treasury.testnet");
const bear = keychainAccount("demo-bear.fundswap-treasury.testnet");

const place = async (who: typeof whale, side: "Long" | "Short", size: bigint, tick: number, kind: "Limit" | "Ioc" | "Market") => {
  const r = await call<{ filled: string }>(who, config.swap, "place_order", { market_id: MARKET, side, size: size.toString(), tick, kind }, { gasTera: 200 });
  log("demo", `${who.accountId.split(".")[0]} ${kind} ${side} ${size / USDC} YU @ ${formatPct(tickToApr(tick))}`, { filled: r.value?.filled, tx: config.explorer(r.hash) });
};
const mark = async () => BigInt((await swap.markets()).find((m) => m.id === MARKET)!.mark);
const health = async () => (await swap.account(victim.accountId))!.health;

// 1. Open the victim's position at 7 %.
await place(whale, "Short", SIZE, 700, "Limit");
await place(victim, "Long", SIZE, 700, "Ioc");
const window = (await swap.markets()).find((m) => m.id === MARKET)!;
log("demo", "after open", { mark: formatPct(await mark()), victim: await health() });

// 2. Wait out the mark window so the next print carries full weight.
const waitMs = 920_000;
log("demo", `waiting ${waitMs / 60_000} min for the mark window`, { market: window.name });
await sleep(waitMs);
await place(whale, "Long", 1_000n * USDC, -1_000, "Limit");
await place(bear, "Short", 1_000n * USDC, -1_000, "Ioc");
const h = await health();
log("demo", "after the print", {
  mark: formatPct(await mark()),
  net: formatUsdc(BigInt(h.net)),
  maintenance: formatUsdc(BigInt(h.maintenance_margin)),
  liquidatable: h.liquidatable,
});

// 3. Wait for the keeper bot to act.
for (let i = 0; i < 20; i++) {
  await sleep(15_000);
  const a = await swap.account(victim.accountId);
  const open = a?.positions.find((p) => p.market_id === MARKET && BigInt(p.n) !== 0n);
  if (!open) {
    log("demo", "victim was liquidated by the keeper", { victim: a?.health });
    process.exit(0);
  }
}
log("demo", "keeper did not liquidate within 5 min");
process.exit(1);
