"use client";

import { useState } from "react";
import { LineChart, Legend } from "@/components/charts";
import type { FundingPoint, Point } from "@/lib/data";
import { pct } from "@/lib/format";

const RANGES = { "1D": 24, "7D": 24 * 7, "30D": 24 * 30 } as const;
type Range = keyof typeof RANGES;

export function ImpliedVsRealizedCard({
  implied,
  impliedNow,
  realized,
}: {
  implied: Point[];
  impliedNow: number;
  realized: FundingPoint[];
}) {
  const [range, setRange] = useState<Range>("1D");
  const since = (realized.at(-1)?.ts ?? 0) - RANGES[range] * 3_600;
  const realized24 = realized.slice(-24);
  const realizedAvg = realized24.reduce((s, p) => s + p.apr, 0) / Math.max(1, realized24.length);

  return (
    <div className="flex h-full flex-col">
      <div className="mt-4 flex items-start justify-between">
        <div>
          <div className="label text-[0.62rem] text-white/80">Implied APR</div>
          <div className="mt-1 font-serif text-4xl text-lime tnum">{pct(impliedNow)}</div>
        </div>
        <div className="text-right">
          <div className="label text-[0.62rem] text-white/80">Realized APR (24h)</div>
          <div className="mt-1 font-serif text-4xl tnum">{pct(realizedAvg)}</div>
        </div>
      </div>
      <div className="mt-4 border-t border-white/10 pt-3">
        <Legend
          items={[
            { label: "Implied APR", variant: "lime" },
            { label: "Realized APR (hourly)", variant: "dashed" },
          ]}
        />
      </div>
      <LineChart
        className="mt-2"
        width={460}
        height={210}
        series={[
          { label: "Implied", variant: "lime", points: implied.filter((p) => p.ts >= since).map((p) => ({ ts: p.ts, v: p.apr })) },
          { label: "Realized", variant: "dashed", points: realized.filter((p) => p.ts >= since).map((p) => ({ ts: p.ts, v: p.apr })) },
        ]}
      />
      <div className="mt-auto flex justify-center gap-10 border-t border-white/10 pt-3">
        {(Object.keys(RANGES) as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`font-mono text-xs tracking-[0.12em] ${r === range ? "text-lime underline decoration-lime underline-offset-6" : "text-white/70 hover:text-white"}`}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
