// Checks every headline claim in the README against the live deployments.
// Read-only: no keys, no wallet, no transactions. Needs Node >= 24 and nothing
// else (no `pnpm install`):
//
//   node scripts/verify.ts          # or: pnpm verify
//
// Each line prints PASS or FAIL with the evidence it read; the exit code is 1
// if anything failed.

import { depositToSwapQuote, findToken, nearUsdc, oneClick } from "../intents/src/oneclick.ts";

const APP = "https://fundswap-drab.vercel.app";
const MAINNET_CODE_HASH = "56e7ZTwA1FmubY3Rk1N7Rd3tGwojt5Tmqksq87zrAujs";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const NET = {
  mainnet: {
    swap: "fundswap.near",
    rpc: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
    archival: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
  },
  testnet: {
    swap: "fundswap-lab.testnet",
    rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
    archival: ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
  },
} as const;
type Net = keyof typeof NET;

const BASE_RPC = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

// ------------------------------------------------------------------ plumbing

async function jsonRpc<T>(urls: readonly string[], method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { result?: T & { error?: string }; error?: unknown };
      if (body.result && !body.result.error) return body.result;
      last = body.error ?? body.result?.error ?? `HTTP ${res.status}`;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${method}: ${typeof last === "string" ? last : JSON.stringify(last instanceof Error ? last.message : last)}`);
}

async function view<T>(net: Net, method: string, args: object = {}): Promise<T> {
  const r = await jsonRpc<{ result: number[] }>(NET[net].rpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: NET[net].swap,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString()) as T;
}

interface Event {
  executor: string;
  standard: string;
  event: string;
  data: Record<string, unknown>[];
}

/** A NEAR transaction's final status and every NEP-297 event its receipts logged. */
async function txEvents(net: Net, hash: string, sender: string) {
  const r = await jsonRpc<{
    status: Record<string, unknown>;
    receipts_outcome: { outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }[];
  }>(NET[net].archival, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
  const events: Event[] = [];
  for (const { outcome } of r.receipts_outcome) {
    for (const log of outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      events.push({ executor: outcome.executor_id, ...(JSON.parse(log.slice("EVENT_JSON:".length)) as Omit<Event, "executor">) });
    }
  }
  return { ok: "SuccessValue" in r.status, events };
}

async function baseTxStatus(hash: string): Promise<string> {
  const r = await jsonRpc<{ status: string }>(BASE_RPC, "eth_getTransactionReceipt", [hash]);
  return r.status;
}

const results: boolean[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}\n      ${detail}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const now = () => Math.floor(Date.now() / 1000);
const pct = (rate: string) => `${(Number(rate) / 1e10).toFixed(2)} %`; // 1e12 = 100 % APR
const ago = (ts: number) => `${Math.round((now() - ts) / 60)} min ago`;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

interface Feed {
  id: number;
  name: string;
  last_ts: number;
  stale_after_secs: number;
}
interface Market {
  id: number;
  name: string;
  maturity_ts: number;
  effective_mode: string;
  mark: string;
  best_bid: number | null;
  best_ask: number | null;
}

// ------------------------------------------------------------------ checks

async function contractChecks(net: Net) {
  const swap = NET[net].swap;

  await check(`[${net}] ${swap} runs the published wasm`, async () => {
    const a = await jsonRpc<{ code_hash: string }>(NET[net].rpc, "query", { request_type: "view_account", finality: "final", account_id: swap });
    must(a.code_hash === MAINNET_CODE_HASH, `code hash ${a.code_hash}, expected ${MAINNET_CODE_HASH}`);
    return `code hash ${a.code_hash}${net === "testnet" ? " (identical to mainnet)" : ""}`;
  });

  await check(`[${net}] oracle is live: 2-of-3 signed Hyperliquid BTC funding, hourly`, async () => {
    const cfg = await view<{ signers: string[]; threshold: number }>(net, "get_config");
    must(cfg.signers.length === 3 && cfg.threshold === 2, `${cfg.threshold}-of-${cfg.signers.length} signers`);
    const feed = (await view<Feed[]>(net, "list_feeds")).find((f) => f.name === "hyperliquid:BTC");
    must(feed, "no hyperliquid:BTC feed");
    must(now() - feed.last_ts < 2 * 3600, `last rate ${ago(feed.last_ts)}: the oracle has stopped`);
    return `${cfg.threshold}-of-${cfg.signers.length} signers; last settled interval ${new Date(feed.last_ts * 1000).toISOString()} (${ago(feed.last_ts)})`;
  });

  await check(`[${net}] markets are open for trading`, async () => {
    const live = (await view<Market[]>(net, "list_markets")).filter((m) => m.maturity_ts > now() && m.effective_mode === "Active");
    must(live.length > 0, "no active market");
    return live.map((m) => `#${m.id} ${m.name} (matures ${day(m.maturity_ts)}, mark ${pct(m.mark)})`).join("; ");
  });
}

async function mainnetChecks() {
  await check("[mainnet] capped beta: native USDC collateral, 10 USDC per account, withdrawals via intents.near", async () => {
    const cfg = await view<{ collateral: string; deposit_cap: string | null; intents_contract: string | null }>("mainnet", "get_config");
    must(cfg.collateral === USDC, `collateral ${cfg.collateral}`);
    must(cfg.deposit_cap === "10000000", `deposit_cap ${cfg.deposit_cap}`);
    must(cfg.intents_contract === "intents.near", `intents_contract ${cfg.intents_contract}`);
    return `collateral ${USDC.slice(0, 8)}… (NEAR native USDC), deposit_cap 10.000000 USDC, intents_contract intents.near`;
  });

  await check("[mainnet] NEAR Intents deposit: USDC sent on Base landed as margin in one step", async () => {
    const base = await baseTxStatus("0x0dcd8688602fa6d8f66dbcbcc50170650622782a09d67be6bd24c6dd1dad6cf8");
    must(base === "0x1", `Base tx status ${base}`);
    const tx = await txEvents("mainnet", "C9fpxXrp1kNbBuP2wrGYu8nX19wFArRyQopWyiRVzTRq", "intents.near");
    const credit = tx.events.find((e) => e.executor === "fundswap.near" && e.event === "deposit");
    must(tx.ok && credit, "no deposit event from fundswap.near");
    must(credit.data[0].account_id === "trader.fundswap.near" && credit.data[0].from === "intents.near", JSON.stringify(credit.data[0]));
    return `Base 0x0dcd…6cf8 succeeded → NEAR C9fpxXrp… fundswap.near logged deposit ${Number(credit.data[0].amount) / 1e6} USDC to trader.fundswap.near, from intents.near`;
  });

  await check("[mainnet] NEAR Intents withdrawal: margin went back out to Base", async () => {
    const w = await txEvents("mainnet", "5nX6VrnXfhHidCRQATPX6KEyfJuTJYg2LSeWnGaYsy6P", "trader.fundswap.near");
    const ev = w.events.find((e) => e.executor === "fundswap.near" && e.event === "withdraw");
    must(w.ok && ev, "no withdraw event");
    const out = await txEvents("mainnet", "ExGdjrfxGuEpL8gGVk56y4pAE39Y6CNdQCgers1mZTLC", "trader.fundswap.near");
    const t = out.events.find((e) => e.event === "ft_transfer");
    must(out.ok && t, "no ft_transfer to the 1Click deposit address");
    const base = await baseTxStatus("0xc4a8aea7b54b0436283e2799136d9a6b4b5d27e8732eb6ae4b8ad10e5ed46e58");
    must(base === "0x1", `Base payout status ${base}`);
    return `withdraw ${Number(ev.data[0].amount) / 1e6} USDC (5nX6VrnX…) → ft_transfer to 1Click (ExGdjrfx…) → Base payout 0xc4a8…6e58 succeeded`;
  });

  await check("[mainnet] NEAR Intents 1Click quotes a deposit from Base into fundswap.near right now", async () => {
    const api = oneClick();
    const tokens = await api.tokens();
    const origin = findToken(tokens, "USDC", "base");
    const q = await api.quote(
      depositToSwapQuote({
        dry: true,
        origin,
        collateral: nearUsdc(tokens),
        amount: 5_000_000n,
        refundTo: "0x1111111111111111111111111111111111111111",
        swapContract: "fundswap.near",
        trader: "near",
      }),
    );
    return `dry quote: 5 USDC on Base → ${Number(q.quote.amountOut) / 1e6} USDC margin, ~${q.quote.timeEstimate}s, msg {"credit_to":"near"}`;
  });
}

async function testnetChecks() {
  await check("[testnet] market maker quotes both sides of every open market", async () => {
    const live = (await view<Market[]>("testnet", "list_markets")).filter((m) => m.maturity_ts > now() && m.effective_mode === "Active");
    const acct = await view<{ orders: unknown[] } | null>("testnet", "get_account", { account_id: "maker.fundswap-treasury.testnet" });
    must(acct && acct.orders.length > 0, "the maker has no resting orders");
    const oneSided = live.filter((m) => m.best_bid === null || m.best_ask === null);
    must(oneSided.length === 0, `no two-sided book on ${oneSided.map((m) => `#${m.id}`).join(", ")}`);
    const bp = (t: number) => `${(t / 100).toFixed(2)} %`;
    return `${acct.orders.length} resting maker orders; ${live.map((m) => `#${m.id} ${bp(m.best_bid!)} / ${bp(m.best_ask!)}`).join("; ")}`;
  });

  await check("[testnet] trades settle on the on-chain order book", async () => {
    const markets = await view<Market[]>("testnet", "list_markets");
    const trades = (
      await Promise.all(markets.map((m) => view<{ ts: number; size: string; rate: string; taker: string }[]>("testnet", "get_trades", { market_id: m.id, limit: 5 })))
    ).flat();
    must(trades.length > 0, "no trades logged");
    const last = trades.reduce((a, b) => (b.ts > a.ts ? b : a));
    return `${trades.length} recent trade${trades.length === 1 ? "" : "s"} logged on chain; latest ${Number(last.size) / 1e6} YU @ ${pct(last.rate)} by ${last.taker}, ${day(last.ts)}`;
  });

  await check("[testnet] keeper bot liquidated an under-margined account", async () => {
    const tx = await txEvents("testnet", "CKaH6c19QGDDvJRLd3z9HHErFzNGCjF7Ez2bNxGXWZNS", "keeper.fundswap-treasury.testnet");
    const ev = tx.events.find((e) => e.executor === "fundswap-lab.testnet" && e.event === "liquidation");
    must(tx.ok && ev, "no liquidation event");
    return `CKaH6c19… logged liquidation of ${ev.data[0].account_id} by ${ev.data[0].liquidator}, ${Number(ev.data[0].size) / 1e6} YU at mark ${pct(String(ev.data[0].mark))}`;
  });
}

async function appChecks() {
  await check(`[app] ${APP} serves every page`, async () => {
    const paths = ["/", "/trade", "/testnet", "/testnet/trade", "/docs"];
    const codes = await Promise.all(paths.map(async (p) => [p, (await fetch(APP + p, { signal: AbortSignal.timeout(30_000) })).status] as const));
    const bad = codes.filter(([, s]) => s !== 200);
    must(bad.length === 0, bad.map(([p, s]) => `${p} → ${s}`).join(", "));
    return codes.map(([p, s]) => `${p} ${s}`).join(", ");
  });
}

console.log("Fundswap: verifying the README's claims against the live chain (read-only)\n");
await contractChecks("mainnet");
await mainnetChecks();
await contractChecks("testnet");
await testnetChecks();
await appChecks();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
