import type { Metadata } from "next";
import { TradeApp } from "@/components/trade/trade-app";
import { view } from "@/lib/chain";
import { getImpliedHistory, getRealizedFunding } from "@/lib/data";
import type { MarketView } from "@/lib/swap";
import { cacheLife } from "next/cache";

export const metadata: Metadata = {
  title: "Trade · Fundswap",
  description: "Trade Hyperliquid BTC funding as a fixed-for-floating swap on NEAR testnet.",
};

async function initial() {
  "use cache";
  cacheLife("minutes");
  const markets = await view<MarketView[]>("list_markets");
  const [realized, ...histories] = await Promise.all([getRealizedFunding(24 * 60), ...markets.map((m) => getImpliedHistory(m.id))]);
  return { now: Date.now(), markets, realized, implied: Object.fromEntries(markets.map((m, i) => [m.id, histories[i]])) };
}

export default async function TradePage() {
  return <TradeApp initial={await initial()} />;
}
