"use client";

import { useState } from "react";
import { OneClickToggle, useOneClick } from "./one-click";
import { pct, usd } from "@/lib/format";
import {
  estimateFill,
  initialMargin,
  liquidationRates,
  parseUsdc,
  pctToTick,
  rateToPct,
  takerFee,
  tickToPct,
  TGAS,
  type AccountView,
  type Kind,
  type Level,
  type MarketView,
  type Side,
} from "@/lib/swap";
import { useTx } from "./hooks";
import { useNet } from "./net";

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "Limit", label: "Limit", hint: "Fills what crosses, rests the rest" },
  { kind: "Ioc", label: "IOC", hint: "Fills what crosses now, cancels the rest" },
  { kind: "Market", label: "Market", hint: "Fills at any rate inside the market's band" },
];

export function OrderTicket({
  market,
  account,
  book,
  rate,
  onRate,
  now,
  connected,
  onConnect,
  onDone,
}: {
  market: MarketView;
  account: AccountView | null | undefined;
  /** Live book of this market, to estimate fills and slippage. */
  book: { bids: Level[]; asks: Level[] } | undefined;
  /** Rate input (APR %), owned by the page so a click in the book can set it. */
  rate: string;
  onRate: (v: string) => void;
  /** Unix seconds, from the latest data fetch. */
  now: number;
  connected: boolean;
  onConnect: () => void;
  onDone: () => void;
}) {
  const tx = useTx();
  const oneClick = useOneClick();
  const c = useNet();
  const [side, setSide] = useState<Side>("Long");
  const [kind, setKind] = useState<Kind>("Limit");
  // Sizes that fit the network: with mainnet's 10 USDC deposit cap, ~1,000 YU is the most margin allows.
  const sizes = c.depositCap === null ? ["1000", "10000", "50000", "100000"] : ["100", "250", "500", "1000"];
  const [size, setSize] = useState(sizes[1]);
  const [busy, setBusy] = useState(false);

  const sizeRaw = parseUsdc(size);
  const tick = kind === "Market" ? null : pctToTick(rate);
  const ratePct = tick === null ? rateToPct(market.mark) : tickToPct(tick);
  const im = sizeRaw ? initialMargin(market, sizeRaw, ratePct, now) : 0;
  const fee = sizeRaw ? takerFee(market, sizeRaw, now) : 0;
  const free = account ? Number(BigInt(account.health.withdrawable)) / 1e6 : 0;
  const sizeYu = sizeRaw ? Number(sizeRaw) / 1e6 : 0;
  // Market orders may fill anywhere inside the band; the matcher stops at the limit otherwise.
  const fill = estimateFill(side === "Long" ? (book?.asks ?? []) : (book?.bids ?? []), side, sizeYu, kind === "Market" ? null : tick);
  const dir = side === "Long" ? 1 : -1;
  // Position after the immediate fill (a resting limit also lands at its own rate if filled later).
  const restYu = kind === "Limit" ? sizeYu - fill.filled : 0;
  const liq =
    connected && sizeYu > 0
      ? liquidationRates(market, account, dir * (fill.filled + restYu), dir * (fill.fixedFlow + (restYu * ratePct) / 100), -(fee * fill.filled) / Math.max(sizeYu, 1), now)
      : null;
  const crosses = kind !== "Limit" || (tick !== null && (side === "Long" ? market.best_ask !== null && tick >= market.best_ask : market.best_bid !== null && tick <= market.best_bid));

  const problem = !connected
    ? null
    : market.effective_mode !== "Active"
      ? `Market is ${market.effective_mode === "CloseOnly" ? "close-only (oracle stale)" : "paused"}`
      : !account
        ? "Deposit margin first"
        : !account.storage_paid
          ? "Activate your account first (0.1 NEAR storage)"
          : !sizeRaw || sizeRaw <= 0n
            ? "Enter a size"
            : kind !== "Market" && tick === null
              ? "Rate must be a percent with ≤ 2 decimals"
              : im + (crosses ? fee : 0) > free
                ? `Needs ~${usd(im + (crosses ? fee : 0))} free margin, you have ${usd(free)}`
                : null;

  async function submit() {
    if (!sizeRaw) return;
    setBusy(true);
    const r = await tx<{ filled: string; order_id: string | null }>(
      `${side === "Long" ? "Long" : "Short"} ${size} YU ${kind === "Market" ? "at market" : `@ ${pct(ratePct)}`}`,
      [
        {
          receiverId: c.swap,
          method: "place_order",
          args: { market_id: market.id, side, size: sizeRaw.toString(), tick: tick ?? 0, kind },
          gas: TGAS(200),
          deposit: "0",
        },
      ],
    );
    setBusy(false);
    if (r.ok) onDone();
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        {(["Long", "Short"] as Side[]).map((s) => {
          const on = side === s;
          return (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`rounded-lg border px-3 py-2.5 text-left transition ${
                on ? (s === "Long" ? "border-lime bg-lime/10" : "border-white/70 bg-white/10") : "border-white/10 hover:border-white/25"
              }`}
            >
              <div className={`text-[0.95rem] font-semibold ${on ? (s === "Long" ? "text-lime" : "text-white") : "text-white/75"}`}>
                {s === "Long" ? "Long YU ↗" : "Short YU ↘"}
              </div>
              <div className="mt-0.5 text-[0.7rem] text-white/55">{s === "Long" ? "Pay fixed, rcv. underlying" : "Pay underlying, rcv. fixed"}</div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex gap-5 border-b border-white/10">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            onClick={() => setKind(k.kind)}
            title={k.hint}
            className={`-mb-px border-b-2 pb-2 text-xs tracking-[0.06em] uppercase ${
 kind === k.kind ? "border-lime text-lime" : "border-transparent text-white/60 hover:text-white"
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <label className="mt-4 block">
        <span className="label text-[0.6rem] text-white/60">Fixed rate (APR %)</span>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/12 bg-white/[0.03] px-3 focus-within:border-lime/60">
          <input
            value={kind === "Market" ? "market" : rate}
            disabled={kind === "Market"}
            onChange={(e) => onRate(e.target.value)}
            inputMode="decimal"
            className="w-full bg-transparent py-2.5 text-lg tnum outline-none disabled:text-white/40"
          />
          <span className="text-white/50">%</span>
        </div>
      </label>
      {kind !== "Market" && (
        <div className="mt-2 flex gap-2 text-[0.68rem]">
          {[
            ["Bid", market.best_bid],
            ["Ask", market.best_ask],
          ].map(([l, t]) =>
            t !== null ? (
              <button key={l as string} onClick={() => onRate(tickToPct(t as number).toFixed(2))} className="rounded-md border border-white/10 px-2 py-1 text-white/70 hover:border-lime/50 hover:text-lime">
                {l} {pct(tickToPct(t as number))}
              </button>
            ) : null,
          )}
        </div>
      )}

      <label className="mt-4 block">
        <span className="label text-[0.6rem] text-white/60">Size (YU · $1 notional each)</span>
        <div className="mt-1.5 flex items-center rounded-xl border border-white/12 bg-white/[0.03] px-3 focus-within:border-lime/60">
          <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" className="w-full bg-transparent py-2.5 text-lg tnum outline-none" />
          <span className="text-white/50">YU</span>
        </div>
      </label>
      <div className="mt-2 flex gap-2 text-[0.68rem]">
        {sizes.map((v) => (
          <button key={v} onClick={() => setSize(v)} className="rounded-md border border-white/10 px-2 py-1 text-white/70 hover:border-lime/50 hover:text-lime">
            {Number(v) >= 1000 ? `${Number(v) / 1000}k` : v}
          </button>
        ))}
      </div>

      <dl className="mt-5 space-y-2 text-[0.8rem] tnum">
        <div className="flex justify-between"><dt className="text-white/60">Initial margin</dt><dd>{usd(im)}</dd></div>
        <div className="flex justify-between"><dt className="text-white/60">Taker fee {crosses ? "" : "(if it crosses)"}</dt><dd>{usd(fee)}</dd></div>
        <div className="flex justify-between">
          <dt className="text-white/60">Fills now</dt>
          <dd>{fill.filled ? `${Math.round(fill.filled).toLocaleString("en-US")} YU @ ${pct(fill.avgPct!)}` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-white/60">Slippage</dt>
          <dd>{fill.filled ? `${pct(fill.slippagePct)}${fill.filled < sizeYu && kind !== "Limit" ? " · rest unfilled" : ""}` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-white/60">Liquidation rate</dt>
          <dd>
            {!liq ? "—" : liq.below !== null && liq.below === liq.above ? "Immediately: not enough margin" : [liq.below !== null ? `< ${pct(liq.below)}` : null, liq.above !== null ? `> ${pct(liq.above)}` : null].filter(Boolean).join(" or ") || "none within ±200%"}
          </dd>
        </div>
        <div className="flex justify-between"><dt className="text-white/60">Free margin</dt><dd>{connected ? usd(free) : "—"}</dd></div>
        <div className="flex justify-between">
          <dt className="text-white/60">Fixed leg</dt>
          <dd>{sizeRaw ? `${usd((Number(sizeRaw) / 1e6) * (ratePct / 100) / 365)}/day` : "—"}</dd>
        </div>
      </dl>

      {connected ? (
        <button
          disabled={!!problem || busy}
          onClick={submit}
          className={`mt-5 w-full rounded-lg py-3.5 font-medium text-ink ${side === "Long" ? "bg-lime" : "bg-white"} disabled:cursor-not-allowed disabled:opacity-40`}
        >
          {busy ? (oneClick.on ? "Sending…" : "Confirm in wallet…") : `${side === "Long" ? "Long" : "Short"} ${size || 0} YU`}
        </button>
      ) : (
        <button onClick={onConnect} className="mt-5 w-full rounded-lg bg-lime py-3.5 font-medium text-ink">
          Connect wallet
        </button>
      )}
      {problem && <p className="mt-2 text-[0.7rem] text-white/55">{problem}</p>}
      {connected && <OneClickToggle />}
    </div>
  );
}
