const MINUS = "−";

export function pct(x: number, digits = 2): string {
  const s = Math.abs(x).toFixed(digits);
  return `${x < 0 && Number(s) !== 0 ? MINUS : ""}${s}%`;
}

export function signedPct(x: number, digits = 2): string {
  return `${x >= 0 ? "+" : MINUS}${Math.abs(x).toFixed(digits)}%`;
}

export function usd(x: number, digits = 2): string {
  return `${x < 0 ? MINUS : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function signedUsd(x: number): string {
  return `${x >= 0 ? "+" : MINUS} $${Math.abs(x).toFixed(2)}`;
}

export function usdCompact(x: number): string {
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${Math.round(x / 1e3)}K`;
  return `$${Math.round(x)}`;
}

export function int(x: number): string {
  return Math.round(x).toLocaleString("en-US");
}

export function hourUtc(ts: number): string {
  return `${String(new Date(ts * 1000).getUTCHours()).padStart(2, "0")}:00`;
}

export function timeUtc(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 19);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "22 Nov" */
export function dayMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "22 Nov 2026" */
export function date(ts: number): string {
  return `${dayMonth(ts)} ${new Date(ts * 1000).getUTCFullYear()}`;
}

/** "NOV 18" */
export function monthDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${MONTHS[d.getUTCMonth()].toUpperCase()} ${d.getUTCDate()}`;
}

export function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-3)}`;
}
