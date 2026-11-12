import type { NextRequest } from "next/server";
import { view } from "@/lib/chain";
import type { Candle, FeedView, Level, MarketView, TradeRecord } from "@/lib/swap";

// Shared market feed for the trade page. Every visitor polls this instead of
// the RPC, and each read is memoised for a couple of seconds, so RPC load
// stays flat however many people are watching.

const memo = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  // A failed read shouldn't be served for the whole TTL.
  value.catch(() => memo.delete(key));
  return value;
}

export interface LiveMarket {
  markets: MarketView[];
  feeds: FeedView[];
  book: { bids: Level[]; asks: Level[] };
  trades: TradeRecord[];
  candles: Candle[];
  /** Server time of this snapshot, ms. */
  now: number;
}

export async function GET(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("market"));
  if (!Number.isInteger(id) || id < 0) return Response.json({ error: "market must be a market id" }, { status: 400 });
  try {
    const [markets, feeds, book, trades, candles] = await Promise.all([
      cached("markets", 2_000, () => view<MarketView[]>("list_markets")),
      cached("feeds", 10_000, () => view<FeedView[]>("list_feeds")),
      cached(`book:${id}`, 2_000, () => view<LiveMarket["book"]>("get_book", { market_id: id, depth: 12 })),
      cached(`trades:${id}`, 2_000, () => view<TradeRecord[]>("get_trades", { market_id: id, limit: 40 })),
      cached(`candles:${id}`, 30_000, () =>
        view<Candle[]>("get_candles", { market_id: id, from_ts: String(Math.floor(Date.now() / 1000) - 14 * 86_400) }),
      ),
    ]);
    const body: LiveMarket = { markets, feeds, book, trades, candles, now: Date.now() };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "rpc error" }, { status: 502 });
  }
}
