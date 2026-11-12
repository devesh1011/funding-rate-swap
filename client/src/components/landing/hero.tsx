import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { getBook, getImpliedHistory, getMarkets, getOracle, getPredictedFunding, getRealizedFunding } from "@/lib/data";
import { dayMonth, hourUtc, int, pct, signedUsd, usdCompact } from "@/lib/format";
import { ImpliedVsRealizedCard } from "./implied-card";

/** Notional the settlement card is computed for. */
const EXAMPLE_YU = 1_000_000;

export function Nav() {
  return (
    <header className="relative z-20 mx-auto flex max-w-[1500px] items-center justify-between px-6 py-6 lg:px-10">
      <Link href="/" aria-label="Fundswap home">
        <Logo />
      </Link>
      <nav className="hidden items-center gap-12 font-mono text-[0.95rem] text-white/90 lg:flex">
        <a href="#markets" className="flex items-center gap-3 hover:text-lime">
          <span className="size-2 rounded-full bg-lime" />
          Markets
        </a>
        <a href="#how-it-works" className="hover:text-lime">How it works</a>
        <Link href="/docs" className="hover:text-lime">Docs</Link>
        <a href="#oracle" className="hover:text-lime">Oracle</a>
      </nav>
      <div className="flex items-center gap-3">
        <Link href="/trade" className="pill hidden border border-white/40 px-6 py-2.5 text-base hover:border-white sm:inline-flex">
          Connect wallet
        </Link>
        <Link href="/trade" className="pill pill-lime px-6 py-2.5 text-base">
          Launch app
        </Link>
      </div>
    </header>
  );
}

function Stat({ value, label, align }: { value: string; label: string; align: "left" | "right" }) {
  const right = align === "right";
  return (
    <div className={`min-w-0 py-3 ${right ? "border-r pr-8 text-right" : "border-l pl-4 sm:pl-8"} border-white/20`}>
      <div className="inline-block border-b border-lime pb-1 font-serif text-4xl tnum sm:text-5xl xl:text-6xl">{value}</div>
      <div className="label mt-3 text-[0.62rem] text-lime sm:text-[0.72rem]">{label}</div>
    </div>
  );
}

function CardHeader({ n, title, icon }: { n: string; title: string; icon: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-white/10 pb-3">
      <div className="label flex gap-4 text-[0.8rem] text-white">
        <span className="text-lime">{n}</span>
        {title}
      </div>
      <span className="grid size-7 place-items-center rounded-md border border-white/25 text-white/70">{icon}</span>
    </div>
  );
}

const IconExpand = (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
  </svg>
);
const IconChart = (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M2.5 11.5 6 8l2.5 2.5 5-5M10 5.5h3.5V9" />
  </svg>
);
const IconBars = (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
    <rect x="3" y="8" width="2" height="5" rx=".5" />
    <rect x="7" y="4" width="2" height="9" rx=".5" />
    <rect x="11" y="6" width="2" height="7" rx=".5" />
  </svg>
);

async function OrderBookCard({ marketId, implied }: { marketId: number; implied: number }) {
  const book = await getBook(marketId);
  const asks = book.asks.slice(0, 3).reverse();
  const bids = book.bids.slice(0, 3);
  const Row = ({ apr, size, lime }: { apr: number; size: number; lime?: boolean }) => (
    <div className="grid grid-cols-[1fr_auto] py-1 font-mono text-[0.95rem] tnum">
      <span className={lime ? "text-lime" : "text-white"}>{pct(apr)}</span>
      <span className="text-white/90">{int(size)}</span>
    </div>
  );
  return (
    <>
      <CardHeader n="01" title="Order book" icon={IconExpand} />
      <div className="label mt-4 flex justify-between text-[0.6rem] text-white/60">
        <span>Asks · receive fixed</span>
        <span>Size (YU)</span>
      </div>
      <div className="mt-1">{asks.length ? asks.map((l) => <Row key={l.apr} {...l} />) : <Empty />}</div>
      <div className="my-2 flex items-baseline gap-4 border-y border-dashed border-white/15 py-2">
        <span className="font-serif text-4xl text-lime tnum">{pct(implied)}</span>
        <span className="label text-[0.65rem] text-lime">Mid</span>
      </div>
      <div className="label text-[0.6rem] text-white/60">Bids · pay fixed</div>
      <div className="mt-1">{bids.length ? bids.map((l) => <Row key={l.apr} {...l} lime />) : <Empty />}</div>
    </>
  );
}

const Empty = () => <div className="py-1 font-mono text-sm text-white/40">— no orders —</div>;

async function SettlementsCard({ implied }: { implied: number }) {
  const [realized, predicted] = await Promise.all([getRealizedFunding(24), getPredictedFunding()]);
  const fixedPerHour = (EXAMPLE_YU * implied) / 100 / 8760;
  const bars = realized.slice(-16).map((p) => ({ ts: p.ts, v: EXAMPLE_YU * p.hourly - fixedPerHour }));
  const next = EXAMPLE_YU * predicted - fixedPerHour;
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.v)), Math.abs(next));
  const H = 150;
  const barW = 100 / (bars.length + 1);
  return (
    <>
      <CardHeader n="03" title="Funding settlements" icon={IconBars} />
      <div className="label mt-4 flex justify-between text-[0.6rem] text-white/60">
        <span>Long {int(EXAMPLE_YU / 1e6)}M YU @ {pct(implied)} · hourly (UTC)</span>
        <span className="text-lime">Now</span>
      </div>
      <div className="relative mt-3" style={{ height: H + 22 }}>
        <div className="absolute inset-x-0 border-t border-white/25" style={{ top: H / 2 }} />
        {bars.map((b, i) => {
          const h = (Math.abs(b.v) / max) * (H / 2 - 6);
          return (
            <div
              key={b.ts}
              title={`${hourUtc(b.ts)} UTC  ${signedUsd(b.v)}`}
              className={`absolute rounded-[2px] ${b.v >= 0 ? "bg-lime shadow-[0_0_10px_rgb(198_244_50/0.5)]" : "bg-white/35"}`}
              style={{ left: `${i * barW + barW * 0.3}%`, width: `${barW * 0.42}%`, height: Math.max(2, h), top: b.v >= 0 ? H / 2 - h : H / 2 }}
            />
          );
        })}
        <div className="absolute border-l border-dashed border-lime" style={{ left: `${bars.length * barW + barW * 0.15}%`, top: 0, height: H }} />
        {[0, Math.floor(bars.length / 2), bars.length - 1].map((i) =>
          bars[i] ? (
            <span key={i} className="absolute font-mono text-[10px] text-white/60" style={{ left: `${i * barW}%`, top: H + 6 }}>
              {hourUtc(bars[i].ts)}
            </span>
          ) : null,
        )}
      </div>
      <div className="glass-quiet mt-auto grid grid-cols-2 divide-x divide-white/10 py-3 text-center">
        <div>
          <div className="label text-[0.6rem] text-white/70">Latest settlement</div>
          <div className={`mt-1 font-serif text-3xl tnum ${bars.at(-1) && bars.at(-1)!.v >= 0 ? "text-lime" : "text-white/80"}`}>
            {bars.at(-1) ? signedUsd(bars.at(-1)!.v) : "—"}
          </div>
        </div>
        <div>
          <div className="label text-[0.6rem] text-white/70">Next estimate</div>
          <div className={`mt-1 font-serif text-3xl tnum ${next >= 0 ? "text-lime" : "text-white/80"}`}>{signedUsd(next)}</div>
        </div>
      </div>
    </>
  );
}

export async function Hero() {
  const [markets, oracle, realized] = await Promise.all([getMarkets(), getOracle(), getRealizedFunding(24 * 30)]);
  const active = markets.filter((m) => m.mode === "Active");
  const focus = (active.length ? active : markets).reduce((a, b) => (b.maturityTs > a.maturityTs ? b : a));
  const implied = await getImpliedHistory(focus.id);
  const last24 = realized.slice(-24);
  const funding24 = last24.reduce((s, p) => s + p.apr, 0) / Math.max(1, last24.length);
  const oi = markets.reduce((s, m) => s + m.openInterest, 0);

  return (
    <section className="relative overflow-hidden">
      <div className="rays" />
      <Nav />
      <div className="relative z-10 mx-auto max-w-[1500px] px-6 lg:px-10">
        <div className="grid grid-cols-1 items-center gap-10 pt-4 lg:grid-cols-[1fr_auto_1fr] lg:pt-2 [&>*]:min-w-0">
          <div className="hidden flex-col gap-10 justify-self-start lg:flex">
            <Stat value={pct(funding24)} label="BTC funding · 24h APR" align="left" />
            <Stat value={pct(focus.implied)} label={`Implied · ${dayMonth(focus.maturityTs)}`} align="left" />
          </div>
          <div className="text-center">
            <h1 className="font-serif text-[clamp(3.3rem,8.8vw,9.5rem)] leading-[0.84] tracking-[-0.01em]">
              Lock the
              <br />
              <em className="pr-[0.04em] text-lime" style={{ textShadow: "0 0 40px rgb(198 244 50 / 0.25)" }}>funding</em> rate.
            </h1>
            <p className="mx-auto mt-5 font-mono text-[clamp(0.9rem,1.15vw,1.15rem)] leading-relaxed text-lime">
              Trade Hyperliquid BTC funding as a fixed-for-floating swap.
              <br />
              Settled hourly, onchain.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-4">
              <Link href="/trade" className="pill pill-lime text-lg sm:min-w-56">
                Start trading
              </Link>
              <a href="#how-it-works" className="pill pill-ghost text-lg sm:min-w-56">
                How it works
              </a>
            </div>
          </div>
          <div className="hidden flex-col items-end gap-10 justify-self-end lg:flex">
            <Stat value={usdCompact(oi)} label="Open interest" align="right" />
            <Stat value={`${oracle.threshold}-of-${oracle.signers.length}`} label="Oracle signers" align="right" />
          </div>
          {/* Small screens: stats as a 2×2 grid. */}
          <div className="grid grid-cols-2 gap-6 lg:hidden">
            <Stat value={pct(funding24)} label="BTC funding · 24h" align="left" />
            <Stat value={pct(focus.implied)} label={`Implied · ${dayMonth(focus.maturityTs)}`} align="left" />
            <Stat value={usdCompact(oi)} label="Open interest" align="left" />
            <Stat value={`${oracle.threshold}-of-${oracle.signers.length}`} label="Oracle signers" align="left" />
          </div>
        </div>

        <div className="mt-14 grid gap-6 pb-16 [perspective:1600px] lg:-mt-2 lg:grid-cols-[1fr_1.12fr_1fr] lg:items-end lg:gap-8 lg:pb-0">
          <div className="glass flex flex-col p-6 lg:min-h-[440px] lg:[transform:rotateY(12deg)_rotateZ(1.5deg)_translateY(2.5rem)]">
            <OrderBookCard marketId={focus.id} implied={focus.implied} />
          </div>
          <div className="glass flex flex-col p-6 lg:min-h-[460px] lg:translate-y-6">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <div className="label flex gap-4 text-[0.8rem]">
                <span className="text-lime">02</span>Implied vs realized
              </div>
              <span className="grid size-7 place-items-center rounded-md border border-white/25 text-white/70">{IconChart}</span>
            </div>
            <ImpliedVsRealizedCard implied={implied} impliedNow={focus.implied} realized={realized} />
          </div>
          <div className="glass flex flex-col p-6 lg:min-h-[440px] lg:[transform:rotateY(-12deg)_rotateZ(-1.5deg)_translateY(2.5rem)]">
            <SettlementsCard implied={focus.implied} />
          </div>
        </div>
      </div>
    </section>
  );
}
