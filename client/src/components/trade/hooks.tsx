"use client";

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Actions, useNearWallet } from "near-connect-hooks";
import { explorer } from "@/lib/config";
import { useNet } from "./net";
import { forgetOneClick, isDeadKeyError, oneClickCovers, oneClickKey, sendWithKey } from "./one-click";

/**
 * Re-runs `fn` every `ms` while mounted. Results are tagged with the `deps`
 * they were fetched for, so data from a previous market/account never shows.
 * `fetchedAt` is the wall-clock time of the last result (ms).
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; data?: T; fetchedAt?: number; error: string | null }>({ key, error: null });
  const [nonce, setNonce] = useState(0);
  const run = useEffectEvent(async () => {
    try {
      const data = await fn();
      setState({ key, data, fetchedAt: Date.now(), error: null });
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
    }
  });
  useEffect(() => {
    void run();
    const id = setInterval(() => void run(), ms);
    return () => clearInterval(id);
  }, [key, ms, nonce]);
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : undefined,
    fetchedAt: fresh ? state.fetchedAt : undefined,
    error: state.error,
    refresh: useCallback(() => setNonce((n) => n + 1), []),
  };
}

/** Wall-clock ms, ticking every `ms`; null until mounted (keeps server and client renders identical). */
export function useNow(ms = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  kind: "pending" | "ok" | "error";
  title: string;
  detail?: string;
  hashes?: string[];
}

const ToastCtx = createContext<{ push: (t: Omit<Toast, "id">) => number; update: (id: number, t: Partial<Toast>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const net = useNet().id;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = ++seq.current;
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    return id;
  }, []);
  const update = useCallback((id: number, t: Partial<Toast>) => {
    setToasts((ts) => ts.map((x) => (x.id === id ? { ...x, ...t } : x)));
    if (t.kind && t.kind !== "pending") setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === "error" ? 12_000 : 8_000);
  }, []);
  return (
    <ToastCtx.Provider value={{ push, update }}>
      {children}
      <div className="fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="glass-quiet bg-ink/95 px-4 py-3 shadow-2xl backdrop-blur" role="status">
            <div className="flex items-center gap-2 text-sm">
              <span className={`size-2 rounded-full ${t.kind === "ok" ? "bg-lime" : t.kind === "error" ? "bg-white/40" : "live-dot bg-lime/60"}`} />
              <span className={t.kind === "error" ? "text-white/80" : ""}>{t.title}</span>
            </div>
            {t.detail && <div className="mt-1 text-xs break-words text-white/60">{t.detail}</div>}
            {t.hashes?.map((h) => (
              <a key={h} href={explorer(net).tx(h)} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-lime hover:underline">
                {h.slice(0, 10)}… ↗
              </a>
            ))}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

// ---------------------------------------------------------------- transactions

export interface Action {
  method: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

export interface Call extends Action {
  receiverId: string;
  /** Actions that run first in the same transaction (e.g. a storage_deposit before a transfer). */
  before?: Action[];
}

interface Outcome {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown } | string;
}

function failure(o: Outcome): string | null {
  if (typeof o.status === "object" && o.status.Failure) {
    const f = JSON.stringify(o.status.Failure);
    return f.match(/"(?:ExecutionError|panic_msg)":"([^"]+)"/)?.[1]?.replace("Smart contract panicked: ", "") ?? f.slice(0, 160);
  }
  return null;
}

function decode<T>(o: Outcome): T | undefined {
  if (typeof o.status !== "object" || !o.status.SuccessValue) return undefined;
  try {
    return JSON.parse(atob(o.status.SuccessValue)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Signs and sends one or more function calls (one wallet prompt), shows a
 * toast with every tx hash, and returns the last call's decoded return value.
 */
export function useTx() {
  const { signAndSendTransactions, signedAccountId } = useNearWallet();
  const { id: net, swap } = useNet();
  const { push, update } = useToast();
  return useCallback(
    async <T,>(title: string, calls: Call[]): Promise<{ ok: boolean; value?: T; hashes?: string[] }> => {
      // Trading calls go through the 1-click key when it is on; everything else through the wallet.
      const key = oneClickCovers(calls, swap) ? oneClickKey(net, signedAccountId) : null;
      const id = push({ kind: "pending", title: key ? `${title}: sending` : `${title}: confirm in wallet` });
      try {
        const outcomes = (
          key
            ? await sendWithKey(net, signedAccountId, key, calls)
            : await signAndSendTransactions({
                transactions: calls.map((c) => ({
                  receiverId: c.receiverId,
                  actions: [...(c.before ?? []), c].map((a) => Actions.functionCall(a.method, a.args, a.gas, a.deposit)),
                })),
              })
        ) as unknown as Outcome[];
        const hashes = outcomes.map((o) => o.transaction.hash);
        const err = outcomes.map(failure).find(Boolean);
        if (err) {
          update(id, { kind: "error", title: `${title} failed`, detail: err, hashes });
          return { ok: false, hashes };
        }
        update(id, { kind: "ok", title, hashes });
        return { ok: true, value: decode<T>(outcomes[outcomes.length - 1]), hashes };
      } catch (e) {
        // The failover RPC wraps a rejected transaction once per node; the first inner error has the reason.
        const inner = (e as { errors?: unknown[] } | null)?.errors?.[0];
        const detail = inner instanceof Error ? inner.message : e instanceof Error ? e.message : String(e);
        if (key && isDeadKeyError(detail)) {
          forgetOneClick(net, signedAccountId);
          update(id, { kind: "error", title: `${title} not sent`, detail: "The 1-click key is gone or out of gas allowance, so 1-click is now off. Send again to sign in the wallet." });
          return { ok: false };
        }
        update(id, { kind: "error", title: `${title} not sent`, detail });
        return { ok: false };
      }
    },
    [signAndSendTransactions, signedAccountId, net, swap, push, update],
  );
}
