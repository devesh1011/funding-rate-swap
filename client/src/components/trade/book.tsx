"use client";

import type { Level } from "@/lib/swap";
import { tickToPct, toNum } from "@/lib/swap";
import { int, pct } from "@/lib/format";

interface Row {
  tick: number;
  size: number;
  total: number;
}

function withTotals(levels: Level[]): Row[] {
  let total = 0;
  return levels.map((l) => {
    total += toNum(l.size);
    return { tick: l.tick, size: toNum(l.size), total };
  });
}

/** Live order book in APR. Click a level to price the ticket there. */
export function OrderBook({
  loading,
  bids,
  asks,
  mine,
  onPick,
}: {
  /** True until the first snapshot arrives, so an empty book isn't shown as "no orders". */
  loading: boolean;
  bids: Level[];
  asks: Level[];
  /** Ticks where the connected account has resting orders. */
  mine: Set<number>;
  onPick: (tick: number) => void;
}) {
  const b = withTotals(bids.slice(0, 8));
  const a = withTotals(asks.slice(0, 8));
  const max = Math.max(1, b.at(-1)?.total ?? 0, a.at(-1)?.total ?? 0);
  const bestBid = bids[0]?.tick;
  const bestAsk = asks[0]?.tick;
  const spread = bestBid !== undefined && bestAsk !== undefined ? tickToPct(bestAsk - bestBid) : null;
  const mid = bestBid !== undefined && bestAsk !== undefined ? tickToPct((bestBid + bestAsk) / 2) : null;

  const RowView = ({ r, side }: { r: Row; side: "bid" | "ask" }) => (
    <button
      onClick={() => onPick(r.tick)}
      className="relative grid w-full grid-cols-3 px-4 py-[5px] text-right text-[0.82rem] tnum hover:bg-white/[0.04]"
      title="Use this rate"
    >
      <span
        className={`absolute inset-y-[2px] right-0 ${side === "bid" ? "bg-lime/12" : "bg-white/[0.07]"}`}
        style={{ width: `${(r.total / max) * 100}%` }}
      />
      <span className={`relative text-left ${side === "bid" ? "text-lime" : "text-white"}`}>
        {mine.has(r.tick) && <span className="mr-1 inline-block size-1.5 -translate-y-px rounded-full bg-lime align-middle" />}
        {pct(tickToPct(r.tick))}
      </span>
      <span className="relative text-white/90">{int(r.size)}</span>
      <span className="relative text-white/55">{int(r.total)}</span>
    </button>
  );

  if (loading) return <div className="px-4 py-24 text-center text-sm text-white/40">Loading book…</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="label grid grid-cols-3 px-4 pb-2 text-right text-[0.58rem] text-white/55">
        <span className="text-left">APR</span>
        <span>Size (YU)</span>
        <span>Total</span>
      </div>
      <div className="label px-4 pb-1 text-[0.55rem] text-white/40">Asks · receive fixed</div>
      <div className="flex min-h-[200px] flex-col justify-end">
        {a.length ? [...a].reverse().map((r) => <RowView key={r.tick} r={r} side="ask" />) : <Empty />}
      </div>
      <div className="my-1 flex items-baseline justify-between border-y border-dashed border-white/12 px-4 py-2.5">
        <span className="text-2xl font-semibold text-lime">{mid === null ? "—" : pct(mid)}</span>
        <span className="label text-[0.58rem] text-white/60">{spread === null ? "one-sided" : `Mid · spread ${pct(spread)}`}</span>
      </div>
      <div className="label px-4 pb-1 text-[0.55rem] text-white/40">Bids · pay fixed</div>
      <div className="min-h-[200px]">{b.length ? b.map((r) => <RowView key={r.tick} r={r} side="bid" />) : <Empty />}</div>
    </div>
  );
}

const Empty = () => <div className="px-4 py-2 text-xs text-white/35">— no orders —</div>;
