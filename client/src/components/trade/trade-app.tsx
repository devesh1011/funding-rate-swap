"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { NearProvider, useNearWallet } from "near-connect-hooks";
import { LogoMark, Wordmark } from "@/components/logo";
import type { FundingPoint, Point } from "@/lib/data";
import { explorer, NETS, type Net } from "@/lib/config";
import { date, hourUtc, pct, usdCompact } from "@/lib/format";
import { rateToPct, shortName, swapReads, tickToPct, toNum, type MarketView } from "@/lib/swap";
import { NetSwitch } from "@/components/net-switch";
import type { LiveMarket } from "@/app/api/live/route";
import { OrderBook } from "./book";
import { ToastProvider, useNow, usePoll } from "./hooks";
import { FundsModal } from "./funds-modal";
import { AccountCard, type FundsMode } from "./margin";
import { Portfolio } from "./portfolio";
import { RateChart } from "./rate-chart";
import { OrderTicket } from "./ticket";
import { HedgeCalculator, type TicketPreset } from "./hedge";
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
    <section className={`rounded-lg border border-white/[0.07] bg-[#0f0f11] ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
          <h2 className="text-[0.8rem] font-medium text-white/85">{title}</h2>
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

  const [ticketTab, setTicketTab] = useState<"trade" | "hedge">("trade");
  // Each preset remounts the ticket with its side, size and kind.
  const [preset, setPreset] = useState<{ n: number; value: TicketPreset } | null>(null);
  const loadPreset = (value: TicketPreset) => {
    setPreset((p) => ({ n: (p?.n ?? 0) + 1, value }));
    setTicketTab("trade");
  };

  const [funds, setFunds] = useState<FundsMode | null>(null);
  const openFunds = (m: FundsMode) => (signedAccountId ? setFunds(m) : void signIn());
  const daysLeft = Math.max(0, Math.ceil((market.maturity_ts - nowSec) / 86_400));

  const strip: [string, ReactNode][] = [
    ["Mark APR", pct(rateToPct(market.mark))],
    ["Underlying APR (24h)", pct(realized24)],
    ["Notional OI", usdCompact(toNum(market.long_oi))],
    ["24h volume", `${Math.round(toNum(market.volume_24h)).toLocaleString("en-US")} YU`],
    ["Next settlement", clock === null ? "—" : countdown(3_600 - (Math.floor(clock / 1000) % 3_600))],
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-ink/90 backdrop-blur">
        <div className="flex items-center gap-4 px-4 py-3 lg:px-5">
          <Link href={c.base || "/"} className="flex items-center gap-2.5" aria-label="Fundswap home">
            <LogoMark className="size-7 text-lime" />
            <Wordmark className="hidden text-2xl leading-none sm:inline" />
          </Link>
          <nav className="ml-4 hidden items-center gap-7 text-[0.95rem] lg:flex">
            <span className="text-white">Trade</span>
            <Link href={`${c.base || "/"}#markets`} className="text-white/60 hover:text-white">Markets</Link>
            <Link href={`${c.base || "/"}#how-it-works`} className="text-white/60 hover:text-white">How it works</Link>
            <Link href="/docs" className="text-white/60 hover:text-white">Docs</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2.5">
            <div className="hidden md:block">
              <NetSwitch net={c.id} page="trade" />
            </div>
            <button onClick={() => openFunds("deposit")} className="hidden rounded-lg bg-lime px-5 py-2 text-sm font-medium text-ink hover:brightness-110 sm:block">
              Deposit
            </button>
            {signedAccountId ? (
              <button onClick={() => signOut()} title="Disconnect" className="rounded-lg border border-white/15 px-3.5 py-2 text-sm hover:border-lime/60">
                {signedAccountId.length > 20 ? `${signedAccountId.slice(0, 8)}…${signedAccountId.slice(-6)}` : signedAccountId}
              </button>
            ) : (
              <button onClick={() => signIn()} disabled={loading} className="rounded-lg border border-white/15 px-3.5 py-2 text-sm whitespace-nowrap hover:border-lime/60">
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 p-1.5">
        <div className="grid gap-1.5 xl:grid-cols-[minmax(0,1fr)_330px_370px]">
          {/* Market, stats and chart */}
          <div className="flex min-w-0 flex-col gap-1.5">
            <Panel>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
                <label className="relative flex items-center gap-2">
                  <span className="sr-only">Market</span>
                  <select
                    value={market.id}
                    onChange={(e) => setMarketId(Number(e.target.value))}
                    className="appearance-none bg-transparent pr-6 text-xl font-semibold tracking-tight outline-none"
                  >
                    {markets.map((m) => (
                      <option key={m.id} value={m.id} className="bg-ink text-base">
                        BTC funding · {shortName(m)}
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-0 text-white/50">▾</span>
                </label>
                <span className="rounded-md border border-white/12 px-2 py-0.5 text-xs text-white/70">Hyperliquid</span>
                <span className="border-l border-white/10 pl-6 text-xl font-semibold tracking-tight">
                  {daysLeft} days <span className="text-sm font-normal text-white/55">(Matures {date(market.maturity_ts)})</span>
                </span>
                <a href={explorer(c.id).account(c.swap)} target="_blank" rel="noreferrer" className="ml-auto text-xs text-white/45 hover:text-lime">
                  {c.swap} ↗
                </a>
              </div>
            </Panel>
            <Panel>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3.5">
                <div>
                  <div className="text-[1.75rem] leading-none font-semibold text-lime tnum">{pct(implied)}</div>
                  <div className="mt-1 text-xs text-lime/80">Implied APR</div>
                </div>
                {strip.map(([label, value]) => (
                  <div key={label}>
                    <div className="text-xs text-white/55 underline decoration-white/20 decoration-dotted underline-offset-4">{label}</div>
                    <div className="mt-1 text-[0.95rem] font-medium tnum">{value}</div>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel className="flex-1">
              <div className="p-4">
                <RateChart candles={live.data?.candles ?? []} mids={initial.implied[market.id] ?? []} realized={initial.realized} />
              </div>
            </Panel>
          </div>

          {/* Order book / market trades */}
          <Panel>
            <div className="grid grid-cols-2 border-b border-white/[0.07]">
              {(["book", "trades"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setBookTab(t)}
                  className={`py-3 text-sm ${bookTab === t ? "border-b-2 border-lime bg-white/[0.03] font-medium text-white" : "text-white/55 hover:text-white"}`}
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

          {/* Order ticket */}
          <Panel>
            <div className="grid grid-cols-2 border-b border-white/[0.07]">
              {(["trade", "hedge"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTicketTab(t)}
                  className={`py-3 text-sm ${ticketTab === t ? "border-b-2 border-lime bg-white/[0.03] font-medium text-white" : "text-white/55 hover:text-white"}`}
                >
                  {t === "trade" ? "Trade" : "Hedge a perp"}
                </button>
              ))}
            </div>
            <div className="p-4">
              {ticketTab === "hedge" ? (
                <HedgeCalculator market={market} account={account.data} book={book.data} hourly={initial.realized} now={nowSec} onLoad={loadPreset} />
              ) : (
                <OrderTicket
                  key={preset?.n ?? 0}
                  preset={preset?.value}
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
              )}
            </div>
          </Panel>

          {/* Positions, orders, history */}
          <Panel className="min-h-[320px] xl:col-span-2">
            <Portfolio account={account.data} markets={markets} trades={myTrades.data} hourly={initial.realized} settledTs={feed?.last_ts} onDone={refreshAll} />
          </Panel>

          {/* Margin account */}
          <Panel>
            <div className="p-4">
              <AccountCard
                account={account.data}
                walletBalance={wallet.data}
                connected={!!signedAccountId}
                onConnect={() => signIn()}
                onOpen={openFunds}
                onDone={refreshAll}
              />
            </div>
          </Panel>
        </div>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-2 text-xs text-white/55">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 rounded border border-lime/40 px-2 py-0.5 text-lime">
            <span className="live-dot size-1.5 rounded-full bg-lime" /> Online · {c.label}
          </span>
          <span>Oracle: {feed ? `last settled ${hourUtc(feed.last_ts)} UTC` : "—"}</span>
        </div>
        <div className="flex items-center gap-5">
          <Link href={c.base || "/"} className="hover:text-white">Home</Link>
          <Link href="/docs" className="hover:text-white">Docs</Link>
          <a href={explorer(c.id).account(c.swap)} target="_blank" rel="noreferrer" className="hover:text-white">Contract ↗</a>
        </div>
      </footer>

      {funds && signedAccountId && (
        <FundsModal
          mode={funds}
          onMode={setFunds}
          onClose={() => setFunds(null)}
          accountId={signedAccountId}
          account={account.data}
          walletBalance={wallet.data}
          onDone={refreshAll}
        />
      )}
    </div>
  );
}
