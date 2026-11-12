"use client";

import { useState } from "react";
import type { FundingPoint, Point } from "@/lib/data";
import { hourUtc, monthDay, pct } from "@/lib/format";
import { rateToPct, toNum, type Candle } from "@/lib/swap";

const RANGES = { "1D": 24, "7D": 24 * 7, "30D": 24 * 30 } as const;
type Range = keyof typeof RANGES;

/** Trailing mean over `hours` points, for every point that has a full window. */
function movingAverage(points: FundingPoint[], hours: number): { ts: number; v: number }[] {
  const out: { ts: number; v: number }[] = [];
  let sum = 0;
  points.forEach((p, i) => {
    sum += p.apr;
    if (i >= hours) sum -= points[i - hours].apr;
    if (i >= hours - 1) out.push({ ts: p.ts, v: sum / hours });
  });
  return out;
}

function niceTicks(lo: number, hi: number, n: number) {
  const raw = (hi - lo) / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const t: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) t.push(Number(v.toFixed(6)));
  return { lo: a, hi: b, ticks: t };
}

/**
 * Implied-rate candles (hourly OHLC of real fills, from the contract), the
 * book mid each hour (archival reads), and Hyperliquid's realized funding
 * with its 7- and 30-day moving averages.
 */
export function RateChart({ candles, mids, realized }: { candles: Candle[]; mids: Point[]; realized: FundingPoint[] }) {
  const [range, setRange] = useState<Range>("7D");
  const [hover, setHover] = useState<number | null>(null);
  const end = Math.max(realized.at(-1)?.ts ?? 0, mids.at(-1)?.ts ?? 0, candles.at(-1)?.hour_ts ?? 0);
  const start = end - RANGES[range] * 3_600;

  const ma7All = movingAverage(realized, 24 * 7);
  const ma30All = movingAverage(realized, 24 * 30);
  const inRange = <T extends { ts: number }>(xs: T[]) => xs.filter((p) => p.ts >= start);
  const under = inRange(realized.map((p) => ({ ts: p.ts, v: p.apr })));
  const ma7 = inRange(ma7All);
  const ma30 = inRange(ma30All);
  const mid = inRange(mids.map((p) => ({ ts: p.ts, v: p.apr })));
  const cs = candles
    .filter((c) => c.hour_ts >= start)
    .map((c) => ({ ts: c.hour_ts, o: rateToPct(c.open), h: rateToPct(c.high), l: rateToPct(c.low), c: rateToPct(c.close), vol: toNum(c.volume) }));

  const W = 1000;
  const H = 400;
  const pad = { l: 12, r: 58, t: 14, b: 26 };
  const values = [...under, ...ma7, ...ma30, ...mid].map((p) => p.v).concat(cs.flatMap((c) => [c.h, c.l]));
  if (values.length < 2) return <div className="label grid h-64 place-items-center text-white/40">Loading history…</div>;
  const y = niceTicks(Math.min(0, ...values), Math.max(...values), 6);
  const X = (ts: number) => pad.l + ((ts - start) / Math.max(1, end - start)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + ((y.hi - v) / (y.hi - y.lo)) * (H - pad.t - pad.b);
  const path = (pts: { ts: number; v: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const candleW = Math.max(2, ((W - pad.l - pad.r) / RANGES[range]) * 0.6);
  const xs = Array.from({ length: 6 }, (_, i) => start + ((end - start) * i) / 5);

  const at = hover ?? end;
  const nearest = <T extends { ts: number }>(arr: T[]) =>
    arr.reduce<T | null>((b, p) => (!b || Math.abs(p.ts - at) < Math.abs(b.ts - at) ? p : b), null);
  const hc = nearest(cs);
  const hcIn = hc && Math.abs(hc.ts - at) <= 3_600 ? hc : null;
  const legend: [string, string, string][] = [
    ["Underlying", nearest(under) ? pct(nearest(under)!.v) : "—", "text-white"],
    ["Underlying 7d MA", nearest(ma7) ? pct(nearest(ma7)!.v) : "—", "text-white/70"],
    ["Underlying 30d MA", nearest(ma30) ? pct(nearest(ma30)!.v) : "—", "text-white/50"],
    ["Book mid", nearest(mid) ? pct(nearest(mid)!.v) : "—", "text-lime"],
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <button key={r} onClick={() => setRange(r)} className={`rounded-md px-3 py-1 text-xs ${r === range ? "bg-white/10 text-lime" : "text-white/60 hover:text-white"}`}>
              {r}
            </button>
          ))}
        </div>
        <span className="label text-[0.55rem] text-white/40">1h candles · {hourUtc(at)} UTC {monthDay(at)}</span>
      </div>
      <div className="mt-3 space-y-0.5 text-[0.72rem]">
        <div>
          <span className="text-white/60">Implied </span>
          {hcIn ? (
            <span className="text-lime tnum">
              O {pct(hcIn.o)} H {pct(hcIn.h)} L {pct(hcIn.l)} C {pct(hcIn.c)} · {Math.round(hcIn.vol).toLocaleString("en-US")} YU
            </span>
          ) : (
            <span className="text-white/40">no trades this hour</span>
          )}
        </div>
        {legend.map(([l, v, cls]) => (
          <div key={l}>
            <span className="text-white/60">{l} </span>
            <span className={`${cls} tnum`}>{v}</span>
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-2 h-auto w-full select-none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.round((start + ((x - pad.l) / (W - pad.l - pad.r)) * (end - start)) / 3_600) * 3_600);
        }}
      >
        {y.ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="white" strokeOpacity={v === 0 ? 0.25 : 0.06} />
            <text x={W - pad.r + 8} y={Y(v) + 4} className="fill-white/60 text-[12px]">{pct(v, 0)}</text>
          </g>
        ))}
        {xs.map((ts, i) => (
          <text key={i} x={X(ts)} y={H - 6} textAnchor={i === 0 ? "start" : i === 5 ? "end" : "middle"} className="fill-white/60 text-[12px]">
            {range === "1D" ? hourUtc(ts) : monthDay(ts)}
          </text>
        ))}
        <path d={path(ma30)} fill="none" stroke="white" strokeOpacity={0.35} strokeWidth={1.3} strokeDasharray="1 4" strokeLinecap="round" />
        <path d={path(ma7)} fill="none" stroke="white" strokeOpacity={0.55} strokeWidth={1.4} />
        <path d={path(under)} fill="none" stroke="white" strokeOpacity={0.85} strokeWidth={1.2} strokeDasharray="3 3" />
        <path d={path(mid)} fill="none" stroke="#c6f432" strokeOpacity={0.55} strokeWidth={1.4} strokeDasharray="6 4" />
        {cs.map((c) => {
          const up = c.c >= c.o;
          const x = X(c.ts);
          return (
            <g key={c.ts}>
              <line x1={x} x2={x} y1={Y(c.h)} y2={Y(c.l)} stroke={up ? "#c6f432" : "white"} strokeOpacity={up ? 1 : 0.6} />
              <rect
                x={x - candleW / 2}
                width={candleW}
                y={Y(Math.max(c.o, c.c))}
                height={Math.max(1.5, Math.abs(Y(c.o) - Y(c.c)))}
                fill={up ? "#c6f432" : "rgb(255 255 255 / 0.55)"}
              />
            </g>
          );
        })}
        {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={H - pad.b} stroke="white" strokeOpacity={0.35} strokeDasharray="3 3" />}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
        {[
          ["Implied (1h candles)", "h-2.5 w-2 bg-lime"],
          ["Book mid", "w-5 border-t border-dashed border-lime/70"],
          ["Underlying", "w-5 border-t border-dashed border-white/80"],
          ["7d MA", "h-px w-5 bg-white/55"],
          ["30d MA", "w-5 border-t border-dotted border-white/40"],
        ].map(([l, cls]) => (
          <span key={l} className="label flex items-center gap-2 text-[0.55rem] text-white/60">
            <span className={cls} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
