import "server-only";
import { NETS, type Net } from "./config";

// Read-only access to a deployment (mainnet or testnet). Every number on
// the site comes from these calls; nothing is hard-coded.

export { explorer, NETS, type Net } from "./config";

/** JSON-RPC with failover: a contract-level error is final, anything else tries the next endpoint. */
async function rpc<T>(urls: string[], method: string, params: object, complete: (r: T) => boolean = () => true): Promise<T> {
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
      if (body.result && complete(body.result)) return body.result;
      // Some nodes report a contract error inside `result` ({ error: "..." }) rather than as an RPC error.
      const inner = (body.result as { error?: string } | undefined)?.error;
      last = new Error(`rpc ${method}: ${inner ? `CONTRACT_EXECUTION_ERROR ${inner}` : (body.error?.cause?.name ?? body.error?.message ?? `incomplete reply (${res.status})`)}`);
      if (inner || body.error?.cause?.name === "CONTRACT_EXECUTION_ERROR" || body.error?.cause?.name === "UNKNOWN_ACCOUNT") throw last;
    } catch (e) {
      last = e as Error;
      if (/CONTRACT_EXECUTION_ERROR|UNKNOWN_ACCOUNT/.test(last.message)) throw last;
    }
  }
  throw last;
}

/** View on the network's swap contract, at the latest final block or at a past block (archival). */
export async function view<T>(net: Net, method: string, args: object = {}, blockId?: number): Promise<T> {
  const c = NETS[net];
  const r = await rpc<{ result?: number[] }>(
    blockId ? c.archivalRpc : c.rpc,
    "query",
    {
      request_type: "call_function",
      account_id: c.swap,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      ...(blockId ? { block_id: blockId } : { finality: "final" }),
    },
    (x) => Array.isArray(x.result),
  );
  return JSON.parse(Buffer.from(r.result as number[]).toString()) as T;
}

interface BlockHeader {
  height: number;
  timestamp: string; // ns
}

const header = async (net: Net, blockId?: number) =>
  (await rpc<{ header: BlockHeader }>(NETS[net].archivalRpc, "block", blockId ? { block_id: blockId } : { finality: "final" })).header;
const secs = (h: BlockHeader) => Number(BigInt(h.timestamp) / 1_000_000n) / 1000;

export interface BlockClock {
  height: number;
  ts: number;
  secsPerBlock: number;
}

/** Tip height and the average block time over the last day: maps a timestamp to a height. */
export async function blockClock(net: Net): Promise<BlockClock> {
  const tip = await header(net);
  const old = await header(net, tip.height - 86_400);
  return { height: tip.height, ts: secs(tip), secsPerBlock: (secs(tip) - secs(old)) / 86_400 };
}

/** Height of a block close to `tsSec` (within seconds over a few days). */
export function heightAt(clock: BlockClock, tsSec: number): number {
  return Math.min(clock.height, Math.round(clock.height - (clock.ts - tsSec) / clock.secsPerBlock));
}

/** JSON args of a transaction's first function call. */
export async function txArgs<T>(net: Net, hash: string, sender: string): Promise<T> {
  const r = await rpc<{ transaction: { actions: { FunctionCall?: { args: string } }[] } }>(NETS[net].archivalRpc, "tx", {
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
export async function recentTxs(net: Net, signer: string, limit = 10): Promise<TxSummary[]> {
  // Optional context (links to recent txs): an indexer outage hides them, never the page.
  try {
    return await fetchRecentTxs(net, signer, limit);
  } catch {
    return [];
  }
}

async function fetchRecentTxs(net: Net, signer: string, limit: number): Promise<TxSummary[]> {
  const c = NETS[net];
  const res = await fetch(`${c.nearblocksApi}/accounts/${c.swap}/txns?signer=${signer}&limit=${limit}`, {
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
