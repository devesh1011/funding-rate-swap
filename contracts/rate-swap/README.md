# rate-swap contract

Funding-rate swap market on NEAR: an on-chain order book in implied APR, cross margin in one NEP-141 stablecoin, lazy hourly settlement against a k-of-n signed Hyperliquid funding feed, liquidation with a scaled penalty, and withdrawals to the caller or into NEAR Intents.

- `src/math.rs` holds the fixed-point maths and its worked-example tests.
- `src/types.rs` holds the stored state, the JSON inputs and views, and every loop bound.
- `src/lib.rs` holds the contract methods.
- `src/tests.rs` holds the unit tests (mocked runtime, real ed25519 signatures).
- `tests/sandbox.rs` runs end to end on a local node against a real token (`../test-token`).

```bash
cargo test --lib                    # 41 unit tests
cargo test --test sandbox           # local-node end to end (~1 min)
cargo near build non-reproducible-wasm
```

Units: token amounts in base units (1e6 = 1 USDC). Rates, APRs and the funding index use 1e12 = 100 %. Ticks are 1 bp of APR.

The deployed addresses are in [`../../docs/deployments.md`](../../docs/deployments.md).
