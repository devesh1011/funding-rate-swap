"use client";

import { useEffect, useEffectEvent, useState } from "react";
import {
  depositToSwapQuote,
  hyperliquidUsdc,
  isAddressFor,
  nearUsdc,
  oneClick,
  TERMINAL,
  withdrawFromNearQuote,
  type QuoteRequest,
  type QuoteResponse,
  type Status,
  type Token,
} from "@fundswap/intents/oneclick";
import { explorer } from "@/lib/config";
import { usd } from "@/lib/format";
import { ONE_YOCTO, TGAS, toNum, type AccountView } from "@/lib/swap";
import { usePoll, useTx } from "./hooks";
import { useNet } from "./net";

// Cross-chain margin through NEAR Intents (1Click), mainnet only:
// - in:  pay USDC on another chain to a 1Click deposit address; 1Click
//        delivers it to the swap with `ft_transfer_call` and our
//        {"credit_to": you} message, so it lands as margin in one step.
// - out: send USDC from your NEAR wallet to a 1Click deposit address, paid
//        out on Base, Arbitrum or a Hyperliquid perp account.
// The browser calls 1Click directly (CORS is open); nothing goes through our server.

const api = oneClick();
/** NEP-141 storage for registering a 1Click deposit address on USDC. */
const USDC_STORAGE = "1250000000000000000000";

const SOURCES = [
  { chain: "base", label: "Base" },
  { chain: "arb", label: "Arbitrum" },
  { chain: "eth", label: "Ethereum" },
  { chain: "sol", label: "Solana" },
] as const;
const DESTINATIONS = [
  { chain: "base", label: "Base" },
  { chain: "arb", label: "Arbitrum" },
  { chain: "hypercore", label: "Hyperliquid perp" },
] as const;

const STATUS_TEXT: Record<Status, string> = {
  PENDING_DEPOSIT: "Waiting for your transfer",
  KNOWN_DEPOSIT_TX: "Transfer seen, confirming",
  PROCESSING: "Swapping through NEAR Intents",
  SUCCESS: "Done",
  REFUNDED: "Refunded to your refund address",
  FAILED: "Failed",
  INCOMPLETE_DEPOSIT: "Deposit was less than quoted; refunded",
};

/** "2.5" with `decimals` → base units, or null if not a plain decimal. */
function toUnits(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`).test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Live dry quote for `req`, refetched ~0.6 s after the inputs settle. */
function useDryQuote(key: string, build: () => QuoteRequest | null) {
  const [state, setState] = useState<{ key: string; quote?: QuoteResponse; error?: string } | null>(null);
  const fetchQuote = useEffectEvent(async (k: string) => {
    const req = build();
    if (!req) return;
    try {
      const quote = await api.quote(req);
      setState({ key: k, quote });
    } catch (e) {
      setState({ key: k, error: errText(e) });
    }
  });
  useEffect(() => {
    const t = setTimeout(() => void fetchQuote(key), 600);
    return () => clearTimeout(t);
  }, [key]);
  return state?.key === key ? state : null;
}

/** 1Click status of one deposit address until it reaches a terminal state. */
function useSwapStatus(depositAddress: string | null) {
  const poll = usePoll(() => (depositAddress ? api.status(depositAddress) : Promise.resolve(null)), 5_000, [depositAddress]);
  return poll.data ?? null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className="label text-[0.6rem] text-white/60">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputCls = "w-full rounded-xl border border-white/12 bg-white/[0.03] px-3 py-2.5 text-sm outline-none focus:border-lime/60";

function ChainPicker<T extends string>({ value, options, onChange }: { value: T; options: readonly { chain: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.chain}
          onClick={() => onChange(o.chain)}
          className={`rounded-full border px-3 py-1.5 text-xs ${o.chain === value ? "border-lime bg-lime/10 text-lime" : "border-white/12 text-white/70 hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function QuoteLines({ quote, error, outLabel }: { quote?: QuoteResponse; error?: string; outLabel: string }) {
  if (error) return <p className="mt-3 text-xs leading-5 text-white/55">1Click: {error}</p>;
  if (!quote) return <p className="mt-3 text-xs text-white/40">Fetching a live quote…</p>;
  const q = quote.quote;
  const fee = Number(q.amountInFormatted) - Number(q.amountOutFormatted);
  return (
    <dl className="mt-3 space-y-1.5 text-[0.8rem] tnum">
      <div className="flex justify-between"><dt className="text-white/60">{outLabel}</dt><dd className="text-lime">{q.amountOutFormatted} USDC</dd></div>
      <div className="flex justify-between"><dt className="text-white/60">Fee</dt><dd>{fee > 0 ? usd(fee, 4) : "—"}</dd></div>
      <div className="flex justify-between"><dt className="text-white/60">ETA</dt><dd>~{q.timeEstimate}s</dd></div>
    </dl>
  );
}

function StatusBox({ status, lines }: { status: Status | undefined; lines: React.ReactNode }) {
  const done = status && (TERMINAL as readonly string[]).includes(status);
  return (
    <div className="glass-quiet mt-3 p-3 text-xs leading-5">
      <div className="flex items-center gap-2 font-medium">
        <span className={`size-2 rounded-full ${status === "SUCCESS" ? "bg-lime" : done ? "bg-white/40" : "live-dot bg-lime/60"}`} />
        {status ? STATUS_TEXT[status] : "Waiting for your transfer"}
      </div>
      <div className="mt-1.5 text-white/60">{lines}</div>
    </div>
  );
}

function DepositIn({ accountId, account, tokens, onDone }: { accountId: string; account: AccountView | null | undefined; tokens: Token[]; onDone: () => void }) {
  const c = useNet();
  const [chain, setChain] = useState<(typeof SOURCES)[number]["chain"]>("base");
  const [amount, setAmount] = useState("5");
  const [refundTo, setRefundTo] = useState("");
  const [order, setOrder] = useState<{ depositAddress: string; amountIn: string; chainLabel: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const origin = tokens.find((t) => t.symbol === "USDC" && t.blockchain === chain);
  const units = origin ? toUnits(amount, origin.decimals) : null;
  const room = c.depositCap === null ? Infinity : c.depositCap - toNum(account?.cash ?? "0");
  const problem = !origin
    ? "1Click doesn't list USDC on this chain right now"
    : !units || units <= 0n
      ? "Enter an amount"
      : Number(amount) > room
        ? `Over the ${c.depositCap} USDC beta cap: at most ${Math.max(0, room).toFixed(2)} more`
        : !isAddressFor(chain, refundTo)
          ? `Enter your ${SOURCES.find((s) => s.chain === chain)!.label} address for refunds`
          : null;

  const build = (dry: boolean) =>
    !problem && origin && units
      ? depositToSwapQuote({ dry, origin, collateral: nearUsdc(tokens), amount: units, refundTo, swapContract: c.swap, trader: accountId })
      : null;
  const preview = useDryQuote(`${chain}|${amount}|${refundTo}|${accountId}|${problem ?? ""}`, () => build(true));
  const status = useSwapStatus(order?.depositAddress ?? null);
  const settled = useEffectEvent(() => onDone());
  useEffect(() => {
    if (status?.status === "SUCCESS") settled();
  }, [status?.status]);

  async function start() {
    const req = build(false);
    if (!req) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.quote(req);
      setOrder({ depositAddress: r.quote.depositAddress!, amountIn: r.quote.amountInFormatted, chainLabel: SOURCES.find((s) => s.chain === chain)!.label });
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  }

  if (order) {
    return (
      <div>
        <p className="text-sm leading-6">
          Send exactly <span className="font-semibold text-lime">{order.amountIn} USDC</span> on <span className="font-semibold">{order.chainLabel}</span> to:
        </p>
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-lime/40 bg-lime/[0.05] px-3 py-2.5">
          <code className="min-w-0 flex-1 text-[0.72rem] break-all">{order.depositAddress}</code>
          <button onClick={() => void navigator.clipboard.writeText(order.depositAddress)} className="shrink-0 text-xs text-lime hover:underline">
            Copy
          </button>
        </div>
        <p className="mt-2 text-[0.68rem] leading-5 text-white/50">
          A one-time NEAR Intents address for this quote. Send USDC only, from any wallet. It lands as margin on {c.swap} for {accountId}.
        </p>
        <StatusBox
          status={status?.status}
          lines={
            status?.status === "SUCCESS"
              ? `${status.swapDetails?.amountOutFormatted ?? ""} USDC credited as margin.${account && !account.storage_paid ? " Activate your account in Margin to trade." : ""}`
              : status?.status === "REFUNDED" || status?.status === "INCOMPLETE_DEPOSIT"
                ? `${status.swapDetails?.refundReason ?? "Refunded"}.`
                : "This updates on its own; usually under a minute after your transfer confirms."
          }
        />
        <button onClick={() => setOrder(null)} className="mt-3 text-xs text-white/60 hover:text-lime">
          New deposit
        </button>
      </div>
    );
  }

  return (
    <div>
      <Field label="From">
        <ChainPicker value={chain} options={SOURCES} onChange={setChain} />
      </Field>
      <Field label="Amount (USDC)">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={`${inputCls} tnum`} />
      </Field>
      <Field label={`Your ${SOURCES.find((s) => s.chain === chain)!.label} address (refunds)`}>
        <input value={refundTo} onChange={(e) => setRefundTo(e.target.value.trim())} placeholder={chain === "sol" ? "Solana address" : "0x…"} className={inputCls} />
      </Field>
      {problem ? <p className="mt-3 text-xs text-white/55">{problem}</p> : <QuoteLines quote={preview?.quote} error={preview?.error} outLabel="Margin credited" />}
      <button disabled={!!problem || busy || !preview?.quote} onClick={start} className="pill pill-lime mt-4 w-full py-3 text-base disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Getting deposit address…" : "Get deposit address"}
      </button>
      {err && <p className="mt-2 text-xs text-white/55">1Click: {err}</p>}
    </div>
  );
}

function WithdrawOut({ accountId, walletBalance, tokens, onDone }: { accountId: string; walletBalance: bigint | undefined; tokens: Token[]; onDone: () => void }) {
  const c = useNet();
  const tx = useTx();
  const [dest, setDest] = useState<(typeof DESTINATIONS)[number]["chain"]>("base");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [sent, setSent] = useState<{ depositAddress: string; hash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const usdc = nearUsdc(tokens);
  const destination = dest === "hypercore" ? (() => { try { return hyperliquidUsdc(tokens); } catch { return undefined; } })() : tokens.find((t) => t.symbol === "USDC" && t.blockchain === dest);
  const units = toUnits(amount, usdc.decimals);
  const max = walletBalance ?? 0n;
  const problem = !destination
    ? "1Click doesn't list this destination right now"
    : !units || units <= 0n
      ? `Enter an amount (your NEAR wallet holds ${toNum(max).toFixed(2)} USDC; withdraw from Margin first)`
      : units > max
        ? `Your NEAR wallet holds ${toNum(max).toFixed(2)} USDC. Withdraw from Margin first.`
        : dest === "hypercore" && units < 500_000n
          ? "Hyperliquid needs at least 0.5 USDC"
          : !isAddressFor(dest, to)
            ? `Enter the ${DESTINATIONS.find((d) => d.chain === dest)!.label} address to receive`
            : null;

  const build = (dry: boolean) =>
    !problem && destination && units ? withdrawFromNearQuote({ dry, collateral: usdc, destination, amount: units, recipient: to, trader: accountId }) : null;
  const preview = useDryQuote(`${dest}|${amount}|${to}|${accountId}|${problem ?? ""}`, () => build(true));
  const status = useSwapStatus(sent?.depositAddress ?? null);

  async function send() {
    const req = build(false);
    if (!req) return;
    setBusy(true);
    setErr(null);
    try {
      const { quote } = await api.quote(req);
      const dep = quote.depositAddress!;
      // 1Click's deposit address is a fresh account: register it on USDC in the same transaction.
      const r = await tx(`Send ${quote.amountInFormatted} USDC via NEAR Intents`, [
        {
          receiverId: c.collateral,
          method: "ft_transfer",
          args: { receiver_id: dep, amount: quote.amountIn },
          gas: TGAS(20),
          deposit: ONE_YOCTO,
          before: [{ method: "storage_deposit", args: { account_id: dep, registration_only: true }, gas: TGAS(10), deposit: USDC_STORAGE }],
        },
      ]);
      if (r.ok && r.hashes?.[0]) {
        setSent({ depositAddress: dep, hash: r.hashes[0] });
        void api.submitDeposit({ txHash: r.hashes[0], depositAddress: dep, nearSenderAccount: accountId }).catch(() => {});
        onDone();
      }
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  }

  if (sent) {
    const destLabel = DESTINATIONS.find((d) => d.chain === dest)!.label;
    return (
      <div>
        <StatusBox
          status={status?.status}
          lines={
            <>
              {status?.status === "SUCCESS"
                ? `${status.swapDetails?.amountOutFormatted ?? ""} USDC paid out on ${destLabel}.`
                : `Sending to ${to.slice(0, 8)}… on ${destLabel}.`}{" "}
              <a href={explorer(c.id).tx(sent.hash)} target="_blank" rel="noreferrer" className="text-lime hover:underline">
                NEAR tx ↗
              </a>
            </>
          }
        />
        <button onClick={() => setSent(null)} className="mt-3 text-xs text-white/60 hover:text-lime">
          New withdrawal
        </button>
      </div>
    );
  }

  return (
    <div>
      <Field label="To">
        <ChainPicker value={dest} options={DESTINATIONS} onChange={setDest} />
      </Field>
      <Field label="Amount (USDC from your NEAR wallet)">
        <div className="flex items-center gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className={`${inputCls} tnum`} />
          <button onClick={() => setAmount((Number(max) / 1e6).toString())} className="text-xs text-lime">MAX</button>
        </div>
      </Field>
      <Field label={`Receiving address on ${DESTINATIONS.find((d) => d.chain === dest)!.label}`}>
        <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" className={inputCls} />
      </Field>
      {problem ? <p className="mt-3 text-xs leading-5 text-white/55">{problem}</p> : <QuoteLines quote={preview?.quote} error={preview?.error} outLabel="You receive" />}
      <button disabled={!!problem || busy || !preview?.quote} onClick={send} className="pill pill-lime mt-4 w-full py-3 text-base disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Confirm in wallet…" : "Send"}
      </button>
      {err && <p className="mt-2 text-xs text-white/55">1Click: {err}</p>}
    </div>
  );
}

/** Deposit margin from, or send USDC out to, other chains through NEAR Intents. */
export function CrossChain({
  accountId,
  account,
  walletBalance,
  onDone,
}: {
  accountId: string;
  account: AccountView | null | undefined;
  walletBalance: bigint | undefined;
  onDone: () => void;
}) {
  const tokens = usePoll(() => api.tokens(), 10 * 60_000, []);
  const [tab, setTab] = useState<"in" | "out">("in");
  if (!tokens.data) return <p className="text-sm text-white/45">{tokens.error ? `1Click: ${tokens.error}` : "Loading NEAR Intents routes…"}</p>;
  return (
    <div>
      <div className="grid grid-cols-2 gap-1 rounded-full border border-white/10 p-1">
        {(["in", "out"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full py-2 text-xs font-medium tracking-[0.08em] uppercase ${tab === t ? "bg-white/10 text-lime" : "text-white/60 hover:text-white"}`}>
            {t === "in" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>
      {tab === "in" ? (
        <DepositIn accountId={accountId} account={account} tokens={tokens.data} onDone={onDone} />
      ) : (
        <WithdrawOut accountId={accountId} walletBalance={walletBalance} tokens={tokens.data} onDone={onDone} />
      )}
    </div>
  );
}
