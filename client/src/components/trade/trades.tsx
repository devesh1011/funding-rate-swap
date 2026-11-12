"use client";

import { explorer } from "@/lib/config";
import { useNet } from "./net";
import { int, pct, timeUtc } from "@/lib/format";
import { rateToPct, toNum, type TradeRecord } from "@/lib/swap";

/** Latest fills in a market, newest first, straight from the contract's trade log. */
export function MarketTrades({ trades }: { trades: TradeRecord[] | undefined }) {
  if (!trades) return <div className="px-4 py-8 text-center text-xs text-white/40">Loading…</div>;
  if (!trades.length)
    return (
      <div className="px-6 py-10 text-center text-xs leading-6 text-white/45">
        No trades yet in this market.
        <br />
        Fills appear here the block they happen.
      </div>
    );
  return (
    <div>
      <div className="label grid grid-cols-[1fr_1fr_auto] gap-2 px-4 pb-2 text-[0.58rem] text-white/55">
        <span>APR</span>
        <span className="text-right">Size (YU)</span>
        <span className="w-16 text-right">Time</span>
      </div>
      {trades.map((t, i) => (
        <div key={`${t.ts}-${i}`} className="grid grid-cols-[1fr_1fr_auto] gap-2 px-4 py-[5px] text-[0.8rem] tnum" title={`${t.taker} ${t.taker_side === "Long" ? "bought" : "sold"} from ${t.maker}`}>
          <span className={t.taker_side === "Long" ? "text-lime" : "text-white"}>
            {pct(rateToPct(t.rate))}
            {t.liquidation && <span className="ml-1 text-[0.6rem] text-white/50">LIQ</span>}
          </span>
          <span className="text-right text-white/90">{int(toNum(t.size))}</span>
          <span className="w-16 text-right text-white/50">{timeUtc(t.ts).slice(0, 5)}</span>
        </div>
      ))}
    </div>
  );
}

/** The connected account's fills (as taker or maker), newest first. */
export function TradeHistory({ trades, me, names }: { trades: TradeRecord[] | undefined; me: string; names: Map<number, string> }) {
  const c = useNet();
  if (!trades?.length) return <div className="px-6 py-10 text-center text-sm text-white/40">No trades yet</div>;
  const th = "label px-4 py-3 text-left text-[0.58rem] font-normal text-white/55";
  const td = "px-4 py-3 text-[0.82rem] tnum";
  return (
    <table className="w-full min-w-[720px]">
      <thead>
        <tr>
          {["Time (UTC)", "Market", "Side", "Size", "Rate", "Role", "Counterparty"].map((c) => (
            <th key={c} className={th}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trades.map((t, i) => {
          const taker = t.taker === me;
          // My side: the taker's side if I took, the opposite if my resting order was hit.
          const long = taker ? t.taker_side === "Long" : t.taker_side === "Short";
          return (
            <tr key={`${t.ts}-${i}`} className="border-t border-white/6">
              <td className={td}>
                {new Date(t.ts * 1000).toISOString().slice(5, 10)} {timeUtc(t.ts).slice(0, 5)}
              </td>
              <td className={td}>{names.get(t.market_id) ?? t.market_id}</td>
              <td className={`${td} ${long ? "text-lime" : ""}`}>{long ? "Long" : "Short"}</td>
              <td className={td}>{int(toNum(t.size))} YU</td>
              <td className={td}>{pct(rateToPct(t.rate))}</td>
              <td className={`${td} text-white/60`}>{t.liquidation ? (taker ? "Liquidator" : "Liquidated") : taker ? "Taker" : "Maker"}</td>
              <td className={`${td} text-white/60`}>
                <a href={explorer(c.id).account(taker ? t.maker : t.taker)} target="_blank" rel="noreferrer" className="hover:text-lime">
                  {(taker ? t.maker : t.taker).replace(/\.(testnet|near)$/, "")}
                </a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
