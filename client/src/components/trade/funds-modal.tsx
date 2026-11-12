"use client";

import Link from "next/link";
import { useEffect } from "react";
import type { AccountView } from "@/lib/swap";
import { CrossChain } from "./intents";
import { FundsForm, type FundsMode } from "./margin";
import { useNet } from "./net";

const TITLES: Record<FundsMode, { title: string; sub: string }> = {
  deposit: { title: "Deposit", sub: "Move collateral from your NEAR wallet into margin" },
  withdraw: { title: "Withdraw", sub: "Move free margin back to your NEAR wallet" },
  transfer: { title: "Transfer", sub: "Between margin and other chains, through NEAR Intents" },
};

/** Boros-style funding dialog: deposit, withdraw, or cross-chain transfer. */
export function FundsModal({
  mode,
  onMode,
  onClose,
  accountId,
  account,
  walletBalance,
  onDone,
}: {
  mode: FundsMode;
  onMode: (m: FundsMode) => void;
  onClose: () => void;
  accountId: string;
  account: AccountView | null | undefined;
  walletBalance: bigint | undefined;
  onDone: () => void;
}) {
  const c = useNet();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal aria-labelledby="funds-title" className="w-full max-w-[460px] rounded-2xl border border-white/12 bg-[#101012] p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 id="funds-title" className="text-2xl font-semibold tracking-tight">
              {TITLES[mode].title}
            </h2>
            <p className="mt-1 text-sm text-white/55">{TITLES[mode].sub}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-1 rounded-lg border border-white/10 p-1">
          {(Object.keys(TITLES) as FundsMode[]).map((m) => (
            <button key={m} onClick={() => onMode(m)} className={`rounded-md py-2 text-sm ${m === mode ? "bg-white/10 font-medium text-lime" : "text-white/60 hover:text-white"}`}>
              {TITLES[m].title}
            </button>
          ))}
        </div>
        <div className="mt-5">
          {mode === "transfer" ? (
            c.id === "mainnet" ? (
              <CrossChain accountId={accountId} account={account} walletBalance={walletBalance} onDone={onDone} />
            ) : (
              <p className="text-sm leading-6 text-white/60">
                Cross-chain transfers go through NEAR Intents, which runs on mainnet only.{" "}
                <Link href="/trade" className="text-lime hover:underline">Switch to Mainnet →</Link>
              </p>
            )
          ) : (
            <FundsForm key={mode} mode={mode} accountId={accountId} account={account} walletBalance={walletBalance} onDone={onDone} onTransfer={() => onMode("transfer")} />
          )}
        </div>
      </div>
    </div>
  );
}
