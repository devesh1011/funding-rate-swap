import { cacheLife } from "next/cache";
import { view } from "@/lib/chain";
import type { Net } from "@/lib/config";
import { getImpliedHistory, getRealizedFunding } from "@/lib/data";
import type { MarketView } from "@/lib/swap";
import { TradeApp } from "./trade-app";

async function initial(net: Net) {
  "use cache";
  cacheLife("minutes");
  const markets = await view<MarketView[]>(net, "list_markets");
  const [realized, ...histories] = await Promise.all([getRealizedFunding(24 * 60), ...markets.map((m) => getImpliedHistory(net, m.id))]);
  return { now: Date.now(), markets, realized, implied: Object.fromEntries(markets.map((m, i) => [m.id, histories[i]])) };
}

/** Server part of the trading page: the first snapshot, then the client app takes over. */
export async function TradeRoute({ net }: { net: Net }) {
  return <TradeApp net={net} initial={await initial(net)} />;
}
