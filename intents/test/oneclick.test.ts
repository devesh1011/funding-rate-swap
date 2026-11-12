import assert from "node:assert/strict";
import { test } from "node:test";
import {
  creditToMsg,
  depositToSwapQuote,
  hyperliquidUsdc,
  isNearAccountId,
  nep141Contract,
  withdrawFromNearQuote,
  type Token,
} from "../src/oneclick.ts";

const tok = (assetId: string, blockchain: string, decimals = 6): Token => ({ assetId, blockchain, decimals, symbol: "USDC", price: 1 });
const NEAR = tok("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "near");
const ARB = tok("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", "arb");

test("one-step deposit sends ft_transfer_call to the contract crediting the trader", () => {
  const q = depositToSwapQuote({ dry: true, origin: ARB, collateral: NEAR, amount: 2_000_000n, refundTo: "0xabc", swapContract: "fundswap.near", trader: "alice.near" });
  assert.equal(q.recipient, "fundswap.near");
  assert.equal(q.recipientType, "DESTINATION_CHAIN");
  assert.equal(q.destinationAsset, NEAR.assetId);
  assert.deepEqual(JSON.parse(q.customRecipientMsg!), { credit_to: "alice.near" });
  assert.equal(q.amount, "2000000");
});

test("trader must be a NEAR account id, so the msg can't carry anything else", () => {
  for (const bad of ['alice.near","insurance":true', "Alice.near", "a", "x".repeat(65), ""]) {
    assert.throws(() => depositToSwapQuote({ dry: true, origin: ARB, collateral: NEAR, amount: 1n, refundTo: "0x", swapContract: "s.near", trader: bad }));
  }
  assert.ok(isNearAccountId("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
  assert.equal(creditToMsg("bob.near"), '{"credit_to":"bob.near"}');
});

test("withdraw leg refunds to the trader's NEAR account", () => {
  const q = withdrawFromNearQuote({ dry: true, collateral: NEAR, destination: ARB, amount: 5n, recipient: "0xdef", trader: "alice.near" });
  assert.equal(q.originAsset, NEAR.assetId);
  assert.equal(q.refundTo, "alice.near");
  assert.equal(q.customRecipientMsg, undefined);
});

test("asset helpers", () => {
  assert.equal(nep141Contract(NEAR.assetId), "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.throws(() => nep141Contract("1cs_v1:hypercore:hip1:0x6d"));
  const hl = hyperliquidUsdc([tok("1cs_v1:hypercore:erc20:0xb8", "hypercore"), tok("1cs_v1:hypercore:hip1:0x6d", "hypercore", 8)]);
  assert.equal(hl.decimals, 8);
});
