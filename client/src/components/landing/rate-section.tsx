import { LineChart, Legend } from "@/components/charts";
import { getImpliedHistory, getMarkets, getRealizedFunding } from "@/lib/data";
import { int, pct } from "@/lib/format";

const HOURS = 24 * 7;

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function correlation(pairs: [number, number][]): number {
  if (pairs.length < 3) return NaN;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

const show = (x: number, f: (n: number) => string) => (Number.isFinite(x) ? f(x) : "—");

export async function RateSection() {
  const markets = await getMarkets();
  const focus = markets.reduce((a, b) => (b.maturityTs > a.maturityTs ? b : a));
  const [realized, implied] = await Promise.all([getRealizedFunding(HOURS), getImpliedHistory(focus.id, HOURS)]);
  const byTs = new Map(realized.map((p) => [p.ts, p.apr]));
  const pairs = implied.filter((p) => byTs.has(p.ts)).map((p): [number, number] => [p.apr, byTs.get(p.ts)!]);

  const stats: [string, string, boolean][] = [
    ["Current implied APR", pct(focus.implied), true],
    ["Current realized funding", show(realized.at(-1)?.apr ?? NaN, pct), false],
    ["7D implied avg", show(mean(implied.map((p) => p.apr)), pct), true],
    ["7D realized avg", show(mean(realized.map((p) => p.apr)), pct), false],
    ["7D correlation", show(correlation(pairs), (c) => c.toFixed(2)), true],
    ["Data points", int(realized.length + implied.length), false],
  ];

  return (
    <section className="relative overflow-hidden py-28">
      <div className="rays rays-fade rays-soft !inset-x-auto !left-0 !w-1/2" />
      <div className="relative mx-auto grid max-w-[1500px] gap-12 px-6 lg:grid-cols-[0.42fr_1fr] lg:px-10">
        <div className="lg:pt-16">
          <h2 className="font-normal tracking-[-0.045em] text-[clamp(2.75rem,4.4vw,4.75rem)] leading-[0.95]">
            The rate is
            <br />
            the <span className="accent text-lime">product.</span>
          </h2>
          <div className="mt-10 h-px w-14 bg-lime" />
          <div className="label mt-8 text-lime">Hourly funding comparison</div>
          <p className="mt-4 max-w-[34ch] text-[0.98rem] leading-8 text-white/90">
            Hyperliquid BTC hourly funding (realized) against the implied APR of Fundswap&apos;s {focus.name.split("·")[1]?.trim()} market, read
            hour by hour from the contract on testnet.
          </p>
        </div>

        <div className="glass p-6 lg:p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex gap-3">
              <span className="rounded-xl bg-lime px-6 py-2.5 text-sm tracking-[0.1em] text-ink">BTC</span>
              {["ETH", "SOL"].map((c) => (
                <span key={c} title="Not listed yet" className="rounded-xl border border-white/15 px-6 py-2.5 text-sm tracking-[0.1em] text-white/35">
                  {c}
                </span>
              ))}
            </div>
            <div className="flex flex-col items-end gap-2">
              <Legend items={[{ label: "Implied APR (Fundswap)", variant: "lime" }]} />
              <Legend items={[{ label: "Realized funding (Hyperliquid BTC)", variant: "dashed" }]} />
            </div>
          </div>
          <div className="relative mt-6 pl-5">
            <span className="label absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 -rotate-90 text-[0.6rem] text-white/60">
              APR (annualized)
            </span>
            <LineChart
              width={1000}
              height={420}
              yTicks={8}
              xTicks={8}
              xFormat="day"
              rightAxis
              series={[
                { label: "Implied", variant: "lime", points: implied.map((p) => ({ ts: p.ts, v: p.apr })) },
                { label: "Realized", variant: "dashed", points: realized.map((p) => ({ ts: p.ts, v: p.apr })) },
              ]}
            />
            <div className="label mt-1 text-center text-[0.65rem] text-white/60">Time (UTC)</div>
          </div>
          <div className="glass-quiet mt-6 grid grid-cols-2 divide-white/10 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
            {stats.map(([label, value, lime]) => (
              <div key={label} className="px-4 py-5 text-center">
                <div className="label text-[0.58rem] text-white/80">{label}</div>
                <div className={`mt-3 text-2xl tnum ${lime ? "text-lime" : ""}`}>{value}</div>
              </div>
            ))}
          </div>
          {implied.length < HOURS && implied[0] && (
            <p className="mt-4 text-[0.7rem] text-white/50">
              Implied history starts {new Date(implied[0].ts * 1000).toUTCString().slice(5, 22)} UTC, when the market opened.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
