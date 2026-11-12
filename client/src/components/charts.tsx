"use client";

import { useState } from "react";
import { hourUtc, monthDay, pct } from "@/lib/format";

export interface Series {
  label: string;
  points: { ts: number; v: number }[];
  variant: "lime" | "dashed";
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
}

/** Domain and ticks for a percent axis that always includes 0. */
function yAxis(values: number[], ticks: number) {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi - lo < 1) hi = lo + 1;
  const step = niceStep(hi - lo, ticks);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(6)));
  return { lo, hi, ticks: out };
}

/**
 * Line chart for hourly APR series. Hover shows a crosshair with the values
 * of every series at that hour.
 */
export function LineChart({
  series,
  width = 640,
  height = 260,
  yTicks = 6,
  xTicks = 5,
  xFormat = "auto",
  rightAxis = false,
  className = "",
}: {
  series: Series[];
  width?: number;
  height?: number;
  yTicks?: number;
  xTicks?: number;
  xFormat?: "hour" | "day" | "auto";
  rightAxis?: boolean;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <div className="label grid h-full place-items-center text-mute">No data yet</div>;

  const pad = { l: 46, r: rightAxis ? 46 : 12, t: 10, b: 28 };
  const t0 = Math.min(...all.map((p) => p.ts));
  const t1 = Math.max(...all.map((p) => p.ts));
  const y = yAxis(all.map((p) => p.v), yTicks);
  const X = (ts: number) => pad.l + ((ts - t0) / Math.max(1, t1 - t0)) * (width - pad.l - pad.r);
  const Y = (v: number) => pad.t + ((y.hi - v) / (y.hi - y.lo)) * (height - pad.t - pad.b);
  const fmt = xFormat === "auto" ? (t1 - t0 > 2 * 86_400 ? "day" : "hour") : xFormat;
  const xLabels = Array.from({ length: xTicks }, (_, i) => t0 + ((t1 - t0) * i) / (xTicks - 1));
  const path = (pts: Series["points"]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const hoverTs = hover;
  const nearest = (pts: Series["points"], ts: number) =>
    pts.reduce<Series["points"][number] | null>((b, p) => (!b || Math.abs(p.ts - ts) < Math.abs(b.ts - ts) ? p : b), null);

  return (
    <div className={`relative ${className}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full select-none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * width;
          const ts = t0 + ((x - pad.l) / (width - pad.l - pad.r)) * (t1 - t0);
          setHover(Math.min(t1, Math.max(t0, ts)));
        }}
      >
        {y.ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(v)} y2={Y(v)} stroke="white" strokeOpacity={v === 0 ? 0.22 : 0.07} strokeDasharray={v === 0 ? undefined : "3 4"} />
            <text x={pad.l - 8} y={Y(v) + 3.5} textAnchor="end" className="fill-white/70 text-[10px]">
              {pct(v, 0)}
            </text>
            {rightAxis && (
              <text x={width - pad.r + 8} y={Y(v) + 3.5} className="fill-white/70 text-[10px]">
                {pct(v, 0)}
              </text>
            )}
          </g>
        ))}
        {xLabels.map((ts, i) => (
          <text key={i} x={X(ts)} y={height - 8} textAnchor={i === 0 ? "start" : i === xTicks - 1 ? "end" : "middle"} className="fill-white/70 text-[10px]">
            {fmt === "day" ? monthDay(ts) : hourUtc(ts)}
          </text>
        ))}
        {series.map((s) =>
          s.points.length > 1 ? (
            <path
              key={s.label}
              d={path(s.points)}
              fill="none"
              stroke={s.variant === "lime" ? "#c6f432" : "white"}
              strokeOpacity={s.variant === "lime" ? 1 : 0.75}
              strokeWidth={s.variant === "lime" ? 2.2 : 1.4}
              strokeDasharray={s.variant === "dashed" ? "2 3" : undefined}
              strokeLinejoin="round"
              style={s.variant === "lime" ? { filter: "drop-shadow(0 0 6px rgb(198 244 50 / 0.55))" } : undefined}
            />
          ) : null,
        )}
        {series
          .filter((s) => s.variant === "lime" && s.points.length)
          .map((s) => {
            const p = s.points[s.points.length - 1];
            return <circle key={s.label} cx={X(p.ts)} cy={Y(p.v)} r={4.5} fill="#0b0b0c" stroke="#c6f432" strokeWidth={2} />;
          })}
        {hoverTs !== null && (
          <g>
            <line x1={X(hoverTs)} x2={X(hoverTs)} y1={pad.t} y2={height - pad.b} stroke="white" strokeOpacity={0.5} strokeDasharray="3 3" />
            {series.map((s) => {
              const p = nearest(s.points, hoverTs);
              return p && Math.abs(p.ts - hoverTs) <= 3_600 ? (
                <circle key={s.label} cx={X(p.ts)} cy={Y(p.v)} r={3.5} fill="#0b0b0c" stroke={s.variant === "lime" ? "#c6f432" : "white"} strokeWidth={1.5} />
              ) : null;
            })}
          </g>
        )}
      </svg>
      {hoverTs !== null && (
        <div
          className="glass-quiet pointer-events-none absolute top-2 z-10 min-w-44 bg-ink/90 px-3 py-2 text-[11px]"
          style={X(hoverTs) > width / 2 ? { right: `${((width - X(hoverTs)) / width) * 100 + 2}%` } : { left: `${(X(hoverTs) / width) * 100 + 2}%` }}
        >
          <div className="mb-1 tracking-[0.06em] text-lime">
            {monthDay(hoverTs)} · {hourUtc(Math.floor(hoverTs / 3_600) * 3_600)} UTC
          </div>
          {series.map((s) => {
            const p = nearest(s.points, hoverTs);
            return (
              <div key={s.label} className="flex justify-between gap-4 uppercase tracking-[0.1em]">
                <span className="text-white/70">{s.variant === "lime" ? "—" : "--"} {s.label}</span>
                <span>{p && Math.abs(p.ts - hoverTs) <= 3_600 ? pct(p.v) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; variant: "lime" | "dashed" }[] }) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="label flex items-center gap-2 text-[0.62rem] text-white/80">
          <span className={i.variant === "lime" ? "h-0.5 w-6 bg-lime" : "w-6 border-t border-dashed border-white/80"} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
