"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import { ONE_YOCTO, parseUsdc, STORAGE_DEPOSIT, TGAS, toNum, type AccountView } from "@/lib/swap";
import { useToast, useTx, type Call } from "./hooks";
import { useNet } from "./net";

export type FundsMode = "deposit" | "withdraw" | "transfer";

const activateCall = (swap: string): Call => ({
  receiverId: swap,
  method: "storage_deposit",
  args: {},
  gas: TGAS(30),
  deposit: STORAGE_DEPOSIT,
});

/** How far above maintenance the account is: 1 when flat, 0 at liquidation. */
function healthOf(account: AccountView | null | undefined) {
  const h = account?.health;
  const net = h ? toNum(h.net) : 0;
  const mm = h ? toNum(h.maintenance_margin) : 0;
  return { net, mm, buffer: mm > 0 ? Math.max(0, Math.min(1, (net - mm) / Math.max(net, mm))) : 1 };
}

/** Half-ring gauge, filled to `value` (0..1). */
function Gauge({ value, danger }: { value: number; danger: boolean }) {
  const r = 9;
  const len = Math.PI * r;
  return (
    <svg viewBox="0 0 24 14" className="h-3.5 w-6" aria-hidden>
      <path d={`M3 12 A${r} ${r} 0 0 1 21 12`} fill="none" stroke="white" strokeOpacity={0.15} strokeWidth={3} strokeLinecap="round" />
      <path
        d={`M3 12 A${r} ${r} 0 0 1 21 12`}
        fill="none"
        stroke={danger ? "white" : "#c6f432"}
        strokeOpacity={danger ? 0.6 : 1}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${len * value} ${len}`}
      />
    </svg>
  );
}

function Row({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[0.85rem] tnum">
      <span className="text-white/60 underline decoration-white/20 decoration-dotted underline-offset-4">{label}</span>
      <span className="flex items-center gap-2">
        {value}
        {children}
      </span>
    </div>
  );
}

/** Boros-style margin account card: balances, health, and the funding actions. */
export function AccountCard({
  account,
  walletBalance,
  connected,
  onConnect,
  onOpen,
  onDone,
}: {
  account: AccountView | null | undefined;
  walletBalance: bigint | undefined;
  connected: boolean;
  onConnect: () => void;
  onOpen: (mode: FundsMode) => void;
  onDone: () => void;
}) {
  const c = useNet();
  const tx = useTx();
  const h = account?.health;
  const { net, mm, buffer } = healthOf(account);
  const positions = account?.positions.filter((p) => BigInt(p.n) !== 0n).length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between">
        <span className="rounded-md border border-white/15 px-2.5 py-1 text-[0.8rem] font-medium">{c.symbol} cross margin</span>
        <span className="text-[0.8rem] text-white/60">{positions} position{positions === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-4 space-y-2.5">
        <Row label="Net balance" value={h ? usd(net) : "—"} />
        <Row label="Margin usage" value={h ? usd(toNum(h.initial_margin)) : "—"} />
        <Row label="Maintenance margin" value={h ? usd(mm) : "—"} />
        <Row label="Health factor" value={h ? `${(buffer * 100).toFixed(0)}%` : "—"}>
          <Gauge value={h ? buffer : 1} danger={!!h?.liquidatable} />
        </Row>
        <Row label="Withdrawable" value={h ? usd(toNum(h.withdrawable)) : "—"} />
        <Row label={`Wallet ${c.symbol}`} value={walletBalance === undefined ? "—" : usd(toNum(walletBalance))} />
      </div>
      {connected ? (
        <div className="mt-5 grid grid-cols-3 gap-2">
          <button onClick={() => onOpen("deposit")} className="rounded-lg bg-lime py-2.5 text-sm font-medium text-ink hover:brightness-110">
            Deposit
          </button>
          <button onClick={() => onOpen("withdraw")} className="rounded-lg border border-white/20 py-2.5 text-sm hover:border-lime/60">
            Withdraw
          </button>
          <button onClick={() => onOpen("transfer")} className="rounded-lg border border-white/20 py-2.5 text-sm hover:border-lime/60">
            Transfer
          </button>
        </div>
      ) : (
        <button onClick={onConnect} className="mt-5 rounded-lg bg-lime py-2.5 text-sm font-medium text-ink">
          Connect wallet
        </button>
      )}
      {account && !account.storage_paid && (
        <button onClick={() => tx("Activate account", [activateCall(c.swap)]).then(onDone)} className="mt-3 text-left text-xs text-lime hover:underline">
          Activate account to trade (0.1 NEAR storage) →
        </button>
      )}
    </div>
  );
}

/** Deposit from the NEAR wallet into margin, or withdraw margin back to it (plus the testnet faucet). */
export function FundsForm({
  mode,
  accountId,
  account,
  walletBalance,
  onDone,
  onTransfer,
}: {
  mode: "deposit" | "withdraw";
  /** Switch the dialog to cross-chain Transfer (offered when the NEAR wallet is empty). */
  onTransfer?: () => void;
  accountId: string;
  account: AccountView | null | undefined;
  walletBalance: bigint | undefined;
  onDone: () => void;
}) {
  const tx = useTx();
  const c = useNet();
  const { push, update } = useToast();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const h = account?.health;
  const raw = parseUsdc(amount);
  // Mainnet caps each account's cash; a deposit past the cap would be refunded, so don't offer it.
  const capRoom = c.depositCap === null ? null : BigInt(c.depositCap) * 1_000_000n - BigInt(account?.cash ?? "0");
  const walletMax = walletBalance ?? 0n;
  const max =
    mode === "deposit" ? (capRoom === null ? walletMax : capRoom < walletMax ? (capRoom > 0n ? capRoom : 0n) : walletMax) : BigInt(h?.withdrawable ?? "0");

  // Why the button is disabled, in words.
  const blocker =
    mode === "deposit" && walletMax === 0n
      ? `Your NEAR wallet holds no ${c.symbol}.`
      : mode === "deposit" && capRoom !== null && capRoom <= 0n
        ? `You're at the ${c.depositCap} ${c.symbol} beta cap.`
        : mode === "withdraw" && max === 0n
          ? "Nothing to withdraw: no free margin."
          : !raw || raw <= 0n
            ? null
            : raw > max
              ? `More than you can ${mode}: at most ${(Number(max) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${c.symbol}.`
              : null;

  async function faucet() {
    setBusy(true);
    const id = push({ kind: "pending", title: "Requesting 10,000 test tUSDC" });
    const res = await fetch("/api/faucet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId }) });
    const body = (await res.json()) as { txs?: string[]; error?: string };
    update(id, res.ok ? { kind: "ok", title: "10,000 tUSDC sent to your wallet", hashes: body.txs } : { kind: "error", title: "Faucet", detail: body.error });
    setBusy(false);
    onDone();
  }

  async function submit() {
    if (!raw || raw <= 0n) return;
    setBusy(true);
    const calls: Call[] =
      mode === "deposit"
        ? [
            ...(account?.storage_paid ? [] : [activateCall(c.swap)]),
            {
              receiverId: c.collateral,
              method: "ft_transfer_call",
              args: { receiver_id: c.swap, amount: raw.toString(), msg: "" },
              gas: TGAS(100),
              deposit: ONE_YOCTO,
            },
          ]
        : [{ receiverId: c.swap, method: "withdraw", args: { amount: raw.toString() }, gas: TGAS(100), deposit: ONE_YOCTO }];
    const r = await tx(`${mode === "deposit" ? "Deposit" : "Withdraw"} ${amount} ${c.symbol}`, calls);
    setBusy(false);
    if (r.ok) {
      setAmount("");
      onDone();
    }
  }

  return (
    <div>
      <div className="glass-quiet p-4">
        <div className="text-xs text-white/55">From</div>
        <div className="mt-1 font-medium">{mode === "deposit" ? `My NEAR wallet · ${accountId}` : `Margin account · ${c.swap}`}</div>
      </div>
      <div className="my-1 text-center text-white/40" aria-hidden>
        ↓
      </div>
      <div className="glass-quiet p-4">
        <div className="text-xs text-white/55">To</div>
        <div className="mt-1 font-medium">{mode === "deposit" ? `Margin account · ${c.swap}` : `My NEAR wallet · ${accountId}`}</div>
      </div>

      <div className="mt-5 flex items-center justify-between text-sm">
        <span className="font-medium">Amount</span>
        <span className="text-white/55 tnum">
          {mode === "deposit" ? `Wallet: ${walletBalance === undefined ? "—" : usd(toNum(walletBalance))}` : `Withdrawable: ${usd(toNum(h?.withdrawable ?? "0"))}`}
        </span>
      </div>
      <div className="mt-2 flex items-center rounded-xl border border-white/12 bg-white/[0.03] px-3 focus-within:border-lime/60">
        <span className="mr-3 text-sm font-medium text-white/80">{c.symbol}</span>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className="w-full bg-transparent py-3 text-right tnum outline-none" />
        <button onClick={() => setAmount((Number(max) / 1e6).toString())} className="ml-3 rounded-md bg-white/10 px-2 py-1 text-xs text-lime">
          Max
        </button>
      </div>

      {mode === "deposit" && c.faucet && walletBalance !== undefined && walletBalance < 1_000_000_000n && (
        <button disabled={busy} onClick={faucet} className="mt-3 w-full rounded-lg border border-lime/40 py-2.5 text-sm text-lime hover:bg-lime/10 disabled:opacity-40">
          Get 10,000 test tUSDC first
        </button>
      )}

      <button
        disabled={busy || !raw || raw <= 0n || raw > max}
        onClick={submit}
        className="mt-5 w-full rounded-lg bg-lime py-3 font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Confirm in wallet…" : mode === "deposit" ? (account?.storage_paid ? "Deposit" : "Activate & deposit") : "Withdraw"}
      </button>
      {blocker && (
        <p className="mt-3 text-sm text-white/75">
          {blocker}{" "}
          {mode === "deposit" && walletMax === 0n && !c.faucet && onTransfer && (
            <button onClick={onTransfer} className="text-lime hover:underline">
              Bring USDC from Base, Arbitrum, Ethereum or Solana →
            </button>
          )}
          {mode === "deposit" && walletMax === 0n && c.faucet && "Use the faucet above to get test tUSDC."}
        </p>
      )}
      <p className="mt-3 text-[0.7rem] leading-5 text-white/45">
        {mode === "deposit"
          ? `${account?.storage_paid ? "Moves collateral into the swap with ft_transfer_call." : "Your first deposit also pays the 0.1 NEAR account storage, in the same wallet prompt."}${c.depositCap === null ? "" : ` Deposits are capped at ${c.depositCap} ${c.symbol} per account while in beta.`}`
          : "Up to your free margin. Needs your full-access key (1 yoctoNEAR)."}
      </p>
    </div>
  );
}
