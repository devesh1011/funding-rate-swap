// Browser-safe access to the rate-swap contract: typed views and the unit
// conversions the trading UI needs. Amounts stay bigint until display.

import type { NetConfig } from "./config";

export const USDC = 1_000_000n; // 1 USDC (or tUSDC), also 1 YU of notional
export const RATE_ONE = 1_000_000_000_000n; // 100 % APR
export const YEAR_SECS = 31_536_000;
export const ONE_YOCTO = "1";
export const STORAGE_DEPOSIT = "100000000000000000000000"; // 0.1 NEAR
/** NEAR a wallet needs to send a deposit: prepaid gas, plus the 0.1 NEAR storage on the first one. */
export const nearNeeded = (activated: boolean) => (activated ? 20_000_000_000_000_000_000_000n : 140_000_000_000_000_000_000_000n); // 0.02 / 0.14 NEAR
export const TGAS = (n: number) => (BigInt(n) * 1_000_000_000_000n).toString();

export type Side = "Long" | "Short";
export type Kind = "Limit" | "Ioc" | "Market";
export type Mode = "Active" | "CloseOnly" | "Paused";

export interface MarketView {
  id: number;
  feed_id: number;
  name: string;
  maturity_ts: number;
  effective_mode: Mode;
  params: {
    im_factor_bps: number;
    mm_ratio_bps: number;
    rate_floor: string;
    time_floor_secs: number;
    max_dev: string;
    taker_fee_rate: string;
    oi_cap: string;
  };
  mark: string;
  last_mark_ts: number;
  long_oi: string;
  final_cum: string | null;
  best_bid: number | null;
  best_ask: number | null;
  volume_24h: string;
}

export interface TradeRecord {
  ts: number;
  market_id: number;
  taker_side: Side;
  taker: string;
  maker: string;
  size: string;
  rate: string;
  liquidation: boolean;
}

export interface Candle {
  hour_ts: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

export interface Level {
  tick: number;
  size: string;
  orders: number;
}

export interface OrderView {
  id: string;
  owner: string;
  market_id: number;
  side: Side;
  tick: number;
  remaining: string;
}

export interface PositionView {
  market_id: number;
  n: string;
  fixed_flow: string;
  avg_rate: string | null;
  value: string;
  initial_margin: string;
  secs_left: number;
}

export interface Health {
  cash: string;
  value: string;
  net: string;
  initial_margin: string;
  maintenance_margin: string;
  liquidatable: boolean;
  withdrawable: string;
}

export interface AccountView {
  account_id: string;
  cash: string;
  storage_paid: boolean;
  positions: PositionView[];
  orders: OrderView[];
  health: Health;
}

export interface FeedView {
  id: number;
  name: string;
  last_ts: number;
  stale_after_secs: number;
}

/** RPC `query` with failover: a rate limit or network error tries the next of the network's RPCs. */
async function query<T>(rpcs: string[], params: object): Promise<T> {
  let last: Error = new Error("no rpc");
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "optimistic", ...params } }),
      });
      const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string } };
      if (body.result) return body.result;
      last = new Error(body.error?.cause?.name ?? body.error?.message ?? `rpc ${res.status}`);
      if (body.error?.cause?.name === "CONTRACT_EXECUTION_ERROR") throw last;
    } catch (e) {
      last = e as Error;
      if (/CONTRACT_EXECUTION_ERROR/.test(last.message)) throw last;
    }
  }
  throw last;
}

/** Contract view call. */
async function view<T>(rpcs: string[], contractId: string, method: string, args: object = {}): Promise<T> {
  const r = await query<{ result: number[] }>(rpcs, {
    request_type: "call_function",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

/** NEAR an account can spend: its balance minus what its own storage locks (1e19 yoctoNEAR per byte). */
async function nearAvailable(rpcs: string[], account_id: string): Promise<bigint> {
  const a = await query<{ amount: string; storage_usage: number }>(rpcs, { request_type: "view_account", account_id });
  const free = BigInt(a.amount) - BigInt(a.storage_usage) * 10_000_000_000_000_000_000n;
  return free > 0n ? free : 0n;
}

/** Per-wallet reads on one network; shared market data comes from /api/live. */
export const swapReads = (c: NetConfig) => ({
  account: (account_id: string) => view<AccountView | null>(c.rpc, c.swap, "get_account", { account_id }),
  accountTrades: (account_id: string, limit = 40) => view<TradeRecord[]>(c.rpc, c.swap, "get_account_trades", { account_id, limit }),
  tokenBalance: (account_id: string) => view<string>(c.rpc, c.collateral, "ft_balance_of", { account_id }),
  nearBalance: (account_id: string) => nearAvailable(c.rpc, account_id),
});

// ---------------------------------------------------------------- units

/** "1,234.5" → 1234500000n (6 decimals). Returns null for anything that isn't a plain decimal. */
export function parseUsdc(input: string): bigint | null {
  const s = input.replaceAll(",", "").trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * USDC + BigInt(frac.padEnd(6, "0"));
}

export const toNum = (raw: string | bigint) => Number(BigInt(raw)) / 1e6;
export const rateToPct = (rate: string | bigint) => Number(BigInt(rate)) / 1e10;
export const tickToPct = (tick: number) => tick / 100;
/** APR percent → tick (1 tick = 1 bp), or null if not on the tick grid. */
export function pctToTick(input: string): number | null {
  const s = input.trim();
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Initial margin the contract will require for |size| at `ratePct`, in USDC (mirrors math::initial_margin). */
export function initialMargin(m: MarketView, size: bigint, ratePct: number, nowSec: number): number {
  const secsLeft = Math.max(0, m.maturity_ts - nowSec);
  const tau = Math.max(secsLeft, m.params.time_floor_secs) / YEAR_SECS;
  const rate = Math.max(Math.abs(ratePct) / 100, rateToPct(m.params.rate_floor) / 100);
  return (m.params.im_factor_bps / 10_000) * toNum(size < 0n ? -size : size) * tau * rate;
}

/** Taker fee for |size| over the remaining term, in USDC. */
export function takerFee(m: MarketView, size: bigint, nowSec: number): number {
  const tau = Math.max(0, m.maturity_ts - nowSec) / YEAR_SECS;
  return toNum(size < 0n ? -size : size) * (rateToPct(m.params.taker_fee_rate) / 100) * tau;
}

/** "BTC funding · 22 Nov 2026" → "22 Nov" */
export const shortName = (m: { name: string }) => m.name.split("·")[1]?.trim().split(" ").slice(0, 2).join(" ") ?? m.name;

// ---------------------------------------------------------------- pre-trade estimates

export interface FillEstimate {
  /** YU that would fill now against the book. */
  filled: number;
  /** Size-weighted fill rate, percent APR (null if nothing fills). */
  avgPct: number | null;
  /** Distance of the average fill from the best quote, percent APR. */
  slippagePct: number;
  /** Σ size × rate of the fills, in YU·fraction (adds to fixed_flow). */
  fixedFlow: number;
}

/** Walk the opposite side of the book like the contract's matcher does. */
export function estimateFill(levels: Level[], side: Side, sizeYu: number, limitTick: number | null): FillEstimate {
  let left = sizeYu;
  let filled = 0;
  let flow = 0;
  for (const l of levels) {
    if (left <= 0) break;
    if (limitTick !== null && (side === "Long" ? l.tick > limitTick : l.tick < limitTick)) break;
    const q = Math.min(left, toNum(l.size));
    filled += q;
    flow += (q * l.tick) / 10_000;
    left -= q;
  }
  const avg = filled ? (flow / filled) * 100 : null;
  const best = levels[0] ? tickToPct(levels[0].tick) : null;
  return {
    filled,
    avgPct: avg,
    slippagePct: avg !== null && best !== null ? Math.abs(avg - best) : 0,
    fixedFlow: flow,
  };
}

/**
 * The marks (percent APR) at which this account would reach maintenance
 * margin, holding everything else fixed, after adding `dn` YU at fixed flow
 * `dFlow` to its position in `m`. Mirrors the contract:
 * value = (n·mark − fixed_flow)·τ, MM = mm_ratio · IMf · |n| · max(τ, τ_floor) · max(|mark|, floor).
 * Margin grows with |mark|, so either direction can liquidate: a long mostly
 * when the rate falls, but also if it climbs far enough. Each side is null
 * when nothing within ±200 % APR of the mark liquidates.
 */
export function liquidationRates(
  m: MarketView,
  account: AccountView | null | undefined,
  dn: number,
  dFlow: number,
  cashDelta: number,
  nowSec: number,
): { below: number | null; above: number | null } | null {
  const pos = account?.positions.find((p) => p.market_id === m.id);
  const n0 = pos ? toNum(pos.n) : 0;
  const flow0 = pos ? Number(BigInt(pos.fixed_flow)) / 1e18 : 0;
  const n = n0 + dn;
  if (Math.abs(n) < 1e-9) return null;
  const flow = flow0 + dFlow;
  const secsLeft = Math.max(0, m.maturity_ts - nowSec);
  const tau = secsLeft / YEAR_SECS;
  const tauIm = Math.max(secsLeft, m.params.time_floor_secs) / YEAR_SECS;
  const floor = rateToPct(m.params.rate_floor) / 100;
  const imf = m.params.im_factor_bps / 10_000;
  const mmr = m.params.mm_ratio_bps / 10_000;
  const mark0 = rateToPct(m.mark) / 100;
  const h = account?.health;
  // Everything except this market's position, at today's mark.
  const thisValue0 = (n0 * mark0 - flow0) * tau;
  const thisMm0 = n0 ? mmr * imf * Math.abs(n0) * tauIm * Math.max(Math.abs(mark0), floor) : 0;
  const otherNet = (h ? toNum(h.net) : 0) - thisValue0 + cashDelta;
  const otherMm = (h ? toNum(h.maintenance_margin) : 0) - thisMm0;
  const gap = (r: number) => otherNet + (n * r - flow) * tau - (otherMm + mmr * imf * Math.abs(n) * tauIm * Math.max(Math.abs(r), floor));
  if (gap(mark0) <= 0) return { below: mark0 * 100, above: mark0 * 100 };
  const search = (dir: 1 | -1) => {
    // gap is piecewise linear in r: scan in 0.5 % steps, then bisect the first crossing.
    for (let k = 1; k <= 400; k++) {
      const r = mark0 + (dir * k) / 200;
      if (gap(r) <= 0) {
        let safe = mark0 + (dir * (k - 1)) / 200;
        let bad = r;
        for (let i = 0; i < 40; i++) {
          const mid = (safe + bad) / 2;
          if (gap(mid) > 0) safe = mid;
          else bad = mid;
        }
        return bad * 100;
      }
    }
    return null;
  };
  return { below: search(-1), above: search(1) };
}
