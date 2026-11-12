// Fixed-point units shared with the contract (contracts/rate-swap/src/math.rs).
// Rates, APRs and the funding index: 1e12 = 100 %. Token amounts: 1e6 = 1 USDC.
// Ticks: 1 tick = 1 bp of APR. Everything is bigint; no floats touch a value
// that goes on-chain.

export const RATE_ONE = 1_000_000_000_000n;
export const TICK = RATE_ONE / 10_000n;
export const USDC = 1_000_000n;
export const HOURS_PER_YEAR = 8_760n;

/** Exact decimal string → bigint scaled by 10^decimals. Rejects anything finer. */
export function parseScaled(value: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a decimal: ${value}`);
  const [, neg, int, frac = ""] = m;
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) {
    throw new Error(`${value} has more than ${decimals} decimals`);
  }
  const scaled = BigInt(int + frac.slice(0, decimals).padEnd(decimals, "0"));
  return neg ? -scaled : scaled;
}

/** Hyperliquid `fundingRate` (fraction paid for one hourly payment) → contract rate. */
export function hlRateToContract(fundingRate: string): bigint {
  return parseScaled(fundingRate, 12);
}

/** Per-hour fraction → APR, both 1e12-scaled. */
export function hourlyToApr(rate: bigint): bigint {
  return rate * HOURS_PER_YEAR;
}

export function aprToTick(apr: bigint): number {
  // Round half away from zero to the nearest bp.
  const half = TICK / 2n;
  const t = apr >= 0n ? (apr + half) / TICK : -((-apr + half) / TICK);
  return Number(t);
}

export function tickToApr(tick: number): bigint {
  return BigInt(tick) * TICK;
}

export function formatPct(rate: bigint, digits = 2): string {
  const neg = rate < 0n;
  const abs = neg ? -rate : rate;
  const scale = 10n ** BigInt(digits);
  const v = (abs * 100n * scale + RATE_ONE / 2n) / RATE_ONE;
  const s = `${v / scale}.${(v % scale).toString().padStart(digits, "0")}`;
  return `${neg ? "-" : ""}${s}%`;
}

export function formatUsdc(amount: bigint): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  return `${neg ? "-" : ""}${abs / USDC}.${(abs % USDC).toString().padStart(6, "0")}`;
}
