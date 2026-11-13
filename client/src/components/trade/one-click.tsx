"use client";

// One-click trading with a NEAR function-call access key.
//
// The trader's wallet adds, once, a key that may only call the trading methods
// below on the swap contract and can never attach a deposit. The browser keeps
// that key and signs orders with it, so trading needs no wallet prompt. The key
// cannot withdraw: `withdraw` needs 1 yoctoNEAR, which a function-call key can
// never attach. The protocol enforces this, not the app.
//
// near-connect-hooks ships a similar plugin, but it keeps one key per browser
// (not per account and network) and stores it before the wallet confirms, so a
// rejected prompt would leave every later order signed by a key that isn't on
// chain. This module stores a key only once it is on chain.

import { Account, actions, FailoverRpcProvider, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { useNearWallet } from "near-connect-hooks";
import { useEffect, useState, useSyncExternalStore } from "react";
import { NETS, type Net } from "@/lib/config";
import type { Call } from "./hooks";
import { useNet } from "./net";

export const ONE_CLICK_METHODS = ["place_order", "cancel_order", "cancel_all"];
/** Gas budget of the key; it caps gas spent through it, it doesn't lock any NEAR. */
const ALLOWANCE = "500000000000000000000000"; // 0.5 NEAR

interface Stored {
  publicKey: string;
  privateKey: KeyPairString;
}

const slot = (net: Net, accountId: string) => `fundswap:one-click:${net}:${accountId}`;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function read(net: Net, accountId: string): Stored | null {
  try {
    const raw = localStorage.getItem(slot(net, accountId));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function write(net: Net, accountId: string, value: Stored | null) {
  try {
    if (value) localStorage.setItem(slot(net, accountId), JSON.stringify(value));
    else localStorage.removeItem(slot(net, accountId));
  } catch {
    // Storage blocked (private mode): one-click simply stays off.
  }
  emit();
}

const rpc = (net: Net) => new FailoverRpcProvider(NETS[net].rpc.map((url) => new JsonRpcProvider({ url })));

/** Whether the key is on chain with exactly the permission this app asks for. */
async function onChain(net: Net, accountId: string, publicKey: string): Promise<boolean> {
  try {
    const key = await rpc(net).viewAccessKey({ accountId, publicKey });
    const perm = key.permission;
    return typeof perm === "object" && "FunctionCall" in perm && perm.FunctionCall.receiver_id === NETS[net].swap;
  } catch {
    return false;
  }
}

/** Calls the stored key can sign: trading methods on the swap contract, no deposit, nothing batched before them. */
export function oneClickCovers(calls: Call[], swap: string): boolean {
  return calls.every((c) => c.receiverId === swap && ONE_CLICK_METHODS.includes(c.method) && BigInt(c.deposit) === 0n && !c.before?.length);
}

/** The stored key for this account, if one-click is on. */
export function oneClickKey(net: Net, accountId: string): Stored | null {
  return accountId ? read(net, accountId) : null;
}

/** Errors that mean the key is gone or spent, so one-click must turn off. */
export const isDeadKeyError = (message: string) => /access ?key|allowance|does not exist|NotEnoughAllowance|InvalidAccessKey/i.test(message);

export function forgetOneClick(net: Net, accountId: string) {
  write(net, accountId, null);
}

/** Signs and sends each call with the stored key, in order. Returns the raw outcomes, like the wallet does. */
export async function sendWithKey(net: Net, accountId: string, key: Stored, calls: Call[]) {
  const account = new Account(accountId, rpc(net), key.privateKey);
  const outcomes = [];
  for (const c of calls) {
    outcomes.push(
      await account.signAndSendTransaction({
        receiverId: c.receiverId,
        actions: [actions.functionCall(c.method, c.args, BigInt(c.gas), 0n)],
        throwOnFailure: false,
      }),
    );
  }
  return outcomes;
}

/** State and actions for the "1-click trading" toggle. */
export function useOneClick() {
  const c = useNet();
  const { signedAccountId, addFunctionCallKey, deleteKey } = useNearWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicKey = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (signedAccountId ? (read(c.id, signedAccountId)?.publicKey ?? null) : null),
    () => null,
  );

  // A key revoked from another device or wallet: forget it here too.
  useEffect(() => {
    if (!publicKey || !signedAccountId) return;
    let live = true;
    void onChain(c.id, signedAccountId, publicKey).then((ok) => {
      if (live && !ok) write(c.id, signedAccountId, null);
    });
    return () => {
      live = false;
    };
  }, [publicKey, signedAccountId, c.id]);

  async function enable() {
    if (!signedAccountId) return;
    setBusy(true);
    setError(null);
    const pair = KeyPair.fromRandom("ed25519");
    const key: Stored = { publicKey: pair.getPublicKey().toString(), privateKey: pair.toString() as KeyPairString };
    try {
      await addFunctionCallKey({ publicKey: key.publicKey, contractId: c.swap, methodNames: ONE_CLICK_METHODS, allowance: ALLOWANCE });
      // Store only what the chain confirms (a few tries: RPC nodes lag a block or two).
      for (let i = 0; i < 6; i++) {
        if (await onChain(c.id, signedAccountId, key.publicKey)) {
          write(c.id, signedAccountId, key);
          return;
        }
        await new Promise((r) => setTimeout(r, 1_500));
      }
      setError("The wallet didn't add the key. One-click stays off.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!signedAccountId || !publicKey) return;
    setBusy(true);
    setError(null);
    try {
      await deleteKey({ publicKey });
    } catch (e) {
      // Still forget it locally; the on-chain key can only trade, and the wallet can remove it later.
      setError(`Turned off here. The key is still on your account: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      write(c.id, signedAccountId, null);
      setBusy(false);
    }
  }

  return { on: publicKey !== null, busy, error, enable, disable };
}

/** The toggle under the order ticket. */
export function OneClickToggle() {
  const { on, busy, error, enable, disable } = useOneClick();
  return (
    <div className="mt-4 rounded-lg border border-white/[0.08] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.8rem] font-medium">
            1-click trading <span className={on ? "text-lime" : "text-white/45"}>{on ? "on" : "off"}</span>
          </div>
          <p className="mt-0.5 text-[0.7rem] leading-4 text-white/50">
            {on ? "Orders and cancels sign without a wallet prompt." : "Orders sign with a key that can only trade here. It can't withdraw."}
          </p>
        </div>
        <button
          disabled={busy}
          onClick={on ? disable : enable}
          className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${on ? "border border-white/20 hover:border-white/40" : "bg-lime text-ink hover:brightness-110"}`}
        >
          {busy ? "Confirm in wallet…" : on ? "Turn off" : "Enable"}
        </button>
      </div>
      {error && <p className="mt-2 text-[0.7rem] text-white/70">{error}</p>}
    </div>
  );
}
