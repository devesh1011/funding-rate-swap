// Market maker: keeps a two-sided book on every active market.
//
// Fair rate = mean of the last 24 settled Hyperliquid hourly funding rates,
// annualised. Quotes a bid at fair − spread and an ask at fair + spread,
// clamped inside the market's rate band. Stops quoting the side that would
// grow inventory beyond the cap. Re-quotes when fair moves or a quote is
// mostly filled. All orders are real contract calls from its own account.

import { config } from "../lib/config.ts";
import { fundingHistory } from "../lib/hyperliquid.ts";
import { log, loop } from "../lib/log.ts";
import { call, loadAccount, swap, type MarketView, type OrderView, type Side } from "../lib/near.ts";
import { USDC, aprToTick, formatPct, hourlyToApr, tickToApr } from "../lib/units.ts";

const SPREAD_TICKS = config.num("MAKER_SPREAD_BPS", 50);
const SIZE = BigInt(config.num("MAKER_SIZE_USDC", 25_000)) * USDC;
const MAX_INV = BigInt(config.num("MAKER_MAX_INVENTORY_USDC", 100_000)) * USDC;
const REQUOTE_TICKS = config.num("MAKER_REQUOTE_BPS", 25);
/** Comma-separated market ids to leave alone (e.g. while a staged demo runs). */
const SKIP = new Set((config.optional("MAKER_SKIP_MARKETS") ?? "").split(",").filter(Boolean).map(Number));

const maker = loadAccount("MAKER", "maker.fundswap-treasury.testnet");

async function fairApr(coin: string): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const points = (await fundingHistory(coin, now - 26n * 3600n)).slice(-24);
  if (points.length === 0) throw new Error(`no funding history for ${coin}`);
  const mean = points.reduce((s, p) => s + p.rate, 0n) / BigInt(points.length);
  return hourlyToApr(mean);
}

function bandTicks(m: MarketView): [number, number] {
  const mark = BigInt(m.mark);
  const dev = BigInt(m.params.max_dev);
  // Stay one tick inside the band so mark drift between blocks can't reject us.
  return [aprToTick(mark - dev) + 1, aprToTick(mark + dev) - 1];
}

function desired(m: MarketView, fairTick: number, inventory: bigint): { side: Side; tick: number }[] {
  const [lo, hi] = bandTicks(m);
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
  const out: { side: Side; tick: number }[] = [];
  if (inventory < MAX_INV) out.push({ side: "Long", tick: clamp(fairTick - SPREAD_TICKS) });
  if (inventory > -MAX_INV) out.push({ side: "Short", tick: clamp(fairTick + SPREAD_TICKS) });
  return out;
}

function stillGood(o: OrderView, want: { side: Side; tick: number }): boolean {
  return o.side === want.side && Math.abs(o.tick - want.tick) < REQUOTE_TICKS && BigInt(o.remaining) * 2n >= SIZE;
}

async function quoteMarket(m: MarketView, fairTick: number) {
  const acct = await swap.account(maker.accountId);
  if (!acct) throw new Error(`${maker.accountId} not registered; run pnpm fund first`);
  const inventory = BigInt(acct.positions.find((p) => p.market_id === m.id)?.n ?? "0");
  const mine = acct.orders.filter((o) => o.market_id === m.id);
  const wants = desired(m, fairTick, inventory);

  const keep = wants.every((w) => mine.some((o) => stillGood(o, w))) && mine.length === wants.length;
  if (keep) return;

  if (mine.length > 0) {
    const r = await call(maker, config.swap, "cancel_all", { market_id: m.id });
    log("maker", `cancelled ${mine.length} quote(s)`, { market: m.name, tx: config.explorer(r.hash) });
  }
  for (const w of wants) {
    try {
      const r = await call<{ filled: string; order_id: string | null }>(
        maker,
        config.swap,
        "place_order",
        { market_id: m.id, side: w.side, size: SIZE.toString(), tick: w.tick, kind: "Limit" },
        { gasTera: 200 },
      );
      log("maker", `${w.side === "Long" ? "bid" : "ask"} ${formatPct(tickToApr(w.tick))} × ${SIZE / USDC} YU`, {
        market: m.name,
        filled: r.value?.filled,
        resting: r.value?.order_id,
        tx: config.explorer(r.hash),
      });
    } catch (e) {
      log("maker", "quote rejected", { market: m.name, side: w.side, tick: w.tick, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

log("maker", "started", { account: maker.accountId, spread_bps: SPREAD_TICKS, size_usdc: SIZE / USDC, max_inventory_usdc: MAX_INV / USDC });

await loop("maker", config.num("MAKER_POLL_SECS", 60) * 1000, async () => {
  const [feeds, markets] = await Promise.all([swap.feeds(), swap.markets()]);
  const now = Math.floor(Date.now() / 1000);
  for (const m of markets) {
    if (SKIP.has(m.id) || m.effective_mode !== "Active" || m.final_cum !== null || now >= m.maturity_ts) continue;
    const feed = feeds.find((f) => f.id === m.feed_id);
    if (!feed?.name.startsWith("hyperliquid:")) continue;
    const fair = await fairApr(feed.name.split(":")[1]);
    await quoteMarket(m, aprToTick(fair));
  }
});
