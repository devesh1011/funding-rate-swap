import Link from "next/link";
import type { ReactNode } from "react";
import { getDepositQuote } from "@/lib/data";

const CHAINS: { name: string; icon: ReactNode }[] = [
  {
    name: "Base",
    icon: (
      <svg viewBox="0 0 32 32" className="size-10">
        <circle cx="16" cy="16" r="16" fill="#0052ff" />
        <path d="M16 6a10 10 0 1 1-9.95 11h13.2v-2H6.05A10 10 0 0 1 16 6z" fill="#fff" />
      </svg>
    ),
  },
  {
    name: "Arbitrum",
    icon: (
      <svg viewBox="0 0 32 32" className="size-10">
        <path d="M16 1.5 29 9v14l-13 7.5L3 23V9z" fill="#213147" stroke="#9dcced" strokeWidth="1.2" />
        <path d="m11 22 6.5-12h2.5l-6.5 12zm5 0 6.5-12H25l-6.5 12z" fill="#12aaff" />
        <path d="m8 22 6.5-12h2.5L10.5 22z" fill="#fff" />
      </svg>
    ),
  },
  {
    name: "Ethereum",
    icon: (
      <svg viewBox="0 0 32 32" className="size-10">
        <path d="M16 2 7.5 16.3 16 21.2l8.5-4.9z" fill="#a7a9d6" />
        <path d="M16 2v19.2l8.5-4.9z" fill="#6c70b8" />
        <path d="M16 23 7.5 18.1 16 30l8.5-11.9z" fill="#8b8ec9" />
      </svg>
    ),
  },
  {
    name: "Solana",
    icon: (
      <svg viewBox="0 0 32 32" className="size-10">
        <defs>
          <linearGradient id="sol" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="1" stopColor="#14f195" />
          </linearGradient>
        </defs>
        <path d="M8 22h18l-3 3H5zM8 14.5h18l-3 3H5zM11 7h18l-3 3H8z" fill="url(#sol)" />
      </svg>
    ),
  },
  {
    name: "NEAR",
    icon: (
      <svg viewBox="0 0 32 32" className="size-10">
        <path d="M22.5 5.5 18 12.2c-.3.5.3 1 .7.6l4.4-3.8c.1-.1.3 0 .3.2v12.1c0 .2-.2.3-.4.1L9.7 5.9A1.4 1.4 0 0 0 8.6 5.5h-.5A2.1 2.1 0 0 0 6 7.6v16.8a2.1 2.1 0 0 0 3.9 1.1l4.5-6.7c.3-.5-.3-1-.7-.6l-4.4 3.8c-.1.1-.3 0-.3-.2V9.8c0-.2.2-.3.4-.1L22.3 26.1c.3.3.7.4 1.1.4h.5a2.1 2.1 0 0 0 2.1-2.1V7.6a2.1 2.1 0 0 0-3.5-2.1z" fill="#fff" />
      </svg>
    ),
  },
];

const Row = ({ icon, label, value }: { icon: ReactNode; label: string; value: string }) => (
  <div className="flex items-center gap-4 border-t border-white/10 py-4">
    <span className="grid size-9 place-items-center rounded-full border border-lime text-lime">{icon}</span>
    <span className="label flex-1 text-[0.8rem]">{label}</span>
    <span className="text-base tnum">{value}</span>
  </div>
);

export async function AnyChain() {
  const q = await getDepositQuote();
  const ROW_H = 92; // pill pitch in px, used to draw the connectors
  return (
    <section className="relative overflow-hidden py-28">
      <div className="rays rays-fade" />
      <div className="relative mx-auto grid max-w-[1500px] items-center gap-16 px-6 lg:grid-cols-[1fr_1.25fr] lg:px-10">
        <div>
          <h2 className="font-normal tracking-[-0.045em] text-[clamp(3rem,5.5vw,6rem)] leading-[0.95]">
            Margin from
            <br />
            <span className="accent text-lime">any</span> chain.
          </h2>
          <p className="mt-8 text-xl leading-9 text-white/85">
            One-step deposits via NEAR Intents.
            <br />
            No bridging tabs.
          </p>
        </div>

        <div className="grid items-center gap-8 md:grid-cols-[auto_70px_1fr]">
          <div className="flex flex-col gap-6">
            {CHAINS.map((c) => (
              <div key={c.name} className="flex h-[68px] items-center gap-5 rounded-full border border-lime/30 bg-white/[0.03] pr-12 pl-4">
                {c.icon}
                <span className="label text-base tracking-[0.1em]">{c.name}</span>
              </div>
            ))}
          </div>
          <svg viewBox={`0 0 70 ${ROW_H * 5}`} className="hidden h-full w-full md:block" preserveAspectRatio="none" aria-hidden>
            {CHAINS.map((c, i) => {
              const y = ROW_H * i + ROW_H / 2 - 12;
              const mid = (ROW_H * 5) / 2 - 12;
              return (
                <path
                  key={c.name}
                  d={`M0 ${y} H28 Q36 ${y} 36 ${y + (mid > y ? 8 : -8)} V${mid + (mid > y ? -8 : 8)} Q36 ${mid} 44 ${mid} H64`}
                  fill="none"
                  stroke="#c6f432"
                  strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke"
                  style={{ filter: "drop-shadow(0 0 4px rgb(198 244 50 / 0.8))" }}
                />
              );
            })}
            <path d={`M58 ${(ROW_H * 5) / 2 - 18} l8 6 -8 6`} fill="none" stroke="#c6f432" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="glass p-7">
            <div className="text-center">
              <div className="text-lg">
                From <span className="text-2xl">{q.amountIn.toFixed(2)} USDC</span> <span className="text-white/70">· {q.from}</span>
              </div>
              <div className="my-1 text-lime">↓</div>
              <div className="text-3xl font-semibold tracking-tight whitespace-nowrap">
                Margin <span className="text-lime tnum">+{q.amountOut.toFixed(4)} USDC</span>
              </div>
            </div>
            <div className="mt-6">
              <Row icon={<span className="text-sm">✦</span>} label="Route" value="NEAR Intents 1Click" />
              <Row icon={<span className="text-sm">◷</span>} label="ETA" value={`~${q.etaSecs}s`} />
              <Row icon={<span className="text-sm">%</span>} label="Fee" value={`${q.feePct.toFixed(2)}%`} />
            </div>
            <Link href="/trade" className="pill pill-lime mt-4 w-full py-4 tracking-[0.1em]">
              DEPOSIT
            </Link>
            <p className="mt-4 text-center text-[0.65rem] text-white/50">Live 1Click quote · refreshed every minute</p>
          </div>
        </div>
      </div>
    </section>
  );
}
