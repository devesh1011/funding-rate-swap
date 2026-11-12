import "server-only";

// Read-only access to the testnet deployment. Every number on the site
// comes from these calls; nothing is hard-coded.

export { explorer, KEEPER_ACCOUNT, NETWORK, ORACLE_ACCOUNT, SWAP_CONTRACT } from "./config";
import { SWAP_CONTRACT } from "./config";

// Fallbacks from docs.near.org/api/rpc/providers; rpc.testnet.near.org is deprecated and answers every call with an error.
const RPC = [process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"];
const ARCHIVAL_RPC = [process.env.NEAR_ARCHIVAL_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const NEARBLOCKS_API = "https://api-testnet.nearblocks.io/v3";

/** JSON-RPC with failover: a contract-level error is final, anything else tries the next endpoint. */
async function rpc<T>(urls: string[], method: string, params: object): Promise<T> {
  let last: Error = new Error("no rpc endpoints");
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { message?: string; cause?: { name?: string } } };
      if (body.result) return body.result;
      last = new Error(`rpc ${method}: ${body.error?.cause?.name ?? body.error?.message ?? res.status}`);
      if (body.error?.cause?.name === "CONTRACT_EXECUTION_ERROR" || body.error?.cause?.name === "UNKNOWN_ACCOUNT") throw last;
    } catch (e) {
      last = e as Error;
      if (/CONTRACT_EXECUTION_ERROR|UNKNOWN_ACCOUNT/.test(last.message)) throw last;
    }
  }
  throw last;
}

/** Contract view, at the latest final block or at a past block (archival). */
export async function view<T>(method: string, args: object = {}, blockId?: number): Promise<T> {
  const r = await rpc<{ result: number[] }>(blockId ? ARCHIVAL_RPC : RPC, "query", {
    request_type: "call_function",
    account_id: SWAP_CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    ...(blockId ? { block_id: blockId } : { finality: "final" }),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

interface BlockHeader {
  height: number;
  timestamp: string; // ns
}

const header = async (blockId?: number) =>
  (await rpc<{ header: BlockHeader }>(ARCHIVAL_RPC, "block", blockId ? { block_id: blockId } : { finality: "final" })).header;
const secs = (h: BlockHeader) => Number(BigInt(h.timestamp) / 1_000_000n) / 1000;

export interface BlockClock {
  height: number;
  ts: number;
  secsPerBlock: number;
}

/** Tip height and the average block time over the last day: maps a timestamp to a height. */
export async function blockClock(): Promise<BlockClock> {
  const tip = await header();
  const old = await header(tip.height - 86_400);
  return { height: tip.height, ts: secs(tip), secsPerBlock: (secs(tip) - secs(old)) / 86_400 };
}

/** Height of a block close to `tsSec` (within seconds over a few days). */
export function heightAt(clock: BlockClock, tsSec: number): number {
  return Math.min(clock.height, Math.round(clock.height - (clock.ts - tsSec) / clock.secsPerBlock));
}

/** JSON args of a transaction's first function call. */
export async function txArgs<T>(hash: string, sender: string): Promise<T> {
  const r = await rpc<{ transaction: { actions: { FunctionCall?: { args: string } }[] } }>(ARCHIVAL_RPC, "tx", {
    tx_hash: hash,
    sender_account_id: sender,
    wait_until: "NONE",
  });
  return JSON.parse(Buffer.from(r.transaction.actions[0].FunctionCall!.args, "base64").toString()) as T;
}

export interface TxSummary {
  hash: string;
  method: string | null;
  ts: number; // seconds
}

/** Latest transactions `signer` sent to the swap contract (NearBlocks v3). */
export async function recentTxs(signer: string, limit = 10): Promise<TxSummary[]> {
  const res = await fetch(`${NEARBLOCKS_API}/accounts/${SWAP_CONTRACT}/txns?signer=${signer}&limit=${limit}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as {
    data: { transaction_hash: string; block_timestamp: string; actions: { method: string | null }[] }[] | null;
  };
  return (body.data ?? []).map((t) => ({
    hash: t.transaction_hash,
    method: t.actions[0]?.method ?? null,
    ts: Number(BigInt(t.block_timestamp) / 1_000_000_000n),
  }));
}
