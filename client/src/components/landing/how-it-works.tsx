import type { ReactNode } from "react";
import { getMarkets, getRealizedFunding } from "@/lib/data";
import { hourUtc, int, pct, signedUsd, usd } from "@/lib/format";

const NOTIONAL = 1_000_000;

const Arrow = ({ dir }: { dir: "in" | "out" }) => (
  <svg viewBox="0 0 24 24" className="size-5 text-lime" fill="none" stroke="currentColor" strokeWidth="1.6">
    {dir === "out" ? <path d="M4 12h15M14 7l5 5-5 5" /> : <path d="M20 12H5M10 7l-5 5 5 5" />}
  </svg>
);

const Coin = (
  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-lime font-mono text-sm text-lime">$</span>
);
const Clock = (
  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-lime">
    <svg viewBox="0 0 16 16" className="size-4 text-lime" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 4v4h3" />
    </svg>
  </span>
);

function Card({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="glass flex flex-col p-8">
      <div className="flex items-start">
        <span className="font-mono text-lg text-lime">{n}</span>
        <h3 className="flex-1 pr-6 text-center font-serif text-7xl">{title}</h3>
      </div>
      <div className="my-6 h-px bg-white/12" />
      {children}
    </div>
  );
}

function Flow({ out, back }: { out: string; back: string }) {
  return (
    <div className="mt-6 space-y-2">
      <div className="glass-quiet flex items-center justify-between px-5 py-4">
        <span className="label text-[0.75rem]">{out}</span>
        <Arrow dir="out" />
      </div>
      <div className="glass-quiet flex items-center justify-between px-5 py-4">
        <Arrow dir="in" />
        <span className="label text-[0.75rem]">{back}</span>
      </div>
    </div>
  );
}

export async function HowItWorks() {
  const [markets, realized] = await Promise.all([getMarkets(), getRealizedFunding(8)]);
  const focus = markets.reduce((a, b) => (b.maturityTs > a.maturityTs ? b : a));
  const rate = focus.implied;
  const perDay = (NOTIONAL * rate) / 100 / 365;
  const last = realized.at(-1);
  const fixedHour = (NOTIONAL * rate) / 100 / 8760;
  const floatHour = last ? NOTIONAL * last.hourly : 0;

  return (
    <section id="how-it-works" className="relative overflow-hidden py-28">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-lime/15 to-transparent" />
      <div className="relative mx-auto max-w-[1500px] px-6 lg:px-10">
        <h2 className="text-center font-serif text-[clamp(3.2rem,6.5vw,7rem)] leading-none">
          Two sides. <em className="text-lime">One</em> rate.
        </h2>
        <div className="mt-16 grid gap-8 lg:grid-cols-3">
          <Card n="01" title="Fix">
            <div className="text-center">
              <div className="label text-2xl tracking-[0.2em] text-lime">Long YU</div>
              <div className="label mt-3 text-[0.78rem]">Pays fixed · receives floating</div>
            </div>
            <Flow out="Pays fixed" back="Receives floating" />
            <div className="my-6 h-px bg-white/12" />
            <div className="space-y-4 font-mono text-lg tnum">
              <div className="flex items-center gap-4">{Coin}{int(NOTIONAL)} YU @ {pct(rate)}</div>
              <div className="flex items-center gap-4">{Clock}{usd(perDay)} / day fixed</div>
            </div>
          </Card>

          <Card n="02" title="Float">
            <div className="text-center">
              <div className="label text-2xl tracking-[0.2em] text-lime">Short YU</div>
              <div className="label mt-3 text-[0.78rem]">Pays floating · receives fixed</div>
            </div>
            <Flow out="Pays floating" back="Receives fixed" />
            <div className="my-6 h-px bg-white/12" />
            <div className="space-y-4 font-mono text-lg tnum">
              <div className="flex items-center gap-4">{Coin}{int(NOTIONAL)} YU @ {pct(rate)}</div>
              <div className="flex items-center gap-4">{Clock}{usd(perDay)} / day received</div>
            </div>
          </Card>

          <Card n="03" title="Settle">
            <div className="label text-center text-[0.95rem]">Every hour, onchain</div>
            <div className="mt-10">
              <div className="flex justify-between px-1">
                {Array.from({ length: 19 }, (_, i) => (
                  <span key={i} className={`w-px bg-lime ${i % 4 === 0 ? "h-5" : "h-3"}`} />
                ))}
              </div>
              <div className="relative mt-4 flex justify-between">
                <div className="absolute inset-x-0 top-1/2 h-px bg-lime/70" />
                {realized.slice(-6).map((p) => (
                  <span key={p.ts} className="relative size-3 rounded-full bg-lime shadow-[0_0_10px_rgb(198_244_50/0.7)]" />
                ))}
              </div>
              <div className="mt-3 flex justify-between font-mono text-xs text-lime">
                {realized.slice(-6).map((p) => (
                  <span key={p.ts}>{hourUtc(p.ts)}</span>
                ))}
              </div>
            </div>
            {last && (
              <div className="glass-quiet mt-auto space-y-2 p-5 font-mono text-sm tnum">
                <div className="label text-[0.65rem] text-lime">
                  Last hour · {hourUtc(last.ts)} UTC · realized {pct(last.apr)} APR
                </div>
                <div className="flex justify-between"><span className="text-white/70">Long pays fixed</span><span>{signedUsd(-fixedHour)}</span></div>
                <div className="flex justify-between"><span className="text-white/70">Long receives floating</span><span>{signedUsd(floatHour)}</span></div>
                <div className="flex justify-between border-t border-white/10 pt-2">
                  <span>Long net · short net</span>
                  <span className={floatHour - fixedHour >= 0 ? "text-lime" : ""}>
                    {signedUsd(floatHour - fixedHour)} · {signedUsd(fixedHour - floatHour)}
                  </span>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}
