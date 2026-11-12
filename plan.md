# Funding-rate swap on NEAR: build plan

A Boros-style market where perp traders swap floating funding for a fixed rate. The exchange logic lives in one NEAR contract. A real oracle feeds it Hyperliquid funding. NEAR Intents carries collateral in and out. A Next.js app drives it all.

- Track: `defi` (NEAR Intents, trading)
- Deadline: **2026-11-14T23:59:00Z** (repo public, X post up, submission sent)
- Design source: Notion page "Funding-rate swap on NEAR". This plan cuts it down to what ships by the deadline.

---

## 0. The "no mocks" rule

Every state change is a real transaction on a real chain. Every data point comes from its real source. Concretely:

| Thing | What is real | Not allowed |
| --- | --- | --- |
| Collateral | A NEP-141 token deployed on NEAR testnet, moved with `ft_transfer_call` | In-memory balances, a "deposit" button that only writes to a DB |
| Trades, settlement, liquidation | Contract calls on testnet, signed by the user's wallet or session key | Client-side matching, simulated fills |
| Funding rate | Pulled from Hyperliquid's public mainnet `info` API, signed by oracle keys, submitted on-chain | Hard-coded or random rates |
| Order book liquidity | A market-maker bot with its own testnet account placing real orders | Fake depth rendered by the UI |
| Liquidations | A keeper bot with its own account calling `liquidate` | |
| Intents | Real 1Click API calls; live deposits and withdrawals on **mainnet** (see below) | Canned API responses |
| UI data | Read from the contract through RPC view calls, or from the 1Click status API | Fixtures, seeded JSON |

**One exception we can't avoid: NEAR Intents has no testnet** (hackathon rule Q-007). So phase 3 runs a second deployment of the same contract on **mainnet**, with hard deposit caps and tiny amounts. Everything else runs on testnet. Each mainnet deploy and each spend of real tokens needs your explicit sign-off at the moment it happens.

**Testnet collateral.** We deploy our own testnet USDC (`tusdc`, 6 decimals) through NEAR's FT factory (`token.primitives.testnet`, documented in `/primitives/ft/ft`). It is a real NEP-141 token. Users get it from a faucet route that sends a real `ft_transfer` from the treasury account, rate-limited per account. The contract takes the collateral token ID at `init`, so the mainnet deployment uses real USDC with no code change.

---

## 1. Scope

### In (shipped by the deadline)

- One contract, many markets. Launch with **BTC funding on Hyperliquid**, in two maturities: a short one (about 24 h, so judges see a full lifecycle) and a 7-day one.
- On-chain limit order book with rate-time priority, bounded matching, market orders, cancel.
- Cross margin in USDC. Initial and maintenance margin with rate and time floors.
- Lazy hourly funding settlement through a cumulative index.
- Mark rate (time-weighted EMA of trades), rate bounds on taker fills.
- Liquidation with a scaled penalty, an insurance fund, and bad debt absorbed by the insurance fund.
- Market modes: `Active`, `CloseOnly` (set automatically when the oracle goes stale), `Paused`.
- k-of-n signed funding oracle with ordered, never-rewritten intervals and a rate clamp.
- Withdrawals with debit-first and restore-on-failure callbacks; `withdraw_to_intents` on mainnet.
- Bots: oracle submitter with signers, market maker, liquidation keeper.
- Intents: live dry-run quotes, mainnet deposit into margin, withdrawal through `intents.near`, funding a Hyperliquid perp account.
- Next.js client: wallet login, faucet, deposit, trade, positions, withdraw, Intents screens, a session key for trading without wallet popups.

### Out (disclosed in the README as future work)

Isolated margin, auto-deleveraging, spread markets, order purging by third parties, incentives and referrals, the Chain Signatures vault, iOS, and a meta-transaction relayer (stretch goal, see 5.6). A multisig for governance is also out; a single governance key is disclosed as a risk.

---

## 2. Networks, accounts, keys

| Account | Network | Role | Key handling |
| --- | --- | --- | --- |
| `fundswap-lab.testnet` ✅ deployed | testnet | Rate-swap contract | Full key in `~/.near-credentials`, never in the repo |
| `tusdc.token.primitives.testnet` ✅ | testnet | Collateral token | Created through the factory |
| `fundswap-treasury.testnet` ✅ | testnet | Holds the tUSDC supply, pays the faucet | Key in client server env (`FAUCET_PRIVATE_KEY`) |
| `gov.fundswap-lab.testnet` ✅ | testnet | Governance: markets, params, signers, modes (single key, disclosed) | `~/.near-credentials` |
| `oracle.<owner>.testnet` | testnet + mainnet | Submits signed rates (needs only gas) | Bot env |
| 3 signer keypairs | n/a | ed25519 keys that sign `(feed, interval, rate)`. Not accounts. | Bot env; public keys stored in the contract |
| `maker.<owner>.testnet` | testnet | Market-maker bot | Bot env |
| `keeper.<owner>.testnet` | testnet | Liquidation keeper | Bot env |
| `<name>.near` | mainnet | Mainnet contract for the Intents leg | **Needs your sign-off to create and deploy** |

Testnet NEAR comes from the faucet (`near create-account <id> --useFaucet --networkId testnet`, `/getting-started/faucet`). Secrets go in `.env` files that are git-ignored. `.env.example` files list the names only.

---

## 3. Repository layout

```
funding-rate-swap/
├── plan.md
├── README.md                 judge-facing: what it is, "do X → see Y", trust model, deployed addresses
├── LICENSE                   MIT
├── contracts/rate-swap/      Rust, near-sdk, cargo-near
│   ├── src/                  lib.rs, math.rs, book.rs, margin.rs, oracle.rs, intents.rs, views.rs
│   └── tests/                near-sandbox integration tests
├── bots/                     TypeScript (Node), near-api-js
│   ├── src/oracle/           fetch → sign → submit
│   ├── src/maker/            two-sided quotes around the oracle rate
│   ├── src/keeper/           health scan → liquidate
│   └── src/lib/              shared NEAR client, contract bindings, units
├── intents/                  TypeScript library + scripts for 1Click (used by the client and the scripts)
│   ├── src/                  quote, submit deposit, status polling, asset lookup
│   └── scripts/              mainnet round-trip script (runs only with your confirmation)
└── client/                   Next.js (latest, App Router), @hot-labs/near-connect, near-api-js
```

Shared units and contract types live in one place (`bots/src/lib` is re-exported to `client` through a small workspace package) so no TypeScript code re-declares the fixed-point maths. A pnpm workspace ties the three TS packages together.

---

## 4. Phase 1: the contract (`contracts/rate-swap`)

Scaffold with `cargo near new`, using the latest stable `near-sdk` (`/tools/sdk`). Build with `cargo near build`. Test with `cargo test` against `near-sandbox` and `near-api` (`/smart-contracts/testing/integration-test`).

### 4.1 Units and fixed-point

| Quantity | Type | Scale |
| --- | --- | --- |
| USDC amounts, notional `N`, margin | `i128` / `u128` | 1e6 (token decimals) |
| Rates (funding per interval, APR, fixed rate `f`) | `i128` | 1e12 (so 0.00125% per hour = 12_500_000) |
| Cumulative funding index `cum_float` | `i128` | 1e12, summed per-interval fractions |
| Time | `u64` | seconds (from `env::block_timestamp() / 1e9`) |
| Order price | `i32` tick | 1 tick = 1 bp APR; ticks are APR × 10_000 |

All multiplications go through `i128` checked helpers in `math.rs` that round against the trader, so the contract never pays out dust it doesn't hold. A unit test pins every formula below to a hand-computed value.

### 4.2 Maths (from the design page)

```
per interval k:   pnl_k  = N × (r_k − f × Δt_k / YEAR)
lazy settle:      owed   = N × ((cum_float_now − cum_snapshot) − f × (t_now − t_snapshot) / YEAR)
unrealized:       upnl   = N × (mark − f) × max(T_maturity − t_now, 0) / YEAR
net balance:      cash + upnl
initial margin:   IM     = IMf × |N| × max(τ, τ_floor) × max(|mark|, rate_floor)      τ = years to maturity
maintenance:      MM     = 0.66 × IM
liquidatable:     net balance < Σ MM over positions
```

**As built:** a position stores `n` and `fixed_flow = Σ fill_size × fill_rate`, not an average rate. Funding owed is `n·Δcum − fixed_flow·Δt/YEAR`, and value is `(n·mark − fixed_flow)·τ`. Closing does **not** pay PnL up front. It leaves `n = 0` with a locked `fixed_flow` that pays the spread out interval by interval. Up-front realization would let a winner withdraw cash that the losers have only promised over time, breaking "Σ cash ≤ tokens held". With this design every fill adds `±q` and `±q·p` to the two sides, so funding is exactly zero-sum before rounding. Withdrawals never count unrealized gains (`withdrawable = cash + min(value, 0) − IM`).

`N > 0` is long YU (pay fixed, receive floating). Account balances are summed over at most `MAX_POSITIONS = 8` markets, so gas is bounded.

### 4.3 State

```rust
Contract {
  collateral: AccountId,                  // tUSDC on testnet, USDC on mainnet
  gov: AccountId,
  signers: Vec<PublicKey>, threshold: u8, // k-of-n oracle
  feeds:   IterableMap<FeedId, Feed>,
  markets: IterableMap<MarketId, Market>,
  accounts: LookupMap<AccountId, Account>,
  orders:   LookupMap<OrderId, Order>,
  insurance_fund: u128, fees: u128,
  total_cash: u128,                       // invariant: ≤ token balance held
  next_order_id: u64, deposit_cap: Option<u128>, // cap used on mainnet
}
Feed   { venue, coin, interval_secs: 3600, cum_float, last_interval_ts, clamp, stale_after }
Market { feed, maturity_ts, mode, params{IMf, rate_floor, τ_floor, max_dev, fee_bps, liq_penalty},
         bids/asks: Vec<Level> (sorted, ≤ MAX_LEVELS per side), mark, last_trade_rate,
         last_mark_ts, open_interest, oi_cap }
Level  { tick, orders: VecDeque<OrderId> (≤ MAX_ORDERS_PER_LEVEL) }
Account{ cash: i128, positions: Vec<Position> (≤ 8), open_orders: Vec<OrderId> (≤ 32),
         storage_balance: u128, session_ok: bool }
Position { market, n, f_open, cum_snapshot, ts_snapshot }
Order  { owner, market, side, tick, remaining, reserved_im, seq }
```

The book is a sorted `Vec<Level>` per side, with a cap on levels and orders per level. It is simple, bounded and cheap to iterate. A full `TreeMap` is not needed at this scale.

### 4.4 Methods

| Method | Who | Notes |
| --- | --- | --- |
| `new(collateral, gov, signers, threshold, deposit_cap)` | init | |
| `storage_deposit` / `storage_balance_of` (NEP-145) | user wallet | Pays NEAR for the account record and orders. Required because **function-call keys cannot attach deposits** (`/protocol/accounts-contracts/access-keys`), so trading methods must not need one. |
| `ft_on_transfer(sender_id, amount, msg)` | collateral token only | Panics if `predecessor ≠ collateral`. `msg` = `""` (credit sender) or `{"credit_to":"<account>"}` (credit another account, used by the 1Click one-step deposit). **On the `credit_to` path the contract never returns tokens.** With 1Click, `sender_id` is the solver or bridge account, not the trader, so a refund would send the trader's money to a third party. If `credit_to` is not registered yet, the contract registers it and pays the small storage cost from its own balance. Returns `"0"`. |
| `place_order(market, side, tick, size, kind: Limit/Market/IOC)` | user or session key | Settle both parties → check mode and rate band → match ≤ `MAX_FILLS` resting orders → rest the remainder (Limit) → check IM for taker and each maker. |
| `cancel_order(id)` / `cancel_all(market)` | owner | |
| `submit_rate(feed, interval_ts, rate, sigs: Vec<(u8, Signature)>)` | anyone (oracle bot) | Verifies k distinct signer sigs with `env::ed25519_verify` over `borsh(contract_id, feed, interval_ts, rate)`. Requires `interval_ts == last + interval_secs`, `|rate| ≤ clamp`. Accumulates `cum_float`. Backfill works because history is ordered. |
| `settle(account)` | anyone | Realizes funding for one account. |
| `liquidate(account, market, size)` | anyone (keeper) | Force-cancels the victim's orders first. The liquidator takes the position over at mark and receives a penalty that scales from 25% to 50% of MM as health falls. Shortfall comes from the insurance fund. The liquidator must end above IM. |
| `close_at_maturity(account, market)` | anyone | After maturity and the final interval: settle, zero the position, release margin. Resting orders on a matured market are cancelled. |
| `withdraw(amount)` | owner, full-access key | Debits first, `ft_transfer`, `#[private]` callback restores on failure. Requires `1 yocto` (`/smart-contracts/security/one_yocto`), so session keys can't withdraw. |
| `withdraw_to_intents(amount, receiver)` | owner, mainnet only | `ft_transfer_call` to `intents.near` with `msg = receiver`. Same debit-and-restore pattern. |
| `create_market`, `set_params`, `set_mode`, `set_signers`, `set_deposit_cap` | gov | |
| Views: `get_market`, `get_book(market, depth)`, `get_account`, `get_health(account)`, `get_feed`, `list_markets` | anyone | The client and bots read only through these. |

`CloseOnly` mode is entered automatically when `now > last_interval_ts + stale_after`. In that mode only orders that reduce positions are accepted. Rates are never guessed.

### 4.5 Invariants (tests must prove these)

1. Funding payments net to zero across longs and shorts each interval (fees and penalties go to named balances).
2. `Σ cash + insurance_fund + fees ≤ collateral.ft_balance_of(contract)`. Checked in sandbox after every scenario step.
3. No trade leaves either party below IM. No withdrawal leaves an account below IM.
4. An interval is accepted once, in order, and is never rewritten. Fewer than k signatures, duplicate signers, wrong contract ID in the signed message, or a rate out of the clamp all fail.
5. Matching respects price, then time. A self-trade is rejected.
6. Every loop has a constant bound (`MAX_FILLS`, `MAX_LEVELS`, `MAX_ORDERS_PER_LEVEL`, `MAX_POSITIONS`).
7. Trading methods (`place_order`, `cancel_*`, `settle`) need no attached deposit, so a function-call key can sign them.
8. A failed `ft_transfer` in a withdrawal restores the exact debited amount.

### 4.6 Tests

- **Unit (`cargo test`)**: the maths, against the worked example on the design page (100,000 YU at 10%, funding 0.00125% → +$0.11/h; mark to 12% with 6 days left → +$32.88; IM ≈ $575 at IMf 3), plus matching order, bounds, and signature checks.
- **Sandbox integration**: deploy the real FT contract wasm and the rate-swap contract on a local `near-sandbox`, then run deposit → trade → submit 3 intervals → settle → liquidate → maturity → withdraw. Check invariant 2 at each step, and cover the withdraw-failure path (receiver not registered with the token).
- Security pass: `/smart-contracts/security/checklist` (callbacks `#[private]`, state changed before cross-contract calls, one-yocto on fund-moving methods, storage paid by users).

### 4.7 Deploy to testnet (done when)

1. Create the token through `token.primitives.testnet` (`get_required`, then `create_token`). Register the contract with `storage_deposit` on the token.
2. `cargo near build` → `near contract deploy … with-init-call new …`.
3. `create_market` for BTC-24h and BTC-7d. `set_signers` with the 3 oracle public keys.
4. Smoke test from the CLI: deposit 1,000 tUSDC with `ft_transfer_call`, place and cancel an order, and read `get_account`. Every tx hash goes in `docs/deployments.md` with nearblocks testnet links.

**Phase 1 is done when:** all tests are green, the contract is deployed on testnet with both markets live, and a CLI round trip is recorded.

---

## 5. Phase 2: bots (`bots/`)

TypeScript on Node with `near-api-js` (`/tools/near-api`). Each bot is a long-running process with a `--once` flag for cron or CI. All of them log tx hashes.

### 5.1 Oracle (fetch → sign → submit)

1. **Fetch**: `POST https://api.hyperliquid.xyz/info` with `{"type":"fundingHistory","coin":"BTC","startTime":…}`. Key each interval by Hyperliquid's own funding `time`, rounded to the hour, never by the bot's clock.
2. **Units (confirmed)**: `fundingRate` is the fraction paid for **one hourly payment**. Hyperliquid's formula starts from an 8-hour rate, and each hourly payment is one eighth of it, so an API value of `0.0001` means 0.01% for that hour. The bot converts the decimal string straight to the 1e12 scale (`0.0001` → `100_000_000`) with no ÷8 and no annualising. Annualised APR for display = `r × 8760`.
   **Cap (confirmed, Hyperliquid docs via Context7, "Funding → Technical details"):** funding is capped at **4% per hour**, for every asset and every interval. So the feed `clamp` = `0.04` = `40_000_000_000` at 1e12 scale, and `submit_rate` rejects `|r| > clamp`. Context for sizing margin and test fixtures: `F = avg premium + clamp(interest − premium, −0.05%, +0.05%)` on the 8-hour basis. The interest component is fixed at 0.01% per 8 h = **0.00125% per hour** (≈ 11 % APR paid to shorts), so 0.00125%/h is the "quiet market" baseline. Hyperliquid converts with the *spot oracle* price, not mark. That doesn't affect us, because YU notional is fixed in USDC.
3. **Sign**: 3 signer modules, each fetching independently, each with its own ed25519 key, each signing `borsh(contract_id, feed, interval_ts, rate)`. The same borsh layout is shared with the contract through a test vector, so the Rust and TS encodings provably match.
4. **Submit**: read `get_feed`, then backfill every missing interval in order. One `submit_rate` per interval. Retry with backoff on RPC errors.
5. Run on a 5-minute loop against both testnet and (in phase 3) mainnet deployments.

Disclosure: in this hackathon build all 3 signers are run by the team. The trust model and the signer code are in the README, so anyone can recompute every submitted rate from Hyperliquid history.

### 5.2 Market maker

Quotes both sides around the latest annualised underlying rate (`r × 8760`), with configurable spread and size and a cap on inventory. It reprices when the underlying rate moves more than a threshold. It funds itself with tUSDC from the treasury.

### 5.3 Keeper

Every 30 s, walks accounts with open positions. It reads them from contract views; we add a paginated `list_accounts_with_positions(from, limit)` view so no indexer is needed. It calls `liquidate` when `get_health` says the account is below MM, and calls `close_at_maturity` for matured positions.

**Phase 2 is done when:** the oracle has advanced `cum_float` on testnet for ≥ 3 real hourly intervals, the maker has a two-sided book on both markets, and the keeper has liquidated a deliberately under-margined test account in a real testnet tx.

**Status (2026-11-12 14:10 UTC): done ✅.** Maker two-sided on both markets ✅; keeper liquidation ✅ (`CKaH6c19…`), which exposed and fixed a penalty-cap bug (see `docs/deployments.md`); oracle ✅ with 5 real hourly intervals landed (10:00–14:00 UTC, 3/3 signers each). Bots run with `near-api-js` 7.4.0, pinned deliberately: 7.5.x had four releases on 2026-11-11.

---

## 6. Phase 3: NEAR Intents (`intents/`)

Reference: the `near-intents` skill (`.claude/skills/near-intents`). Its rule files cover quote, status, deposit-near, intents-balance and Hyperliquid. Live values come from docs.near-intents.org. The 1Click API key is optional. Without it, the skill says every quote carries an extra 0.25% fee; `hackathon.md` Q-006 says 0.2%. We trust whatever the live quote returns and show its fee in the UI. Get an API key at partners.near-intents.org if the fee matters.

Flow (from the skill): `GET /v0/tokens` → `POST /v0/quote` (dry) → `POST /v0/quote` (`dry: false`, deposit address valid about 10 min) → deposit tx → `POST /v0/deposit/submit` → poll `GET /v0/status`. Asset IDs always come from `/v0/tokens` and are never built by hand.

| Step | Network | What runs |
| --- | --- | --- |
| 3.1 Asset lookup | API | `GET /v0/tokens`, then pick the NEAR USDC asset ID and the source-chain USDC IDs. Cached at build time, refreshed at runtime. |
| 3.2 Dry quotes | API | `POST /v0/quote` with `dry: true` for "USDC on Base/Arbitrum/Solana → USDC on NEAR". Real routes and prices, nothing executed. These are the default for judges without funds. |
| 3.3 Mainnet contract | mainnet | Same wasm, `collateral` = native USDC on NEAR (asset ID from 3.1), `deposit_cap` = 10 USDC per account. Oracle bot also submits here. **Needs your sign-off.** |
| 3.4 One-step deposit (primary) | mainnet | **Supported by the API (confirmed in the skill's `api-quote` rule).** Quote with `destinationAsset` = NEAR USDC, `recipientType: DESTINATION_CHAIN`, `recipient` = the contract, and `customRecipientMsg` = `{"credit_to":"<trader>.near"}`. 1Click delivers with `ft_transfer_call`, so `msg` reaches our `ft_on_transfer`. The API warns that funds are lost if the recipient doesn't implement `ft_on_transfer`; ours does, and never refunds on this path (4.4). The client builds the message from the signed-in account and never takes free text. First live run: 0.5 USDC, then check `get_account`. |
| 3.5 Two-step deposit (fallback) | mainnet | `recipient` = the trader's NEAR account, then the trader signs one `ft_transfer_call` into the contract. Used if 3.4's first live test does not credit as expected. |
| 3.6 Withdraw | mainnet | `withdraw_to_intents` → `ft_transfer_call` to `intents.near` with `msg` = the trader's account, which assigns ownership. Then a quote with `depositType: INTENTS`, `refundType: INTENTS` to the trader's chain of choice (skill rule `intents-balance`). |
| 3.7 Fund Hyperliquid perp | mainnet | `destinationAsset` = `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` (8 decimals), `recipient` = the trader's Hyperliquid `0x` address. It credits the **perp** balance. Minimum 0.5 USDC. Moving money *out of* Hyperliquid costs a flat 0.2 USDC (plus 1 USDC extra via `usdSend`). |
| 3.8 Status handling | API | Terminal: `SUCCESS`, `FAILED`, `REFUNDED`, `INCOMPLETE_DEPOSIT`. In progress: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`. All shown as-is. Margin is credited only when the contract's `ft_on_transfer` runs, never from a quote. |

`intents/scripts/roundtrip.ts` runs 3.4 → trade → 3.6 with ≤ 5 USDC end to end, printing every tx hash and status. It refuses to run without `--i-confirm-mainnet`, and I will only run it after you say yes.

**Phase 3 is done when:** the dry quotes work from the library, and one real mainnet round trip (in → margin → out) has tx hashes recorded in `docs/deployments.md`.

---

## 7. Phase 4: client (`client/`)

Next.js (latest stable through `create-next-app@latest`, App Router, TypeScript, Tailwind). Wallet: **`@hot-labs/near-connect`** through **`near-connect-hooks`** (`NearProvider` + `useNearWallet`). NEAR Wallet Selector is deprecated (`/tools/near-connect`, `near-dapp` skill). Chain reads use `viewFunction` / `near-api-js`.

### Screens

1. **Markets**: each market shows maturity, underlying APR (from the feed), mark APR, best bid and ask, OI, mode, and how long ago the oracle last updated.
2. **Trade**: order book (live from `get_book`), order entry in APR, size in YU, and a hedge sizer ("I hold $X of BTC perp on Hyperliquid → long X YU"). It previews IM, liquidation APR and fees, computed with the shared units package. A tooltip explains long vs short YU.
3. **Portfolio**: cash, net balance, health. For each position: fixed paid and floating received shown separately, realized and unrealized PnL, and time to maturity. Open orders with cancel.
4. **Funds**:
   - Testnet: faucet (server route with real `ft_transfer`, rate-limited), deposit (`ft_transfer_call` signed in the wallet), and withdraw.
   - Mainnet / Intents: dry-quote screen (works for anyone), live deposit with a status tracker, withdraw to any chain, and fund Hyperliquid.
5. **Activity**: tx hashes for every action, linking to nearblocks (testnet or mainnet).

### Session key

**Supported (confirmed in the `near-dapp` skill):** `near-connect-hooks` exposes `addFunctionCallKey({ publicKey, contractId, methodNames, allowance })` and `deleteKey({ publicKey })`.

1. On first trade, the client generates an ed25519 keypair (`KeyPair.fromRandom('ed25519')` from near-api-js). The private key stays in the browser (IndexedDB, scoped to account and contract).
2. The wallet signs one `addFunctionCallKey`: `contractId` = the rate-swap contract, `methodNames` = `['place_order','cancel_order','cancel_all','settle']`, `allowance` = 0.25 NEAR.
3. After that, the client signs trades itself with a near-api-js `Account` and an in-memory signer for that key. No wallet popups. Each tx still shows on nearblocks as signed by the trader's account.
4. "Revoke session" in the UI calls `deleteKey`.
5. The key can't move funds: function-call keys can't attach deposits, and `withdraw` requires one yocto.

We use this explicit path rather than `signIn({ contractId, methodNames })`. Some wallets sign in without adding a key at all (near-connect exposes a `signInWithoutAddKey` feature flag), and even when a wallet does add one, the wallet keeps the private key, so the app can't sign with it. The remaining per-wallet risk is that a wallet rejects the `AddKey` action, so we test it on testnet with each wallet we list (HOT, Meteor, MyNearWallet). Wallets that reject it fall back to signing each trade.

### Network switch

Testnet is the default. Mainnet appears only on the Funds/Intents screens and in the mainnet market view.

**Phase 4 is done when:** a fresh testnet account can log in → faucet → deposit → trade against the maker → see funding accrue over a real interval → withdraw, all from the UI, with each step's tx visible on nearblocks.

### 7.1 Stretch (only if time is left): gasless relayer

Next.js route handler as the relayer (`/web3-apps/tutorials/meta-transactions`, `near-api-js` ≥ 7.4). Not counted as done unless it submits real delegate actions.

---

## 8. Schedule against the deadline (UTC)

| When | Work |
| --- | --- |
| Nov 12 (rest of day) | Phase 1: scaffold, maths, ledger, oracle intake, book, margin, unit tests |
| Nov 13 morning | Phase 1: liquidation, maturity, withdrawals, sandbox tests, testnet deploy. Start the oracle bot early so real intervals pile up. |
| Nov 13 afternoon | Phase 2: maker + keeper, liquidation demo |
| Nov 13 evening | Phase 3: dry quotes, mainnet deploy + one round trip (with your sign-off) |
| Nov 14 | Phase 4: client. Then README, LICENSE, deployments doc, demo recording |
| Nov 14 by 22:00 | Repo public, X post published by you, submission payload shown to you for confirmation |

If time runs short, cut in this order (last first): relayer → Hyperliquid funding step (3.7) → one-step deposit (fall back to two-step, 3.5) → session keys (fall back to wallet signing) → the 7-day market. The no-mocks rule is never what gets cut.

---

## 9. Decisions and sign-offs I need from you

1. **Account names** on testnet (contract, token symbol, gov) and on mainnet.
2. **Mainnet**: approval to create and fund a mainnet account, deploy the capped contract, and spend ≤ 5 USDC plus gas on one round trip. I'll ask again at the moment of each action.
3. **Governance**: a single key for now (disclosed), or a multisig.
4. **Hosting**: the client on Vercel and the bots on a small always-on box. The oracle has to keep running through judging (to 2026-11-18, ideally 11-25, per Q-012).

## 10. Facts still to verify (each checked in the phase that needs it)

Resolved:
- Hyperliquid `fundingRate`: one hourly payment's fraction (`0.0001` = 0.01% for that hour). See 5.1.
- One-step 1Click deposit into the contract: supported through `customRecipientMsg` → `ft_transfer_call`. See 3.4; one 0.5 USDC live test before relying on it.
- Session keys: `addFunctionCallKey` / `deleteKey` in `near-connect-hooks`. See 7.

- Hyperliquid funding cap: 4%/hour for all assets → `clamp = 40_000_000_000` (1e12 scale). See 5.1.
- Signature-check gas (nearcore runtime config, via Context7): `ed25519_verify_base` = 210 Ggas, `ed25519_verify_byte` = 9 Mgas. Our signed message is about 70 bytes (contract ID, feed, `u64` interval, `i128` rate), so one check ≈ 0.21 Tgas and a 3-of-3 quorum ≈ 0.65 Tgas. That is negligible against the 300 Tgas limit, so `submit_rate` can verify all n signatures and could batch several backfill intervals per call (≤ 24, still under 20 Tgas for the checks).

Still open:
- The exact Rust signature of `env::ed25519_verify` in the near-sdk version `cargo near new` pins. Context7's near-sdk index had no entry for it. The expected form is `(&[u8; 64] sig, &[u8] msg, &[u8; 32] pk) -> bool`; it gets confirmed against the crate source once it's in `Cargo.lock` (phase 1, first hour).
- Which listed wallets accept the `AddKey` action on testnet (phase 4, manual test per wallet).
- The trader's account ID length/format in `credit_to` must pass the contract's `AccountId` parse; the client validates before quoting (phase 3).

## 11. Submission checklist (from `hackathon.md`)

- [ ] Repo public before 2026-11-14T23:59Z, MIT `LICENSE`, README with "do X → see Y" steps, trust model, deployed addresses, libraries used, AI assistance disclosed
- [ ] X post by you: problem first, one complete moment on video, NEAR's concrete role, tags @NEARProtocol #NEARHackathon
- [ ] Payload built from your answers only, printed for your confirmation, `requestId` generated once, never committed
