"use client";

import { useState } from "react";
import { SWAP_CONTRACT } from "@/lib/config";
import { int, pct, usd } from "@/lib/format";
import { rateToPct, shortName, tickToPct, TGAS, toNum, type AccountView, type MarketView, type TradeRecord } from "@/lib/swap";
import { TradeHistory } from "./trades";
import { useTx } from "./hooks";

function left(secs: number) {
  if (secs <= 0) return "Matured";
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((secs % 3_600) / 60)}m`;
}

/** Positions and open orders of the connected account, across all markets. */
export function Portfolio({
  account,
  markets,
  trades,
  onDone,
}: {
  account: AccountView | null | undefined;
  markets: MarketView[];
  trades: TradeRecord[] | undefined;
  onDone: () => void;
}) {
  const tx = useTx();
  const [tab, setTab] = useState<"positions" | "orders" | "trades">("positions");
  const byId = new Map(markets.map((m) => [m.id, m]));
  const positions = account?.positions.filter((p) => BigInt(p.n) !== 0n) ?? [];
  const orders = account?.orders ?? [];

  const close = (marketId: number, n: bigint) =>
    tx(`Close ${int(Math.abs(toNum(n)))} YU`, [
      {
        receiverId: SWAP_CONTRACT,
        method: "place_order",
        args: { market_id: marketId, side: n > 0n ? "Short" : "Long", size: (n > 0n ? n : -n).toString(), tick: 0, kind: "Market" },
        gas: TGAS(200),
        deposit: "0",
      },
    ]).then(onDone);

  const cancel = (id: string) =>
    tx(`Cancel order ${id}`, [{ receiverId: SWAP_CONTRACT, method: "cancel_order", args: { order_id: id }, gas: TGAS(50), deposit: "0" }]).then(onDone);
  const cancelAll = () =>
    tx("Cancel all orders", [{ receiverId: SWAP_CONTRACT, method: "cancel_all", args: {}, gas: TGAS(150), deposit: "0" }]).then(onDone);

  const th = "label px-4 py-3 text-left text-[0.58rem] font-normal text-white/55";
  const td = "px-4 py-3 text-[0.82rem] tnum";

  return (
    <div>
      <div className="flex items-center justify-between border-b border-white/10 px-2">
        <div className="flex gap-6">
          {(["positions", "orders", "trades"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-2 py-3 text-xs tracking-[0.06em] uppercase ${tab === t ? "border-lime text-lime" : "border-transparent text-white/60 hover:text-white"}`}
            >
              {t === "trades" ? "Trade history" : `${t} (${t === "positions" ? positions.length : orders.length})`}
            </button>
          ))}
        </div>
        {tab === "orders" && orders.length > 0 && (
          <button onClick={cancelAll} className="text-xs text-white/60 hover:text-lime">
            Cancel all
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        {tab === "trades" ? (
          account ? (
            <TradeHistory trades={trades} me={account.account_id} names={new Map(markets.map((m) => [m.id, shortName(m)]))} />
          ) : (
            <Empty text="Connect a wallet to see your trades" />
          )
        ) : tab === "positions" ? (
          positions.length ? (
            <table className="w-full min-w-[760px]">
              <thead>
                <tr>
                  {["Market", "Side", "Size", "Avg fixed", "Mark", "Value", "Init. margin", "Expires", ""].map((c) => (
                    <th key={c} className={th}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const m = byId.get(p.market_id);
                  const n = BigInt(p.n);
                  const value = toNum(p.value);
                  return (
                    <tr key={p.market_id} className="border-t border-white/6">
                      <td className={td}>{m ? shortName(m) : p.market_id}</td>
                      <td className={`${td} ${n > 0n ? "text-lime" : ""}`}>{n > 0n ? "Long" : "Short"}</td>
                      <td className={td}>{int(Math.abs(toNum(n)))} YU</td>
                      <td className={td}>{p.avg_rate ? pct(rateToPct(p.avg_rate)) : "—"}</td>
                      <td className={td}>{m ? pct(rateToPct(m.mark)) : "—"}</td>
                      <td className={`${td} ${value >= 0 ? "text-lime" : "text-white/80"}`}>{usd(value)}</td>
                      <td className={td}>{usd(toNum(p.initial_margin))}</td>
                      <td className={td}>{left(p.secs_left)}</td>
                      <td className={`${td} text-right`}>
                        {p.secs_left > 0 && (
                          <button onClick={() => close(p.market_id, n)} className="rounded-md border border-white/15 px-3 py-1 text-xs hover:border-lime/60 hover:text-lime">
                            Close
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty text={account ? "No open positions" : "Connect a wallet to see positions"} />
          )
        ) : orders.length ? (
          <table className="w-full min-w-[620px]">
            <thead>
              <tr>
                {["Market", "Side", "Rate", "Remaining", "Order", ""].map((c) => (
                  <th key={c} className={th}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const m = byId.get(o.market_id);
                return (
                  <tr key={o.id} className="border-t border-white/6">
                    <td className={td}>{m ? shortName(m) : o.market_id}</td>
                    <td className={`${td} ${o.side === "Long" ? "text-lime" : ""}`}>{o.side === "Long" ? "Bid · pay fixed" : "Ask · get fixed"}</td>
                    <td className={td}>{pct(tickToPct(o.tick))}</td>
                    <td className={td}>{int(toNum(o.remaining))} YU</td>
                    <td className={`${td} text-white/50`}>#{o.id}</td>
                    <td className={`${td} text-right`}>
                      <button onClick={() => cancel(o.id)} className="rounded-md border border-white/15 px-3 py-1 text-xs hover:border-lime/60 hover:text-lime">
                        Cancel
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty text={account ? "No open orders" : "Connect a wallet to see orders"} />
        )}
      </div>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <div className="px-6 py-10 text-center text-sm text-white/40">{text}</div>;
