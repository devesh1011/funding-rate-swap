import type { ReactNode } from "react";
import { explorer, SWAP_CONTRACT } from "@/lib/chain";
import { getOracle, getRealizedFunding } from "@/lib/data";
import { hourUtc, shortHash, timeUtc } from "@/lib/format";

const Key = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 48" className={`h-20 ${on ? "text-lime drop-shadow-[0_0_8px_rgb(198_244_50/0.8)]" : "text-white/40"}`} fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="12" cy="11" r="9" />
    <circle cx="12" cy="9" r="2.5" />
    <path d="M9 20v22l3 3 3-3v-4l-2-2 2-2v-3l-2-2 2-2V20" />
  </svg>
);

function Card({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="glass !border-lime/25 flex min-h-[330px] flex-col p-8">
      <div className="font-mono text-lime">{n}</div>
      <div className="label mt-3 text-[0.8rem]">{title}</div>
      <div className="my-5 h-px bg-white/12" />
      {children}
    </div>
  );
}

export async function Trust() {
  const [oracle, realized] = await Promise.all([getOracle(), getRealizedFunding(48)]);
  const lastRate = realized.find((p) => p.ts === oracle.lastIntervalTs);
  const liq = oracle.lastLiquidation;

  return (
    <section id="oracle" className="relative overflow-hidden py-28">
      <div className="rays rays-fade rays-soft" />
      <div className="relative mx-auto max-w-[1500px] px-6 lg:px-10">
        <h2 className="text-center font-serif text-[clamp(3.2rem,7vw,7.5rem)] leading-none">
          Verifiable, <em className="text-lime">not</em> trusted.
        </h2>
        <p className="mx-auto mt-6 max-w-[70ch] text-center font-mono text-sm leading-7 text-white/70">
          The contract enforces quorum, order, the cap and no rewrites. In this testnet build our team runs all three signers, and every
          rate can be recomputed from Hyperliquid&apos;s public funding history.
        </p>
        <div className="mt-14 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <Card n="01" title="Signers">
            <div className="font-serif text-3xl">
              {oracle.threshold}-of-{oracle.signers.length} ed25519 signers
            </div>
            <div className="mt-auto flex justify-around pt-6">
              {oracle.signers.map((s) => (
                <Key key={s} on />
              ))}
            </div>
            <div className="label mt-4 text-center text-[0.6rem] text-white/60">Any {oracle.threshold} must agree</div>
          </Card>
          <Card n="02" title="Rate update">
            <div className="font-serif text-3xl">Last interval</div>
            <div className="mt-2 font-serif text-2xl text-white/90 tnum">
              {hourUtc(oracle.lastIntervalTs)} UTC · {lastRate ? `${lastRate.hourly < 0 ? "−" : ""}${Math.abs(lastRate.hourly).toFixed(10)}` : "—"} /h
            </div>
            {oracle.lastSubmit && (
              <a
                href={explorer.tx(oracle.lastSubmit.hash)}
                target="_blank"
                rel="noreferrer"
                className="mt-auto flex items-center justify-center gap-4 rounded-lg border border-white/15 py-4 font-mono text-lg tracking-[0.12em] text-lime hover:border-lime/50"
              >
                {shortHash(oracle.lastSubmit.hash)} <span>↗</span>
              </a>
            )}
          </Card>
          <Card n="03" title="Rate cap">
            <div className="font-serif text-3xl leading-snug">
              Capped at
              <br />
              Hyperliquid&apos;s {oracle.clampPerHour}%/h
            </div>
          </Card>
          <Card n="04" title="Liquidations">
            <div className="font-serif text-3xl leading-snug">
              Liquidations by
              <br />
              open keeper
            </div>
            {liq && (
              <a
                href={explorer.tx(liq.hash)}
                target="_blank"
                rel="noreferrer"
                className="mt-auto block rounded-lg border border-lime/30 px-3 py-3 font-mono text-[0.68rem] leading-5 text-lime hover:border-lime/60"
              >
                {timeUtc(liq.ts)} liquidate {liq.account_id} market={liq.market_id}
              </a>
            )}
          </Card>
        </div>
        <div className="mt-14 flex flex-wrap justify-center gap-6">
          <a href={explorer.account(SWAP_CONTRACT)} target="_blank" rel="noreferrer" className="pill pill-lime min-w-72 py-4 font-mono tracking-[0.25em]">
            CONTRACT <span>↗</span>
          </a>
          {liq && (
            <a href={explorer.tx(liq.hash)} target="_blank" rel="noreferrer" className="pill pill-ghost min-w-72 py-4 font-mono tracking-[0.25em] text-lime">
              LIQUIDATION DEMO <span>↗</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
