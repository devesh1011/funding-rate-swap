"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { LogoMark, Wordmark } from "@/components/logo";
import type { FundingPoint, Point } from "@/lib/data";
import { explorer, NETS, type Net } from "@/lib/config";
import { hourUtc, pct, usdCompact } from "@/lib/format";
import { rateToPct, shortName, swapReads, tickToPct, toNum, type MarketView } from "@/lib/swap";
import { NetSwitch } from "@/components/net-switch";
import type { LiveMarket } from "@/app/api/live/route";
import { OrderBook } from "./book";
import { ToastProvider, useNow, usePoll } from "./hooks";
import { MarginPanel } from "./margin";
import { Portfolio } from "./portfolio";
import { RateChart } from "./rate-chart";
import { OrderTicket } from "./ticket";
import { MarketTrades } from "./trades";
import { NetProvider, useNet } from "./net";

export interface TradeInitial {
  /** Server time of the snapshot, ms. */
  now: number;
  markets: MarketView[];
  realized: FundingPoint[];
  implied: Record<number, Point[]>;
}

export function TradeApp({ initial, net }: { initial: TradeInitial; net: Net }) {
  return (
    <NetProvider value={NETS[net]}>
      <NearProvider config={{ network: net }}>
        <ToastProvider>
          <Trade initial={initial} />
        </ToastProvider>
      </NearProvider>
    </NetProvider>
  );
}

function Panel({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass !rounded-[18px] !shadow-[0_0_30px_rgb(198_244_50/0.06)] ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-white/8 px-4 py-3">
          <h2 className="label text-[0.68rem]">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function countdown(secs: number) {
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

function maturesIn(ts: number, nowSec: number) {
  const s = ts - nowSec;
  if (s <= 0) return "matured";
  const d = Math.floor(s / 86_400);
  return `${d}d ${Math.floor((s % 86_400) / 3_600)}h`;
}

function Trade({ initial }: { initial: TradeInitial }) {
  const { signedAccountId, signIn, signOut, loading } = useNearWallet();
  const c = useNet();
  const swap = useMemo(() => swapReads(c), [c]);
  const [marketId, setMarketId] = useState(() => initial.markets.reduce((a, b) => (b.maturity_ts > a.maturity_ts ? b : a)).id);
  // One shared, server-memoised snapshot of the market (see /api/live).
  const live = usePoll(
    () =>
      fetch(`/api/live?market=${marketId}&net=${c.id}`).then(async (r) => {
        if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `live ${r.status}`);
        return (await r.json()) as LiveMarket;
      }),
    3_000,
    [marketId, c.id],
  );
  const markets = live.data?.markets ?? initial.markets;
  const nowSec = Math.floor((live.data?.now ?? initial.now) / 1000);
  const feeds = live.data?.feeds;
  const market = markets.find((m) => m.id === marketId) ?? markets[0];
  const book = { data: live.data?.book, refresh: live.refresh };
  const account = usePoll(() => (signedAccountId ? swap.account(signedAccountId) : Promise.resolve(null)), 5_000, [signedAccountId, c.id]);
  const wallet = usePoll(
    () => (signedAccountId ? swap.tokenBalance(signedAccountId).then(BigInt) : Promise.resolve(undefined)),
    15_000,
    [signedAccountId, c.id],
  );
  // Ticket rate: the user's input for this market, else the best ask (a long lifts it) or the mark.
  const myTrades = usePoll(() => (signedAccountId ? swap.accountTrades(signedAccountId) : Promise.resolve(undefined)), 10_000, [signedAccountId, c.id]);
  const clock = useNow();
  const [bookTab, setBookTab] = useState<"book" | "trades">("book");
  const [rateInput, setRateInput] = useState<{ marketId: number; value: string } | null>(null);
  const refreshAll = () => {
    void book.refresh();
    void account.refresh();
    void wallet.refresh();
    void myTrades.refresh();
  };

  const mine = useMemo(
    () => new Set((account.data?.orders ?? []).filter((o) => o.market_id === market.id).map((o) => o.tick)),
    [account.data, market.id],
  );
  const bid = market.best_bid;
  const ask = market.best_ask;
  const implied = bid !== null && ask !== null ? tickToPct((bid + ask) / 2) : rateToPct(market.mark);
  const last24 = initial.realized.slice(-24);
  const realized24 = last24.reduce((s, p) => s + p.apr, 0) / Math.max(1, last24.length);
  const feed = feeds?.find((f) => f.id === market.feed_id);
  const ticketRate =
    rateInput?.marketId === market.id ? rateInput.value : (ask !== null ? tickToPct(ask) : rateToPct(market.mark)).toFixed(2);
  const setTicketRate = (value: string) => setRateInput({ marketId: market.id, value });

  const strip: [string, ReactNode][] = [
    ["Implied (mid)", <span key="i" className="text-lime">{pct(implied)}</span>],
    ["Mark", pct(rateToPct(market.mark))],
    ["Bid / ask", `${bid === null ? "—" : pct(tickToPct(bid))} / ${ask === null ? "—" : pct(tickToPct(ask))}`],
    ["Realized 24h", pct(realized24)],
    ["Open interest", usdCompact(toNum(market.long_oi))],
    ["24h volume", `${Math.round(toNum(market.volume_24h)).toLocaleString("en-US")} YU`],
    ["Next settlement", clock === null ? "—" : countdown(3_600 - (Math.floor(clock / 1000) % 3_600))],
    ["Last settled", feed ? `${hourUtc(feed.last_ts)} UTC` : "—"],
    ["Matures", maturesIn(market.maturity_ts, nowSec)],
  ];

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-ink/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-4 py-3 sm:gap-6 lg:px-6">
          <Link href={c.base || "/"} className="flex items-center gap-2.5" aria-label="Fundswap home">
            <LogoMark className="size-7 text-lime" />
            <Wordmark className="hidden text-2xl leading-none sm:inline" />
          </Link>
          <nav className="flex min-w-0 gap-1 overflow-x-auto">
            {markets.map((m) => (
              <button
                key={m.id}
                onClick={() => setMarketId(m.id)}
                className={`rounded-full px-4 py-1.5 text-xs whitespace-nowrap ${m.id === market.id ? "bg-lime text-ink" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
              >
                BTC · {shortName(m)}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:block">
              <NetSwitch net={c.id} page="trade" />
            </div>
            {signedAccountId ? (
              <button onClick={() => signOut()} title="Disconnect" className="pill border border-white/20 px-4 py-2 text-xs hover:border-lime/60">
                {signedAccountId.length > 22 ? `${signedAccountId.slice(0, 10)}…${signedAccountId.slice(-8)}` : signedAccountId}
              </button>
            ) : (
              <button onClick={() => signIn()} disabled={loading} className="pill pill-lime px-5 py-2 text-sm whitespace-nowrap">
                <span className="sm:hidden">Connect</span>
                <span className="hidden sm:inline">Connect wallet</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1800px] px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3 px-1 pb-4">
          <div>
            <h1 className="text-[1.65rem] leading-none font-semibold tracking-tight">
              BTC funding <span className="text-lime">· {shortName(market)}</span>
            </h1>
            <a href={explorer(c.id).account(c.swap)} target="_blank" rel="noreferrer" className="mt-1 block text-[0.65rem] text-white/45 hover:text-lime">
              {market.effective_mode === "Active" ? "Active" : market.effective_mode} · Hyperliquid BTC hourly funding · {c.label} · {c.swap} ↗
            </a>
          </div>
          {strip.map(([label, value]) => (
            <div key={label}>
              <div className="label text-[0.55rem] text-white/50">{label}</div>
              <div className="mt-1 text-[0.95rem] font-medium tnum">{value}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel title="Implied vs underlying">
              <div className="p-4">
                <RateChart candles={live.data?.candles ?? []} mids={initial.implied[market.id] ?? []} realized={initial.realized} />
              </div>
            </Panel>
            <Panel className="hidden xl:block">
              <Portfolio account={account.data} markets={markets} trades={myTrades.data} onDone={refreshAll} />
            </Panel>
          </div>

          <Panel>
            <div className="grid grid-cols-2 border-b border-white/8">
              {(["book", "trades"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setBookTab(t)}
                  className={`label py-3 text-[0.68rem] ${bookTab === t ? "bg-white/[0.04] text-lime" : "text-white/55 hover:text-white"}`}
                >
                  {t === "book" ? "Order book" : "Market trades"}
                </button>
              ))}
            </div>
            <div className="py-3">
              {bookTab === "book" ? (
                <OrderBook loading={!book.data} bids={book.data?.bids ?? []} asks={book.data?.asks ?? []} mine={mine} onPick={(tick) => setTicketRate(tickToPct(tick).toFixed(2))} />
              ) : (
                <MarketTrades trades={live.data?.trades} />
              )}
            </div>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel title="Trade">
              <div className="p-4">
                <OrderTicket
                  market={market}
                  account={account.data}
                  book={book.data}
                  rate={ticketRate}
                  onRate={setTicketRate}
                  now={nowSec}
                  connected={!!signedAccountId}
                  onConnect={() => signIn()}
                  onDone={refreshAll}
                />
              </div>
            </Panel>
            <Panel title="Margin" right={<span className="label text-[0.55rem] text-white/40">{c.symbol}</span>}>
              <div className="p-4">
                {signedAccountId ? (
                  <MarginPanel accountId={signedAccountId} account={account.data} walletBalance={wallet.data} onDone={refreshAll} />
                ) : (
                  <p className="text-sm leading-6 text-white/55">
                    {c.faucet
                      ? "Connect a NEAR testnet wallet (a .testnet account). You can mint 10,000 test tUSDC here, deposit it as margin, and trade against the live book."
                      : `Connect a NEAR mainnet wallet. Margin is native USDC on NEAR, capped at ${c.depositCap} USDC per account while in beta. To try it free, switch to Testnet.`}
                  </p>
                )}
              </div>
            </Panel>
          </div>

          <Panel className="xl:hidden">
            <Portfolio account={account.data} markets={markets} trades={myTrades.data} onDone={refreshAll} />
          </Panel>
        </div>
      </main>
    </div>
  );
}
