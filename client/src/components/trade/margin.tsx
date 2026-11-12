"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import { ONE_YOCTO, parseUsdc, STORAGE_DEPOSIT, TGAS, toNum, type AccountView } from "@/lib/swap";
import { useToast, useTx, type Call } from "./hooks";
import { useNet } from "./net";

const activateCall = (swap: string): Call => ({
  receiverId: swap,
  method: "storage_deposit",
  args: {},
  gas: TGAS(30),
  deposit: STORAGE_DEPOSIT,
});

function Stat({ label, value, lime }: { label: string; value: string; lime?: boolean }) {
  return (
    <div className="flex justify-between text-[0.82rem] tnum">
      <span className="text-white/60">{label}</span>
      <span className={lime ? "text-lime" : ""}>{value}</span>
    </div>
  );
}

/** Margin account: health, wallet balance, deposit and withdraw (plus the faucet on testnet). */
export function MarginPanel({
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
  const tx = useTx();
  const c = useNet();
  const { push, update } = useToast();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const h = account?.health;
  const raw = parseUsdc(amount);
  // Mainnet caps each account's cash; a deposit past the cap would be refunded, so don't offer it.
  const capRoom = c.depositCap === null ? null : BigInt(c.depositCap) * 1_000_000n - BigInt(account?.cash ?? "0");
  const walletMax = walletBalance ?? 0n;
  const max =
    mode === "deposit" ? (capRoom === null ? walletMax : capRoom < walletMax ? (capRoom > 0n ? capRoom : 0n) : walletMax) : BigInt(h?.withdrawable ?? "0");

  const net = h ? toNum(h.net) : 0;
  const mm = h ? toNum(h.maintenance_margin) : 0;
  // How far above maintenance the account is: 100 % flat, 0 % at liquidation.
  const buffer = mm > 0 ? Math.max(0, Math.min(1, (net - mm) / Math.max(net, mm))) : 1;

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
      <div className="space-y-2">
        <Stat label="Margin (cash)" value={h ? usd(toNum(h.cash)) : "—"} />
        <Stat label="Position value" value={h ? usd(toNum(h.value)) : "—"} />
        <Stat label="Net" value={h ? usd(net) : "—"} lime />
        <Stat label="Initial margin" value={h ? usd(toNum(h.initial_margin)) : "—"} />
        <Stat label="Maintenance" value={h ? usd(mm) : "—"} />
        <Stat label="Withdrawable" value={h ? usd(toNum(h.withdrawable)) : "—"} />
      </div>
      <div className="mt-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className={`h-full ${h?.liquidatable ? "bg-white/50" : "bg-lime"}`} style={{ width: `${buffer * 100}%` }} />
        </div>
        <div className="label mt-1.5 flex justify-between text-[0.55rem] text-white/50">
          <span>{h?.liquidatable ? "Liquidatable" : "Health"}</span>
          <span>{mm > 0 ? `${(buffer * 100).toFixed(0)}% above maintenance` : "No positions"}</span>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-xl border border-white/10 px-3 py-2.5 text-[0.8rem]">
        <span className="text-white/60">Wallet {c.symbol}</span>
        <span className="tnum">{walletBalance === undefined ? "—" : usd(toNum(walletBalance))}</span>
      </div>
      {c.faucet && walletBalance !== undefined && walletBalance < 1_000_000_000n && (
        <button disabled={busy} onClick={faucet} className="pill pill-ghost mt-2 w-full py-2.5 text-sm disabled:opacity-40">
          Get 10,000 test tUSDC
        </button>
      )}

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-full border border-white/10 p-1">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-full py-2 text-xs tracking-[0.06em] uppercase ${mode === m ? "bg-white/10 text-lime" : "text-white/60 hover:text-white"}`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center rounded-xl border border-white/12 bg-white/[0.03] px-3 focus-within:border-lime/60">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" className="w-full bg-transparent py-2.5 tnum outline-none" />
        <button onClick={() => setAmount((Number(max) / 1e6).toString())} className="text-xs text-lime">
          MAX
        </button>
      </div>
      <button
        disabled={busy || !raw || raw <= 0n || raw > max}
        onClick={submit}
        className="pill pill-lime mt-3 w-full py-3 text-base disabled:cursor-not-allowed disabled:opacity-40"
      >
        {mode === "deposit" ? (account?.storage_paid ? "Deposit" : "Activate & deposit") : "Withdraw"}
      </button>
      <p className="mt-2 text-[0.65rem] leading-5 text-white/45">
        {mode === "deposit"
          ? `${account?.storage_paid ? "ft_transfer_call into the swap contract." : "First deposit also pays the 0.1 NEAR account storage, in the same wallet prompt."}${c.depositCap === null ? "" : ` Deposits are capped at ${c.depositCap} ${c.symbol} per account while in beta.`}`
          : "Up to your free margin. Needs your full-access key (1 yoctoNEAR)."}
      </p>
      {account && !account.storage_paid && (
        <button disabled={busy} onClick={() => tx("Activate account", [activateCall(c.swap)]).then(onDone)} className="mt-2 text-xs text-lime hover:underline">
          Activate account only (0.1 NEAR) →
        </button>
      )}
    </div>
  );
}
