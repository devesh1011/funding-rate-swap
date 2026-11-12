// The bytes oracle signers sign. Must match `rate_message` in the contract:
// borsh(("fundswap-rate-v1", contract_id, feed_id: u32, interval_ts: u64, rate: i128)).

const DOMAIN = "fundswap-rate-v1";

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

function le(value: bigint, bytes: number, signed: boolean): Uint8Array {
  const bits = BigInt(bytes * 8);
  const min = signed ? -(1n << (bits - 1n)) : 0n;
  const max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (value < min || value > max) throw new Error(`${value} out of range for ${bytes} bytes`);
  let v = value < 0n ? (1n << bits) + value : value;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function rateMessage(contractId: string, feedId: number, intervalTs: bigint, rate: bigint): Uint8Array {
  const parts = [
    borshString(DOMAIN),
    borshString(contractId),
    le(BigInt(feedId), 4, false),
    le(intervalTs, 8, false),
    le(rate, 16, true),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
