"use client";

import { useState } from "react";
import { date, int, pct, usd } from "@/lib/format";
import {
  estimateFill,
  initialMargin,
  parseUsdc,
  takerFee,
  toNum,
  YEAR_SECS,
  type AccountView,
  type Kind,
  type Level,
  type MarketView,
  type Side,
} from "@/lib/swap";
import { useNet } from "./net";

export interface TicketPreset {
  side: Side;
  size: string;
  kind: Kind;
}

/**
 * Turns a perp position into the YU trade that fixes its funding. A perp long
 * pays the underlying rate, so it buys YU (receives the underlying, pays fixed);
 * a perp short receives it, so it sells YU. What's left is the fixed leg.
 */
export function HedgeCalculator({
  market,
  account,
  book,
  hourly,
  now,
  onLoad,
}: {
  market: MarketView;
  account: AccountView | null | undefined;
  book: { bids: Level[]; asks: Level[] } | undefined;
  /** Hourly underlying funding, oldest first; `apr` in percent. */
  hourly: { ts: number; apr: number }[];
  now: number;
  onLoad: (p: TicketPreset) => void;
}) {
  const c = useNet();
  const [perp, setPerp] = useState<Side>("Long");
  const [notional, setNotional] = useState(c.depositCap === null ? "10000" : "250");

  const side: Side = perp; // long perp → long YU, short perp → short YU
  const sizeRaw = parseUsdc(notional);
  const sizeYu = sizeRaw ? toNum(sizeRaw) : 0;
  const fill = estimateFill(side === "Long" ? (book?.asks ?? []) : (book?.bids ?? []), side, sizeYu, null);
  const full = sizeYu > 0 && fill.filled >= sizeYu - 1e-6;
  const lockPct = fill.avgPct;
  const secsLeft = Math.max(0, market.maturity_ts - now);
  const tau = secsLeft / YEAR_SECS;
  const fixedTotal = lockPct === null ? 0 : sizeYu * (lockPct / 100) * tau;
  const margin = sizeRaw && lockPct !== null ? initialMargin(market, sizeRaw, lockPct, now) + takerFee(market, sizeRaw, now) : 0;
  const free = account ? toNum(account.health.withdrawable) : null;

  const month = hourly.slice(-24 * 30);
  const avg = month.reduce((s, p) => s + p.apr, 0) / Math.max(1, month.length);
  const lo = month.length ? Math.min(...month.map((p) => p.apr)) : 0;
  const hi = month.length ? Math.max(...month.map((p) => p.apr)) : 0;

  const rows: [string, string][] = [
    ["Hedge trade", sizeYu ? `${side} ${int(sizeYu)} YU at market` : "—"],
    [
      "Fixed rate you lock",
      lockPct === null ? (sizeYu ? "No liquidity on this side" : "—") : `${pct(lockPct)} APR${full ? "" : ` (only ${int(fill.filled)} YU fills now)`}`,
    ],
    ["Locked until", `${date(market.maturity_ts)} · ${Math.ceil(secsLeft / 86_400)} days`],
    [perp === "Long" ? "Fixed you pay over the term" : "Fixed you receive over the term", lockPct === null ? "—" : usd(fixedTotal)],
    ["Unhedged, last 30 days", month.length ? `avg ${pct(avg)} · range ${pct(lo, 0)} to ${pct(hi, 0)}` : "—"],
    ["Margin needed (incl. fee)", lockPct === null ? "—" : `${usd(margin)}${free !== null ? ` · you have ${usd(free)}` : ""}`],
  ];

  return (
    <div>
      <p className="text-[0.8rem] leading-relaxed text-white/65">
        Hold a BTC perp on Hyperliquid? Swap its floating funding for a fixed rate until maturity. The perp stays where it is; only the funding leg changes.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {(["Long", "Short"] as Side[]).map((s) => {
          const on = perp === s;
          return (
            <button
              key={s}
              onClick={() => setPerp(s)}
              className={`rounded-lg border px-3 py-2.5 text-left transition ${on ? "border-lime bg-lime/10" : "border-white/10 hover:border-white/25"}`}
            >
              <div className={`text-[0.9rem] font-semibold ${on ? "text-lime" : "text-white/75"}`}>I&apos;m {s.toLowerCase()} BTC-PERP</div>
              <div className="mt-0.5 text-[0.7rem] text-white/55">{s === "Long" ? "I pay funding" : "I receive funding"}</div>
            </button>
          );
        })}
      </div>

      <label className="mt-4 block">
        <span className="label text-[0.6rem] text-white/60">Perp notional (USD)</span>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/12 bg-white/[0.03] px-3 focus-within:border-lime/60">
          <span className="text-white/50">$</span>
          <input
            value={notional}
            onChange={(e) => setNotional(e.target.value)}
            inputMode="decimal"
            className="w-full bg-transparent px-1 py-2.5 text-lg tnum outline-none"
          />
        </div>
      </label>

      <dl className="mt-5 space-y-2 text-[0.8rem] tnum">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-white/60">{k}</dt>
            <dd className="text-right">{v}</dd>
          </div>
        ))}
      </dl>

      {lockPct !== null && sizeYu > 0 && (
        <div className="mt-4 rounded-lg border border-lime/30 bg-lime/[0.06] px-3 py-2.5 text-[0.8rem] leading-relaxed">
          Perp + hedge: you {perp === "Long" ? "pay" : "receive"} <span className="font-semibold text-lime">{pct(lockPct)} fixed</span> instead of a funding
          rate that moved between {pct(lo, 0)} and {pct(hi, 0)} this month.
        </div>
      )}

      <button
        disabled={!sizeRaw || sizeRaw <= 0n || lockPct === null}
        onClick={() => onLoad({ side, size: notional, kind: "Market" })}
        className="mt-5 w-full rounded-lg bg-lime py-3.5 font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        Load into order ticket
      </button>
      <p className="mt-2 text-[0.7rem] text-white/50">
        Fundswap settles hourly against the same Hyperliquid BTC rate your perp pays, signed by a 2-of-3 oracle. You review and sign the order in the ticket.
      </p>
    </div>
  );
}
