import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
import { config, type Role } from "./config.ts";

export const provider = new JsonRpcProvider({ url: config.rpcUrl });

/** Secret key from `<ROLE>_PRIVATE_KEY`, else the near-cli legacy keychain file. */
function secretKey(role: string, accountId: string): KeyPairString {
  const fromEnv = config.optional(`${role}_PRIVATE_KEY`);
  if (fromEnv) return fromEnv as KeyPairString;
  const file = join(homedir(), ".near-credentials", config.network, `${accountId}.json`);
  return JSON.parse(readFileSync(file, "utf8")).private_key as KeyPairString;
}

export function loadAccount(role: Role, fallbackId: string): Account {
  const id = config.account(role, fallbackId);
  return new Account(id, provider, secretKey(role, id));
}

/** Account by id with its key from the keychain (setup scripts only). */
export function keychainAccount(accountId: string): Account {
  return new Account(accountId, provider, secretKey("__NONE__", accountId));
}

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}

export interface CallResult<T> {
  hash: string;
  value: T | undefined;
}

/** Function call that resolves with the tx hash and decoded return value; throws on failure. */
export async function call<T = unknown>(
  account: Account,
  contractId: string,
  method: string,
  args: object,
  opts: { gasTera?: number; depositYocto?: bigint } = {},
): Promise<CallResult<T>> {
  const outcome = await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, teraToGas(opts.gasTera ?? 100), opts.depositYocto ?? 0n)],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  const status = outcome.status as { SuccessValue?: string };
  let value: T | undefined;
  if (status.SuccessValue) {
    try {
      value = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as T;
    } catch {
      value = undefined;
    }
  }
  return { hash: outcome.transaction.hash, value };
}

/**
 * NEP-141 transfer to an account that may not be registered on the token yet
 * (e.g. a fresh 1Click deposit address): `storage_deposit` and `ft_transfer`
 * in one transaction, so the transfer can never hit an unregistered account.
 */
export async function ftTransferRegistering(
  account: Account,
  token: string,
  receiverId: string,
  amount: string,
  storageYocto = 1_250_000_000_000_000_000_000n,
): Promise<CallResult<unknown>> {
  const outcome = await account.signAndSendTransaction({
    receiverId: token,
    actions: [
      actions.functionCall("storage_deposit", { account_id: receiverId, registration_only: true }, teraToGas(10), storageYocto),
      actions.functionCall("ft_transfer", { receiver_id: receiverId, amount }, teraToGas(20), 1n),
    ],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  const status = outcome.status as { Failure?: unknown };
  if (status.Failure) throw new Error(`ft_transfer to ${receiverId} failed: ${JSON.stringify(status.Failure).slice(0, 300)}`);
  return { hash: outcome.transaction.hash, value: undefined };
}

// ---------- typed views of the rate-swap contract ----------

export type Side = "Long" | "Short";
export type Mode = "Active" | "CloseOnly" | "Paused";

export interface FeedView {
  id: number;
  name: string;
  interval_secs: number;
  cum: string;
  last_ts: number;
  clamp: string;
  stale_after_secs: number;
  markets: number[];
}

export interface MarketView {
  id: number;
  feed_id: number;
  name: string;
  maturity_ts: number;
  mode: Mode;
  effective_mode: Mode;
  params: { max_dev: string; im_factor_bps: number; mm_ratio_bps: number };
  mark: string;
  long_oi: string;
  final_cum: string | null;
  best_bid: number | null;
  best_ask: number | null;
}

export interface OrderView {
  id: string;
  owner: string;
  market_id: number;
  side: Side;
  tick: number;
  remaining: string;
}

export interface AccountView {
  account_id: string;
  cash: string;
  storage_paid: boolean;
  positions: { market_id: number; n: string; fixed_flow: string; value: string; initial_margin: string; secs_left: number }[];
  orders: OrderView[];
  health: {
    cash: string;
    value: string;
    net: string;
    initial_margin: string;
    maintenance_margin: string;
    liquidatable: boolean;
    withdrawable: string;
  };
}

export const swap = {
  feeds: () => view<FeedView[]>(config.swap, "list_feeds"),
  markets: () => view<MarketView[]>(config.swap, "list_markets"),
  account: (account_id: string) => view<AccountView | null>(config.swap, "get_account", { account_id }),
  accounts: (from_index: number, limit: number) => view<string[]>(config.swap, "list_accounts", { from_index, limit }),
};
