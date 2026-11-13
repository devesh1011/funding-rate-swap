# Fundswap: funding-rate swaps on NEAR

Fundswap is an on-chain market for trading **perpetual funding rates**. A trader takes a fixed rate against the floating Hyperliquid BTC funding rate, paid hourly, until a fixed maturity. The contract is written in Rust and deployed on NEAR mainnet (`fundswap.near`) and testnet (`fundswap-lab.testnet`). Margin can come from any chain through **NEAR Intents**.

- **Live app:** https://fundswap-drab.vercel.app (mainnet at `/` and `/trade`, testnet at `/testnet` and `/testnet/trade`)
- **Track:** `defi`. Hints used: **TRADING** and **NEAR INTENTS**. Chain Signatures are not used. Also uses NEAR function-call access keys for one-click trading.
- Every transaction in this README and in [`docs/deployments.md`](docs/deployments.md) is real. Nothing in the app is mocked.

## Problem

Perp funding is the largest yield source in crypto, and the most volatile. A BTC basis trade (long spot, short perp) earns funding, but the rate swings from +30 % APR to negative within hours. There is no on-chain way to lock that rate in, or to bet on its direction without taking price exposure. Pendle Boros does this on Arbitrum. Nothing comparable exists on NEAR.

## What it does

- **Instrument.** One *yield unit* (YU) is the funding paid on 1 USDC of BTC notional on Hyperliquid, from now until maturity.
  - **Long YU** pays a fixed APR and receives the floating funding: you profit if funding rises.
  - **Short YU** receives the fixed APR and pays floating: you lock in today's rate.
- **Order book.** The book is on-chain and quoted in implied APR, with 1 bp ticks. There are limit and market orders.
- **Margin.** Cross margin in one NEP-141 stablecoin: native USDC on mainnet, tUSDC on testnet.
  - Initial margin scales with |rate| × time to maturity.
  - Margin is maintained at 0.66 × initial margin.
  - Liquidation applies a scaled penalty and can trigger in either rate direction.
- **Settlement.** The contract settles lazily every hour against a **2-of-3 ed25519-signed** feed of Hyperliquid BTC funding, which the oracle bot submits. A feed with no rate for 3 hours puts the market in close-only mode.
- **Bots** (Node, on AWS EC2 under systemd):
  - **oracle:** signs and submits each hour.
  - **maker:** quotes a 5-level ladder around a 7-day fair rate (testnet).
  - **keeper:** liquidates unhealthy accounts.
- **One-click trading with a function-call access key.** The wallet adds, once, a key that may only call `place_order`, `cancel_order` and `cancel_all` on the contract, with a 0.5 NEAR gas allowance. The browser signs orders with it, so there is no wallet prompt per order. The key **cannot withdraw**: `withdraw` requires 1 yoctoNEAR, and NEAR rejects any deposit from a function-call key (tested on testnet: "Deposit is not allowed with function call"). The key is stored per account and network, only after it is confirmed on chain, and **Turn off** deletes it from the account.
- **NEAR Intents (1Click), mainnet only:**
  - **Deposit in one step from Base, Arbitrum, Ethereum or Solana.** 1Click delivers NEAR USDC to the contract with `ft_transfer_call` and `msg = {"credit_to":"<your account>"}`, so it lands directly in your margin.
  - **Withdraw to any chain**, including a Hyperliquid perp balance. `withdraw` is followed by `storage_deposit` + `ft_transfer` to the 1Click deposit address, all in one transaction.

## Try it (do X → see Y)

### Testnet: full trading loop, free

You need a NEAR testnet wallet (for example Meteor or MyNearWallet, with a `.testnet` account).

1. Open https://fundswap-drab.vercel.app/testnet/trade → you see the BTC funding markets, a live order book from the maker bot, the implied-APR chart and the latest oracle rate.
2. Click **Connect wallet** and choose your wallet → the header shows your account.
3. Click **Deposit**, then **Get 10,000 test tUSDC first** → a toast links the faucet transaction, and *Wallet tUSDC* shows 10,000.
4. Enter an amount and click **Activate & deposit** (one wallet prompt: 0.1 NEAR storage + `ft_transfer_call`) → *Net balance* in the account card goes up.
5. In the ticket, pick **Long** or **Short**, enter a size (e.g. 1,000 YU) and submit a market order → you see a fill toast with a nearblocks link. The trade appears under **Market trades**, and the position appears under **Positions** with its average fixed rate, mark, value and initial margin.
6. Wait for the next hour → the oracle posts the new rate (*Oracle* panel), and the account card's *Net balance* moves by the hourly funding.
7. Under the ticket, click **Enable** next to *1-click trading* and approve the one wallet prompt (it adds a function-call key) → the toggle shows *on*.
8. Submit another order → it fills with no wallet prompt; the toast still links the nearblocks transaction, signed by the limited key.
9. Click **Close** on the position, then **Withdraw** → **Withdraw** still asks your wallet, because the limited key can't move funds. The tUSDC returns to your wallet.

### Mainnet: NEAR Intents deposit, real money

The mainnet deployment is a capped beta: 10 USDC per account, and there is no market maker. You can rest orders but not get fills unless someone takes the other side.

1. Open https://fundswap-drab.vercel.app → the landing page shows live mainnet data, including a live 1Click quote for "USDC on Base → your margin".
2. Go to `/trade`, connect a mainnet wallet, and click **Deposit → Transfer** → the dialog quotes a deposit from Base, Arbitrum, Ethereum or Solana through 1Click.
3. Send USDC to the deposit address shown → the dialog tracks the 1Click status, and once it reports `SUCCESS` your margin is credited. No separate NEAR transaction is needed.

The same flow was run end to end on 2026-11-12:
- Base → margin: 2 USDC sent on Base, 1.999796 credited.
- Order placed and cancelled.
- Withdraw → Base: 1.997192 received.

Every hash is in [`docs/deployments.md`](docs/deployments.md#near-intents-round-trip-2026-11-12-mainnet-real-usdc).

### Verify on-chain without the UI

```bash
near contract call-function as-read-only fundswap-lab.testnet get_market json-args '{"market_id":1}' network-config testnet now
near contract call-function as-read-only fundswap-lab.testnet get_trades json-args '{"market_id":1}' network-config testnet now
near contract call-function as-read-only fundswap.near get_market json-args '{"market_id":0}' network-config mainnet now
```

→ The first call returns the market's mark rate (1e12 = 100 % APR), best bid and ask in bp, open interest (`long_oi`), `volume_24h` and mode. The second returns the last trades with taker, maker, size and rate.

## Repository layout

| Path | What |
| --- | --- |
| [`contracts/rate-swap`](contracts/rate-swap) | The Rust contract (near-sdk 5.30.1): order book, margin, settlement, liquidation, trade log and hourly candles, `ft_on_transfer` with `credit_to`, and withdrawals into `intents.near` |
| [`contracts/test-token`](contracts/test-token) | A NEP-141 token for the sandbox tests |
| [`bots`](bots) | The oracle, maker and keeper bots (TypeScript, near-api-js), with systemd units and a deploy script in `bots/deploy` |
| [`intents`](intents) | The 1Click client (plain `fetch`, shared with the web app), plus scripts for live quotes and the guarded mainnet round trip |
| [`client`](client) | The Next.js 16 app: landing page and trading UI, wallet connection via near-connect, and cross-chain deposit and withdraw |
| [`docs/deployments.md`](docs/deployments.md) | Every deployed account and transaction hash, on testnet and mainnet |
| [`plan.md`](plan.md) | The build plan and phase status |

## Deployed

| | Testnet | Mainnet |
| --- | --- | --- |
| Contract | `fundswap-lab.testnet` | `fundswap.near` (code hash `56e7ZTwA1FmubY3Rk1N7Rd3tGwojt5Tmqksq87zrAujs`, same wasm) |
| Collateral | `tusdc.token.primitives.testnet` | native USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Governance | `gov.fundswap-lab.testnet` | `gov.fundswap.near` |
| Bots | oracle, maker, keeper | oracle |

## Run it locally

You need Node ≥ 24, pnpm 11, Rust with `wasm32-unknown-unknown`, and `cargo-near`.

```bash
pnpm install

# contract
cd contracts/rate-swap
cargo test --lib                    # 41 unit tests
cargo test --test sandbox           # end to end on a local NEAR node (~1 min)
cargo near build non-reproducible-wasm
cd ../..

# 1Click client: unit tests, then live dry quotes (no funds move)
pnpm --filter @fundswap/intents test
pnpm --filter @fundswap/intents quotes

# bots: unit tests; running them needs signer keys in bots/.env (see bots/README.md)
pnpm --filter @fundswap/bots test

# web app against the live deployments
pnpm --filter @fundswap/client dev   # http://localhost:3000
```

The faucet route (`/api/faucet`) needs a testnet treasury key in `client/.env.local`. Everything else in the app reads public RPC.

## Trust model and limits

This is a hackathon build, and these limits are disclosed rather than hidden:

- **Oracle:** the team runs all three oracle signers. The 2-of-3 threshold guards against one leaked key, not against the team.
- **Governance:** a single key (`gov.*`), with no DAO or timelock.
- **Mainnet cap:** 10 USDC per account, with a 100,000 YU open-interest cap. Deposits over the cap are forwarded to `intents.near` instead of being held.
- **Testnet liquidation demo:** the liquidation on testnet was staged between demo accounts so a judge can see the keeper act. Every step is a real transaction, listed in `docs/deployments.md`.
- **Mainnet liquidity:** mainnet has no maker. Testnet is the place to trade.
- **NEAR Intents** runs on mainnet only, so the Transfer tab on testnet points to mainnet.

## Built with

- **Contract:**
  - near-sdk 5.30.1.
  - Tests use near-sandbox 0.4 and near-api 0.8.
  - Built with cargo-near.
- **Bots and intents:** near-api-js 7.4.0, Node 24 built-in TypeScript, `node:test`.
- **App:**
  - Next.js 16.4.6, React 19.3, Tailwind CSS 4.3.3.
  - Wallet: near-connect-hooks 1.1.6 and HOT's @hot-labs/near-connect 0.11.4 (HOT is a hackathon partner).
  - Fonts: Inter and Instrument Serif.
- **External APIs:**
  - [NEAR Intents 1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api).
  - Hyperliquid info API (`fundingHistory`).
  - NEAR RPC: FastNEAR, dRPC, Intea.
  - Nearblocks.
- **Hosting:** Vercel (app), AWS EC2 t4g.small (bots).
- **AI assistance:** most of the code, tests and docs were written with Claude Code (Anthropic), directed and reviewed by the author. Every mainnet transaction was approved individually by the author.

No pre-hackathon code: the repository starts on 2026-11-12, inside the hackathon window.

## License

[MIT](LICENSE)
