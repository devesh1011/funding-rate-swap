import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Closing } from "@/components/landing/closing";
import { Nav } from "@/components/landing/hero";
import { explorer, NETS } from "@/lib/config";

export const metadata: Metadata = {
  title: "Docs · Fundswap",
  description: "How Fundswap works: yield units, the order book, margin, hourly settlement, the oracle, liquidation, NEAR Intents and the contract API.",
};

const SECTIONS = [
  ["overview", "Overview"],
  ["instrument", "Yield units"],
  ["trading", "Orders and the mark"],
  ["margin", "Margin"],
  ["settlement", "Settlement and oracle"],
  ["liquidation", "Liquidation"],
  ["funds", "Deposits and withdrawals"],
  ["contract", "Contract API"],
  ["deployments", "Deployments"],
  ["trust", "Trust model"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-white/10 pt-12 pb-4 first:border-t-0 first:pt-0">
      <h2 className="text-[clamp(1.75rem,3vw,2.4rem)] leading-tight font-medium tracking-[-0.02em]">{title}</h2>
      <div className="mt-6 space-y-5 text-[1.02rem] leading-7 text-white/75">{children}</div>
    </section>
  );
}

const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono [overflow-wrap:anywhere] text-[0.86em] text-white">{children}</code>;

function Formula({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="glass-quiet overflow-x-auto px-5 py-4">
      <div className="font-mono text-[0.95rem] whitespace-nowrap text-lime">{children}</div>
      {note && <div className="mt-2 text-sm text-white/55">{note}</div>}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="glass-quiet overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-[0.92rem]">
        <thead>
          <tr className="border-b border-white/10">
            {head.map((h) => (
              <th key={h} className="label px-4 py-3 font-normal text-white/50">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-white/[0.06] align-top last:border-0">
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-3 ${j === 0 ? "whitespace-nowrap text-white" : "text-white/70"}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Acct({ net, id }: { net: "mainnet" | "testnet"; id: string }) {
  return (
    <a href={explorer(net).account(id)} target="_blank" rel="noreferrer" className="font-mono text-[0.86em] break-all text-white hover:text-lime">
      {id}
    </a>
  );
}

export default function Docs() {
  const main = NETS.mainnet;
  const test = NETS.testnet;
  return (
    <>
      <Nav net="mainnet" />
      <main className="mx-auto grid w-full max-w-[1500px] gap-12 px-6 pt-10 pb-24 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-20 lg:px-10">
        <aside className="hidden lg:block">
          <nav aria-label="Contents" className="sticky top-8">
            <div className="label text-white/45">Contents</div>
            <ul className="mt-4 space-y-2.5 text-[0.95rem]">
              {SECTIONS.map(([id, title]) => (
                <li key={id}>
                  <a href={`#${id}`} className="text-white/65 hover:text-lime">
                    {title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <article className="max-w-[46rem] min-w-0 space-y-12">
          <header>
            <div className="label text-lime">Documentation</div>
            <h1 className="mt-4 text-[clamp(2.6rem,6vw,4.5rem)] leading-[1.02] font-normal tracking-[-0.04em]">
              How Fundswap <span className="accent text-lime">works</span>
            </h1>
            <p className="mt-6 text-lg leading-8 text-white/70">
              Fundswap is a fixed-for-floating swap on Hyperliquid BTC perpetual funding, settled hourly by a NEAR contract. This page describes the contract as deployed. Every number
              here comes from its source in{" "}
              <a href="https://github.com/devesh1011/funding-rate-swap/tree/main/contracts/rate-swap" className="text-lime hover:underline">
                contracts/rate-swap
              </a>
              .
            </p>
          </header>

          <Section id="overview" title="Overview">
            <p>
              Perp funding is the biggest yield in crypto and the least stable one: Hyperliquid BTC funding swings from double-digit APR to negative within hours. Fundswap lets
              you lock that rate in, or take a view on it, without any exposure to the BTC price.
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>One contract holds an on-chain order book, cross margin in one stablecoin, and the positions.</li>
              <li>An oracle bot posts each hourly Hyperliquid funding rate, signed by 2 of 3 keys. Positions settle against it lazily, on their next touch.</li>
              <li>A keeper bot liquidates accounts that fall below maintenance. A maker bot quotes on testnet.</li>
              <li>Collateral can arrive from any chain in one step through NEAR Intents, and leave the same way.</li>
            </ul>
          </Section>

          <Section id="instrument" title="Yield units">
            <p>
              A market is one feed (Hyperliquid BTC funding) and one maturity. The traded unit is the <b className="text-white">yield unit (YU)</b>: the funding paid on 1 USDC of
              notional from now until maturity.
            </p>
            <Table
              head={["Side", "Pays", "Receives", "Profits when"]}
              rows={[
                ["Long YU", "the fixed APR of the fill", "floating hourly funding", "funding comes in above the fixed rate"],
                ["Short YU", "floating hourly funding", "the fixed APR of the fill", "funding comes in below it (a basis trader locking in carry)"],
              ]}
            />
            <p>Each hour, a position with signed notional N (positive for long) is paid the floating leg minus its locked fixed leg:</p>
            <Formula note="Example: long 100,000 YU at 10 %, one hour of 0.00125 % funding → receives $1.25, pays 100,000 × 10 % / 8,760 = $1.14, net +$0.108.">
              owed = N × Δindex − Σ(size × fixed rate) × Δt / year
            </Formula>
            <p>
              Before maturity, a position is valued at the market&apos;s mark rate for the time left. A long at 10 % with 6 days left is worth 100,000 × (12 % − 10 %) × 6/365 =
              $32.88 if the mark moves to 12 %.
            </p>
          </Section>

          <Section id="trading" title="Orders and the mark">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Prices are implied APRs on a tick grid of <b className="text-white">1 basis point</b>. Bids pay fixed (long), asks receive fixed (short).
              </li>
              <li>
                Order kinds: <C>Limit</C> rests whatever does not fill, <C>Ioc</C> fills what crosses and drops the rest, and <C>Market</C> is IOC at the edge of the rate band.
              </li>
              <li>Fills are price-time priority against resting orders. Every fill is written to an on-chain trade log, and hourly candles are kept for the chart.</li>
              <li>
                Rates must sit within a band of <b className="text-white">±50 % APR</b> around the mark, so one order cannot push the mark anywhere.
              </li>
              <li>
                The taker pays a fee of <b className="text-white">0.1 % APR</b> on the notional for the time left, paid into the insurance fund. Makers pay nothing.
              </li>
              <li>
                <b className="text-white">1-click trading:</b> your wallet can add a NEAR function-call access key that may only call <C>place_order</C>, <C>cancel_order</C> and{" "}
                <C>cancel_all</C> on the contract, with a 0.5 NEAR gas allowance. The app signs orders with it, so trading needs no wallet prompt. It cannot withdraw: NEAR rejects
                any deposit from a function-call key, and <C>withdraw</C> requires 1 yoctoNEAR. Turning it off deletes the key from your account.
              </li>
            </ul>
            <p>The mark rate is a time-weighted EMA of trade rates, with a 15-minute window:</p>
            <Formula>mark ← mark + (trade rate − mark) × min(elapsed, 15 min) / 15 min</Formula>
            <p>
              When the feed has gone 3 hours without a rate, or governance sets it, a market becomes <C>CloseOnly</C>: only orders that shrink a position are accepted. A{" "}
              <C>Paused</C> market stops trading and liquidation, but cancels, settlement and withdrawals still work.
            </p>
          </Section>

          <Section id="margin" title="Margin">
            <p>
              Margin is cross: one cash balance in the collateral token backs every position in every market. The account&apos;s net balance is its cash plus the value of all
              positions at mark.
            </p>
            <Formula note="IMf = 3. Floors: 5 % APR and 1 day. Example: 100,000 YU at 10 % with 7 days left → 3 × 100,000 × 10 % × 7/365 = $575.34.">
              IM = IMf × |N| × max(|rate|, 5 %) × max(τ, 1 day) / year
            </Formula>
            <ul className="list-disc space-y-2 pl-5">
              <li>An order is accepted only if the account still covers initial margin (IM) afterwards.</li>
              <li>
                Maintenance margin is <b className="text-white">0.66 × IM</b>, computed at the mark. Below it, the account can be liquidated.
              </li>
              <li>
                Margin scales with <i>|rate|</i>, so a rate moving sharply in either direction raises the requirement. A long can be liquidated by a rate spike as well as by a drop.
              </li>
              <li>Withdrawable cash is whatever keeps the account above IM.</li>
            </ul>
          </Section>

          <Section id="settlement" title="Settlement and oracle">
            <p>
              Each feed keeps a cumulative funding index. Every hour the oracle bot reads Hyperliquid&apos;s <C>fundingHistory</C> for BTC and calls <C>submit_rates</C> with the
              interval&apos;s rate. The contract accepts the rate only if:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                at least <b className="text-white">2 of the 3</b> configured ed25519 signers have signed it;
              </li>
              <li>the interval is exactly the next one, with no gaps and not in the future;</li>
              <li>
                the rate is within the clamp of <b className="text-white">4 % per hour</b>, which is Hyperliquid&apos;s own cap.
              </li>
            </ul>
            <p>Each signature covers this borsh-encoded tuple, so it cannot be replayed to another contract, feed or hour:</p>
            <Formula note={<>Return the exact bytes with the view <C>get_rate_message</C>.</>}>(&quot;fundswap-rate-v1&quot;, contract_id, feed_id, interval_ts, rate)</Formula>
            <p>
              Nobody runs a settlement loop. An account settles against the index whenever it is touched (an order, a withdrawal, a liquidation, or an explicit <C>settle</C>). At
              maturity the market freezes its final index, and positions settle against it.
            </p>
          </Section>

          <Section id="liquidation" title="Liquidation">
            <p>
              Anyone with margin can call <C>liquidate(account_id, market_id)</C> on an account whose net balance is below maintenance. The contract does the following:
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>settles the account and cancels its open orders;</li>
              <li>moves the whole position in that market to the liquidator, at the mark rate;</li>
              <li>moves a penalty from the account to the liquidator;</li>
              <li>checks that the liquidator still covers its own initial margin.</li>
            </ol>
            <Formula note="The penalty is capped at the account's net balance and cash, so a liquidation never creates bad debt.">
              penalty = MM(position) × (25 % → 50 %, linear as net falls from MM to 0)
            </Formula>
            <p>
              If a flat account still ends up negative, <C>cover_bad_debt</C> covers it from the insurance fund. Anyone can call it, and anyone can add to the fund with{" "}
              <C>{'{"insurance":true}'}</C>. The keeper bot watches every account and liquidates within seconds. The staged testnet liquidation, with its transaction hashes, is in{" "}
              <a href="https://github.com/devesh1011/funding-rate-swap/blob/main/docs/deployments.md" className="text-lime hover:underline">
                docs/deployments.md
              </a>
              .
            </p>
          </Section>

          <Section id="funds" title="Deposits and withdrawals">
            <p>
              Collateral is one NEP-141 token: native USDC on mainnet, tUSDC on testnet. You deposit by calling <C>ft_transfer_call</C> on the token, with the contract as
              receiver. The <C>msg</C> field decides who is credited:
            </p>
            <Table
              head={["msg", "Credits"]}
              rows={[
                [<C key="a">&quot;&quot;</C>, "the sender. The sender must have paid account storage first (storage_deposit, 0.1 NEAR), or the deposit is refunded."],
                [<C key="b">{'{"credit_to":"alice.near"}'}</C>, "alice.near. This is how NEAR Intents deposits for you: the deposit never comes back to the solver."],
                [<C key="c">{'{"insurance":true}'}</C>, "the insurance fund"],
              ]}
            />
            <p>
              The mainnet beta caps cash at <b className="text-white">{main.depositCap} USDC per account</b>. A <C>credit_to</C> deposit over the cap is not credited: the excess
              is forwarded into <C>intents.near</C> for the trader, so it is never stuck.
            </p>
            <p>Getting money out:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <C>withdraw(amount)</C> sends free margin back to your NEAR wallet.
              </li>
              <li>
                <C>withdraw_to_intents(amount, receiver?)</C> moves it into the NEAR Intents verifier. 1Click can then route it to any chain.
              </li>
              <li>If the token transfer fails, the callback restores your cash.</li>
            </ul>
            <p>
              <b className="text-white">Cross-chain, in the app</b> (mainnet, <Link href="/trade" className="text-lime hover:underline">Trade → Deposit → Transfer</Link>):
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <b className="text-white">In:</b> a 1Click quote from USDC on Base, Arbitrum, Ethereum or Solana, with the contract as recipient and{" "}
                <C>credit_to</C> set to your account. Send to the deposit address and your margin is credited, with no NEAR transaction from you.
              </li>
              <li>
                <b className="text-white">Out:</b> <C>withdraw</C>, then one transaction of <C>storage_deposit</C> + <C>ft_transfer</C> to a 1Click deposit address, which pays out
                on the chain you pick (including a Hyperliquid perp balance). The deposit address is a fresh implicit account, so it must be registered on USDC in the same
                transaction.
              </li>
            </ul>
          </Section>

          <Section id="contract" title="Contract API">
            <p>
              Amounts are in token base units (1e6 = 1 USDC). Rates are scaled so that 1e12 = 100 %. Ticks are basis points of APR. Calls that move funds need 1 yoctoNEAR
              attached.
            </p>
            <Table
              head={["Method", "Kind", "What it does"]}
              rows={[
                [<C key="1">storage_deposit()</C>, "call · 0.1 NEAR", "registers your margin account"],
                [<C key="2">place_order(market_id, side, size, tick, kind)</C>, "call", "Long / Short, Limit / Ioc / Market; returns fills and the resting order id"],
                [<C key="3">cancel_order(order_id) · cancel_all(market_id?)</C>, "call", "cancels resting orders"],
                [<C key="4">withdraw(amount) · withdraw_to_intents(amount, receiver?)</C>, "call · 1 yocto", "takes free margin out"],
                [<C key="5">settle(account_id)</C>, "call", "applies pending funding to an account"],
                [<C key="6">liquidate(account_id, market_id)</C>, "call", "takes over an unhealthy position for a penalty"],
                [<C key="7">submit_rates(feed_id, entries)</C>, "call", "posts signed hourly rates; anyone may relay them"],
                [<C key="8">list_markets() · get_market(market_id)</C>, "view", "mark, best bid and ask, open interest, mode, params, 24 h volume"],
                [<C key="9">get_book(market_id, depth?)</C>, "view", "aggregated bids and asks by tick"],
                [<C key="10">get_account(account_id)</C>, "view", "cash, positions, orders, and health (net, IM, MM, withdrawable, liquidatable)"],
                [<C key="11">get_trades(market_id) · get_account_trades(account_id)</C>, "view", "recent fills, liquidations flagged"],
                [<C key="12">get_candles(market_id, from_ts, to_ts?)</C>, "view", "hourly OHLC of trade rates, with volume"],
                [<C key="13">list_feeds() · get_feed(feed_id)</C>, "view", "the funding index, last interval, clamp and staleness"],
              ]}
            />
            <p>Try it with near-cli-rs:</p>
            <div className="glass-quiet overflow-x-auto px-5 py-4 font-mono text-[0.85rem] leading-6 whitespace-pre text-white/85">
              {`near contract call-function as-read-only ${main.swap} get_market \\
  json-args '{"market_id":0}' network-config mainnet now`}
            </div>
          </Section>

          <Section id="deployments" title="Deployments">
            <Table
              head={["", "Mainnet", "Testnet"]}
              rows={[
                ["Contract", <Acct key="a" net="mainnet" id={main.swap} />, <Acct key="b" net="testnet" id={test.swap} />],
                ["Collateral", <Acct key="c" net="mainnet" id={main.collateral} />, <Acct key="d" net="testnet" id={test.collateral} />],
                ["Oracle submitter", <Acct key="e" net="mainnet" id={main.oracle} />, <Acct key="f" net="testnet" id={test.oracle} />],
                ["Governance", <Acct key="g" net="mainnet" id="gov.fundswap.near" />, <Acct key="h" net="testnet" id="gov.fundswap-lab.testnet" />],
                ["Bots", "oracle", "oracle, maker, keeper"],
              ]}
            />
            <p>
              Mainnet and testnet run the same wasm (code hash <C>56e7ZTwA1FmubY3Rk1N7Rd3tGwojt5Tmqksq87zrAujs</C>). Every setup transaction, the mainnet NEAR Intents round
              trip and the testnet liquidation are listed with their hashes in{" "}
              <a href="https://github.com/devesh1011/funding-rate-swap/blob/main/docs/deployments.md" className="text-lime hover:underline">
                docs/deployments.md
              </a>
              .
            </p>
          </Section>

          <Section id="trust" title="Trust model">
            <p>This is a hackathon build. These are its limits:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <b className="text-white">Oracle:</b> the team holds all three signing keys. The 2-of-3 threshold protects against one leaked key, not against the team. Any key
                change goes through governance.
              </li>
              <li>
                <b className="text-white">Governance:</b> a single key, with no DAO and no timelock. It can create markets, change parameters and pause.
              </li>
              <li>
                <b className="text-white">Mainnet limits:</b> {main.depositCap} USDC per account and 100,000 YU of open interest. There is no maker on mainnet, so it is mainly a
                live proof of the deposit and withdrawal path.{" "}
                <Link href="/testnet/trade" className="text-lime hover:underline">
                  Testnet
                </Link>{" "}
                is where to trade.
              </li>
            </ul>
          </Section>
        </article>
      </main>
      <Closing net="mainnet" />
    </>
  );
}
