// Market maker: keeps a two-sided book on every active market.
//
// Fair rate = mean of the last MAKER_FAIR_HOURS (default 7 days) of settled
// Hyperliquid hourly funding, annualised: a horizon close to the markets'
// tenor. Quotes a ladder of MAKER_LEVELS bids below fair − spread and asks
// above fair + spread, MAKER_LEVEL_STEP_BPS apart and growing in size,
// clamped inside the market's rate band. Stops quoting the side that would
// grow inventory beyond the cap. Re-quotes when fair moves or a quote is
// mostly filled. All orders are real contract calls from its own account.

import { config } from "../lib/config.ts";
import { fundingHistory } from "../lib/hyperliquid.ts";
import { log, loop } from "../lib/log.ts";
import { call, loadAccount, swap, type MarketView, type OrderView, type Side } from "../lib/near.ts";
import { USDC, aprToTick, formatPct, hourlyToApr, tickToApr } from "../lib/units.ts";

const SPREAD_TICKS = config.num("MAKER_SPREAD_BPS", 15);
const SIZE = BigInt(config.num("MAKER_SIZE_USDC", 10_000)) * USDC;
const MAX_INV = BigInt(config.num("MAKER_MAX_INVENTORY_USDC", 100_000)) * USDC;
const REQUOTE_TICKS = config.num("MAKER_REQUOTE_BPS", 10);
const LEVELS = config.num("MAKER_LEVELS", 5);
const LEVEL_STEP = config.num("MAKER_LEVEL_STEP_BPS", 10);
const FAIR_HOURS = config.num("MAKER_FAIR_HOURS", 24 * 7);

/** Level i (0 = inside) quotes 1×, 1.5×, 2× … the base size. 5 levels × 2 sides × 3 markets (30) stays under the contract's 32 open orders per account. */
const sizeAt = (level: number) => (SIZE * BigInt(2 + level)) / 2n;

interface Want {
  side: Side;
  tick: number;
  size: bigint;
}
/** Comma-separated market ids to leave alone (e.g. while a staged demo runs). */
const SKIP = new Set((config.optional("MAKER_SKIP_MARKETS") ?? "").split(",").filter(Boolean).map(Number));

const maker = loadAccount("MAKER", "maker.fundswap-treasury.testnet");

async function fairApr(coin: string): Promise<bigint> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const points = (await fundingHistory(coin, now - BigInt(FAIR_HOURS + 2) * 3600n)).slice(-FAIR_HOURS);
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

function desired(m: MarketView, fairTick: number, inventory: bigint): Want[] {
  const [lo, hi] = bandTicks(m);
  const out: Want[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const off = SPREAD_TICKS + i * LEVEL_STEP;
    const size = sizeAt(i);
    if (inventory < MAX_INV && fairTick - off >= lo) out.push({ side: "Long", tick: fairTick - off, size });
    if (inventory > -MAX_INV && fairTick + off <= hi) out.push({ side: "Short", tick: fairTick + off, size });
  }
  return out;
}

function stillGood(o: OrderView, want: Want): boolean {
  return o.side === want.side && Math.abs(o.tick - want.tick) < REQUOTE_TICKS && BigInt(o.remaining) * 2n >= want.size;
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
        { market_id: m.id, side: w.side, size: w.size.toString(), tick: w.tick, kind: "Limit" },
        { gasTera: 200 },
      );
      log("maker", `${w.side === "Long" ? "bid" : "ask"} ${formatPct(tickToApr(w.tick))} × ${w.size / USDC} YU`, {
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

log("maker", "started", { account: maker.accountId, spread_bps: SPREAD_TICKS, levels: LEVELS, step_bps: LEVEL_STEP, fair_hours: FAIR_HOURS, size_usdc: SIZE / USDC, max_inventory_usdc: MAX_INV / USDC });

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
