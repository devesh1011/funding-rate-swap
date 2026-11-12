import "server-only";
import { cacheLife } from "next/cache";
import {
  depositToSwapQuote,
  findToken,
  nearUsdc,
  oneClick,
} from "@fundswap/intents/oneclick";
import { blockClock, heightAt, KEEPER_ACCOUNT, ORACLE_ACCOUNT, recentTxs, txArgs, view } from "./chain";

// ---------------------------------------------------------------- contract

export type Mode = "Active" | "CloseOnly" | "Paused";

interface RawMarket {
  id: number;
  feed_id: number;
  name: string;
  maturity_ts: number;
  effective_mode: Mode;
  mark: string;
  long_oi: string;
  best_bid: number | null;
  best_ask: number | null;
}

export interface Market {
  id: number;
  name: string;
  maturityTs: number;
  mode: Mode;
  /** APR in percent: the book mid when two-sided, else the mark. */
  implied: number;
  bid: number | null;
  ask: number | null;
  /** Open interest in YU (1 YU = $1 notional). */
  openInterest: number;
}

const tickToPct = (tick: number) => tick / 100;
const rateToPct = (rate: string) => Number(BigInt(rate)) / 1e10; // 1e12 = 100 %

function toMarket(m: RawMarket): Market {
  const bid = m.best_bid === null ? null : tickToPct(m.best_bid);
  const ask = m.best_ask === null ? null : tickToPct(m.best_ask);
  return {
    id: m.id,
    name: m.name,
    maturityTs: m.maturity_ts,
    mode: m.effective_mode,
    implied: bid !== null && ask !== null ? (bid + ask) / 2 : rateToPct(m.mark),
    bid,
    ask,
    openInterest: Number(BigInt(m.long_oi) / 1_000_000n),
  };
}

export async function getMarkets(): Promise<Market[]> {
  "use cache";
  cacheLife("minutes");
  return (await view<RawMarket[]>("list_markets")).map(toMarket);
}

export interface BookLevel {
  apr: number;
  size: number; // YU
}

export async function getBook(marketId: number): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  "use cache";
  cacheLife("minutes");
  const b = await view<{ bids: { tick: number; size: string }[]; asks: { tick: number; size: string }[] }>("get_book", {
    market_id: marketId,
    depth: 6,
  });
  const lv = (l: { tick: number; size: string }) => ({ apr: tickToPct(l.tick), size: Number(BigInt(l.size) / 1_000_000n) });
  return { bids: b.bids.map(lv), asks: b.asks.map(lv) };
}

async function clock() {
  "use cache";
  cacheLife("minutes");
  return blockClock();
}

/** Implied APR of every market at the top of one past hour (archival read; immutable, so cached for good). */
async function impliedAt(hourTs: number): Promise<Record<number, number>> {
  "use cache";
  cacheLife("max");
  try {
    const markets = await view<RawMarket[]>("list_markets", {}, heightAt(await clock(), hourTs));
    return Object.fromEntries(markets.map((m) => [m.id, toMarket(m).implied]));
  } catch (e) {
    // Before deployment the account or method didn't exist: a permanent, cacheable fact.
    if (/UNKNOWN_ACCOUNT|CONTRACT_EXECUTION_ERROR/.test(String(e))) return {};
    throw e;
  }
}

export interface Point {
  ts: number; // seconds, top of the hour
  apr: number; // percent
}

/** Hourly implied APR of `marketId` from its listing until now. */
export async function getImpliedHistory(marketId: number, maxHours = 24 * 30): Promise<Point[]> {
  "use cache";
  cacheLife("minutes");
  const nowHour = Math.floor(Date.now() / 3_600_000) * 3_600;
  const out: Point[] = [];
  for (let ts = nowHour; ts > nowHour - maxHours * 3_600; ts -= 3_600) {
    const at = await impliedAt(ts);
    if (at[marketId] === undefined) break; // the market wasn't listed yet
    out.push({ ts, apr: at[marketId] });
  }
  return out.reverse();
}

/**
 * Oracle config, the feed's last settled interval, and the matching latest
 * submit/liquidate txs, read together so they're from the same moment.
 */
export async function getOracle() {
  "use cache";
  cacheLife("minutes");
  const [config, feeds, oracleTxs, keeperTxs] = await Promise.all([
    view<{ signers: string[]; threshold: number }>("get_config"),
    view<{ id: number; name: string; last_ts: number; clamp: string }[]>("list_feeds"),
    recentTxs(ORACLE_ACCOUNT, 5),
    recentTxs(KEEPER_ACCOUNT, 25),
  ]);
  const feed = feeds[0];
  const liq = keeperTxs.find((t) => t.method === "liquidate");
  return {
    signers: config.signers,
    threshold: config.threshold,
    feedName: feed.name,
    lastIntervalTs: feed.last_ts,
    /** Clamp in percent per hour. */
    clampPerHour: rateToPct(feed.clamp),
    lastSubmit: oracleTxs.find((t) => t.method === "submit_rates") ?? null,
    lastLiquidation: liq
      ? { ...liq, ...(await txArgs<{ account_id: string; market_id: number }>(liq.hash, KEEPER_ACCOUNT)) }
      : null,
  };
}

// ---------------------------------------------------------------- Hyperliquid

const HL = "https://api.hyperliquid.xyz/info";

async function hl<T>(body: object): Promise<T> {
  const res = await fetch(HL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  return (await res.json()) as T;
}

export interface FundingPoint {
  ts: number; // seconds, the hour the payment settles
  /** Fraction paid for that one hour. */
  hourly: number;
  /** Annualised, percent. */
  apr: number;
}

/** Settled hourly BTC funding on Hyperliquid for the last `hours` (paged, 500 rows per call). */
export async function getRealizedFunding(hours: number): Promise<FundingPoint[]> {
  "use cache";
  cacheLife("minutes");
  const out: FundingPoint[] = [];
  let start = Date.now() - hours * 3_600_000;
  for (let page = 0; page < 10; page++) {
    const rows = await hl<{ fundingRate: string; time: number }[]>({ type: "fundingHistory", coin: "BTC", startTime: start });
    for (const r of rows) {
      const hourly = Number(r.fundingRate);
      out.push({ ts: Math.floor(r.time / 3_600_000) * 3_600, hourly, apr: hourly * 8760 * 100 });
    }
    if (rows.length < 500) break;
    start = rows[rows.length - 1].time + 1;
  }
  return out;
}

/** Hyperliquid's current (not yet settled) BTC funding for this hour. */
export async function getPredictedFunding(): Promise<number> {
  "use cache";
  cacheLife("minutes");
  const [meta, ctxs] = await hl<[{ universe: { name: string }[] }, { funding: string }[]]>({ type: "metaAndAssetCtxs" });
  return Number(ctxs[meta.universe.findIndex((u) => u.name === "BTC")].funding);
}

// ---------------------------------------------------------------- NEAR Intents

/**
 * A live 1Click dry quote: 5 USDC on Arbitrum into margin. The mainnet
 * contract isn't deployed yet, so the quote is priced to a stand-in NEAR
 * account (1Click rejects accounts that don't exist).
 */
export async function getDepositQuote() {
  "use cache";
  cacheLife("minutes");
  const api = oneClick();
  const tokens = await api.tokens();
  const origin = findToken(tokens, "USDC", "arb");
  const { quote } = await api.quote(
    depositToSwapQuote({
      dry: true,
      origin,
      collateral: nearUsdc(tokens),
      amount: 5_000_000n,
      refundTo: "0x1111111111111111111111111111111111111111",
      swapContract: process.env.MAINNET_SWAP_CONTRACT ?? "intents.near",
      trader: "near",
    }),
  );
  const amountIn = Number(quote.amountInFormatted);
  const amountOut = Number(quote.amountOutFormatted);
  return {
    from: "Arbitrum",
    amountIn,
    amountOut,
    feePct: ((amountIn - amountOut) / amountIn) * 100,
    etaSecs: quote.timeEstimate,
  };
}
