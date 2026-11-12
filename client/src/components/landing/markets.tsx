import { NETS, type Net } from "@/lib/config";
import { getImpliedHistory, getMarkets, type Mode } from "@/lib/data";
import { date, pct, signedPct, usdCompact } from "@/lib/format";

const MODE_STYLE: Record<Mode, string> = {
  Active: "text-lime",
  CloseOnly: "text-white/70",
  Paused: "text-white/40",
};
const MODE_LABEL: Record<Mode, string> = { Active: "Active", CloseOnly: "Close only", Paused: "Paused" };

export async function Markets({ net }: { net: Net }) {
  const c = NETS[net];
  const markets = (await getMarkets(net)).sort((a, b) => a.maturityTs - b.maturityTs);
  const histories = await Promise.all(markets.map((m) => getImpliedHistory(net, m.id, 25)));
  const rows = markets.map((m, i) => {
    const h = histories[i];
    const dayAgo = h.length >= 25 ? h[0].apr : null;
    return { ...m, change: dayAgo === null ? null : m.implied - dayAgo };
  });
  const cols = ["Market", "Matures", "Implied APR", "Bid", "Ask", "24h change", "Open interest", "Status"];

  return (
    <section id="markets" className="relative overflow-hidden py-28">
      <div className="mx-auto max-w-[1500px] px-6 lg:px-10">
        <div className="flex items-center gap-8">
          <h2 className="font-normal tracking-[-0.045em] text-[clamp(3rem,5.5vw,6rem)] leading-none">Markets</h2>
          <span className="label flex items-center gap-3 text-lg tracking-[0.1em] text-lime">
            <span className="live-dot size-3 rounded-full bg-lime" />
            Live
          </span>
        </div>
        <div className="relative mt-12">
          <div className="glass overflow-x-auto !border-white/12 !shadow-none">
            <table className="w-full min-w-[980px] border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  {cols.map((c, i) => (
                    <th key={c} className={`label px-6 py-7 text-[0.75rem] font-normal ${i === 0 ? "text-left" : "text-center"} border-white/8 [&:not(:last-child)]:border-r`}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((m, i) => (
                  <tr key={m.id} className="group border-b border-white/8 last:border-b-0 hover:bg-white/[0.02]">
                    <td className={`relative px-6 py-9 text-xl ${i === 0 ? "" : ""}`}>
                      <span className="absolute inset-y-0 left-0 w-1 bg-lime opacity-0 transition group-hover:opacity-100 group-first:opacity-100" />
                      {m.name}
                    </td>
                    <td className="border-l border-white/8 px-6 text-center text-xl">{date(m.maturityTs)}</td>
                    <td className="border-l border-white/8 px-6 text-center text-xl tnum">{pct(m.implied)}</td>
                    <td className="border-l border-white/8 px-6 text-center text-xl tnum">{m.bid === null ? "—" : pct(m.bid)}</td>
                    <td className="border-l border-white/8 px-6 text-center text-xl tnum">{m.ask === null ? "—" : pct(m.ask)}</td>
                    <td className={`border-l border-white/8 px-6 text-center text-xl tnum ${m.change !== null && m.change >= 0 ? "text-lime" : "text-white/80"}`}>
                      {m.change === null ? "—" : signedPct(m.change)}
                    </td>
                    <td className="border-l border-white/8 px-6 text-center text-xl tnum">{usdCompact(m.openInterest)}</td>
                    <td className={`border-l border-white/8 px-6 text-center text-xl ${MODE_STYLE[m.mode]}`}>{MODE_LABEL[m.mode]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pointer-events-none absolute inset-x-[8%] -bottom-px h-px bg-lime shadow-[0_0_30px_6px_rgb(198_244_50/0.45)]" />
        </div>
        <p className="mt-6 text-xs text-white/50">
          NEAR {c.label.toLowerCase()} · {c.swap} · collateral {c.symbol} · implied = book mid (mark when one side is empty) · 24h change appears once a market is a day old.
        </p>
      </div>
    </section>
  );
}
