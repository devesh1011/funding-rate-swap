import { config } from "./config.ts";
import { hlRateToContract } from "./units.ts";

/** One settled Hyperliquid funding payment, keyed the way the contract keys intervals. */
export interface FundingPoint {
  /** Funding timestamp rounded down to the hour, in seconds: the end of the interval it pays. */
  intervalTs: bigint;
  /** Fraction paid for that hourly payment, 1e12 scale. */
  rate: bigint;
  /** Raw API string, for logs. */
  raw: string;
}

interface RawFunding {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

/**
 * Settled funding for `coin` from `startSec` (inclusive). Hyperliquid stamps
 * payments a few ms after the hour (e.g. 1794474000048), so the interval key
 * is the timestamp floored to the hour.
 */
export async function fundingHistory(coin: string, startSec: bigint, endSec?: bigint): Promise<FundingPoint[]> {
  const body: Record<string, unknown> = { type: "fundingHistory", coin, startTime: Number(startSec) * 1000 };
  if (endSec !== undefined) body.endTime = Number(endSec) * 1000;
  const res = await fetch(config.hyperliquidUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as RawFunding[];
  return rows
    .filter((r) => r.coin === coin)
    .map((r) => ({
      intervalTs: (BigInt(r.time) / 3_600_000n) * 3_600n,
      rate: hlRateToContract(r.fundingRate),
      raw: r.fundingRate,
    }));
}
