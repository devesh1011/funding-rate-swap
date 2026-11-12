import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rateMessage } from "../src/lib/message.ts";
import { aprToTick, formatPct, hlRateToContract, hourlyToApr, parseScaled, tickToApr } from "../src/lib/units.ts";

test("Hyperliquid fundingRate is one hourly payment: 0.0001 → 0.01 % → 1e8", () => {
  assert.equal(hlRateToContract("0.0001"), 100_000_000n);
  assert.equal(hlRateToContract("0.0000098466"), 9_846_600n);
  assert.equal(hlRateToContract("-0.0000051293"), -5_129_300n);
  assert.equal(hlRateToContract("0.04"), 40_000_000_000n); // the 4 %/h cap = contract clamp
});

test("parseScaled is exact and refuses lossy input", () => {
  assert.equal(parseScaled("1.5", 6), 1_500_000n);
  assert.equal(parseScaled("0.0000000000010", 12), 1n);
  assert.throws(() => parseScaled("0.0000000000001", 12));
  assert.throws(() => parseScaled("1e-5", 12));
});

test("APR and ticks", () => {
  const base = hlRateToContract("0.0000125"); // 0.00125 %/h baseline
  assert.equal(hourlyToApr(base), 109_500_000_000n); // 10.95 %
  assert.equal(formatPct(hourlyToApr(base)), "10.95%");
  assert.equal(aprToTick(109_500_000_000n), 1095);
  assert.equal(aprToTick(-109_550_000_000n), -1096);
  assert.equal(tickToApr(1095), 109_500_000_000n);
});

test("rate message matches the contract's pinned test vector", () => {
  const m = rateMessage("swap.testnet", 0, 1_800_003_600n, 12_500_000n);
  assert.equal(
    Buffer.from(m).toString("hex"),
    "1000000066756e64737761702d726174652d76310c000000737761702e746573746e65740000000010e0496b0000000020bcbe00000000000000000000000000",
  );
});

test("rate message encodes negative rates as two's complement i128", () => {
  const m = rateMessage("a", 1, 0n, -1n);
  assert.equal(Buffer.from(m.subarray(-16)).toString("hex"), "ff".repeat(16));
});
