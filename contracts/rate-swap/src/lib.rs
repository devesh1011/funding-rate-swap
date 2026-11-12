//! Funding-rate swap: trade Hyperliquid funding against a fixed rate.
//!
//! One Yield Unit (YU) is the floating funding on 1 USDC of notional until
//! maturity. Long YU pays fixed and receives floating; short YU the reverse.
//! Funding arrives as k-of-n signed per-interval rates and accumulates in a
//! per-feed index; positions settle lazily against it, so no call loops
//! over accounts. Collateral is one NEP-141 token (tUSDC on testnet, USDC on
//! mainnet), deposited with `ft_transfer_call`.

pub mod math;
pub mod trade_log;
pub mod types;

use math::*;
use near_sdk::json_types::{Base64VecU8, I128, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, CurveType,
    Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};
use types::*;

/// Flat NEAR deposit per trading account. Covers the bounded worst case of
/// one account record, MAX_OPEN_ORDERS orders and MAX_POSITIONS positions.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(100);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(60);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
/// Headroom left for the rest of `ft_on_transfer` after scheduling a forward.
const GAS_FORWARD_MARGIN: Gas = Gas::from_tgas(10);
const RATE_DOMAIN: &str = "fundswap-rate-v1";

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
}

#[near]
#[derive(BorshStorageKey)]
enum Key {
    Feeds,
    Markets,
    Books,
    Accounts,
    Orders,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    collateral: AccountId,
    gov: AccountId,
    intents_contract: Option<AccountId>,
    signers: Vec<[u8; 32]>,
    threshold: u8,
    feeds: IterableMap<u32, Feed>,
    markets: IterableMap<u32, Market>,
    books: LookupMap<u32, Book>,
    accounts: IterableMap<AccountId, Account>,
    orders: LookupMap<u64, Order>,
    /// Σ account cash. Invariant: total_cash + insurance ≤ tokens held.
    total_cash: i128,
    insurance: i128,
    deposit_cap: Option<u128>,
    next_feed_id: u32,
    next_market_id: u32,
    next_order_id: u64,
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn pos_part(x: i128) -> i128 {
    x.max(0)
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "fundswap", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

/// Bytes the oracle signers sign: borsh(domain, contract, feed, interval end, rate).
pub fn rate_message(contract: &AccountId, feed_id: u32, interval_ts: u64, rate: i128) -> Vec<u8> {
    near_sdk::borsh::to_vec(&(RATE_DOMAIN, contract.as_str(), feed_id, interval_ts, rate))
        .expect("borsh")
}

struct Health {
    cash: i128,
    value: i128,
    im: i128,
    mm: i128,
}

impl Health {
    fn net(&self) -> i128 {
        self.cash + self.value
    }
    /// Cash that can leave without counting unrealized gains as collateral.
    fn withdrawable(&self) -> i128 {
        (self.cash + self.value.min(0) - self.im).clamp(0, self.cash.max(0))
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        collateral: AccountId,
        gov: AccountId,
        signers: Vec<PublicKey>,
        threshold: u8,
        deposit_cap: Option<U128>,
        intents_contract: Option<AccountId>,
    ) -> Self {
        let mut c = Self {
            collateral,
            gov,
            intents_contract,
            signers: vec![],
            threshold: 0,
            feeds: IterableMap::new(Key::Feeds),
            markets: IterableMap::new(Key::Markets),
            books: LookupMap::new(Key::Books),
            accounts: IterableMap::new(Key::Accounts),
            orders: LookupMap::new(Key::Orders),
            total_cash: 0,
            insurance: 0,
            deposit_cap: deposit_cap.map(|c| c.0),
            next_feed_id: 0,
            next_market_id: 0,
            next_order_id: 0,
        };
        c.write_signers(signers, threshold);
        c
    }

    // =====================================================================
    // Governance
    // =====================================================================

    pub fn set_signers(&mut self, signers: Vec<PublicKey>, threshold: u8) {
        self.assert_gov();
        self.write_signers(signers, threshold);
    }

    pub fn set_gov(&mut self, gov: AccountId) {
        self.assert_gov();
        self.gov = gov;
    }

    pub fn set_deposit_cap(&mut self, deposit_cap: Option<U128>) {
        self.assert_gov();
        self.deposit_cap = deposit_cap.map(|c| c.0);
    }

    pub fn set_intents_contract(&mut self, intents_contract: Option<AccountId>) {
        self.assert_gov();
        self.intents_contract = intents_contract;
    }

    pub fn create_feed(
        &mut self,
        name: String,
        interval_secs: u64,
        start_ts: U64,
        clamp: I128,
        stale_after_secs: u64,
    ) -> u32 {
        self.assert_gov();
        require!(interval_secs > 0 && start_ts.0 % interval_secs == 0, "start_ts must be interval-aligned");
        require!(clamp.0 > 0, "clamp must be positive");
        let id = self.next_feed_id;
        self.next_feed_id += 1;
        self.feeds.insert(
            id,
            Feed {
                name,
                interval_secs,
                cum: 0,
                last_ts: start_ts.0,
                clamp: clamp.0,
                stale_after_secs,
                markets: vec![],
            },
        );
        id
    }

    pub fn create_market(
        &mut self,
        feed_id: u32,
        name: String,
        maturity_ts: U64,
        initial_mark: I128,
        params: MarketParams,
    ) -> u32 {
        self.assert_gov();
        let mut feed = self.feed(feed_id);
        require!(feed.markets.len() < MAX_MARKETS_PER_FEED, "too many markets on feed");
        require!(maturity_ts.0 % feed.interval_secs == 0, "maturity must be interval-aligned");
        require!(maturity_ts.0 > feed.last_ts && maturity_ts.0 > now_secs(), "maturity in the past");
        Self::check_params(&params);
        let id = self.next_market_id;
        self.next_market_id += 1;
        feed.markets.push(id);
        self.feeds.insert(feed_id, feed);
        self.markets.insert(
            id,
            Market {
                feed_id,
                name,
                maturity_ts: maturity_ts.0,
                mode: Mode::Active,
                params,
                mark: initial_mark.0,
                last_mark_ts: now_secs(),
                long_oi: 0,
                final_cum: None,
            },
        );
        self.books.insert(id, Book::default());
        id
    }

    pub fn set_market_params(&mut self, market_id: u32, params: MarketParams) {
        self.assert_gov();
        Self::check_params(&params);
        let mut m = self.market(market_id);
        m.params = params;
        self.markets.insert(market_id, m);
    }

    pub fn set_mode(&mut self, market_id: u32, mode: Mode) {
        self.assert_gov();
        let mut m = self.market(market_id);
        m.mode = mode;
        self.markets.insert(market_id, m);
    }

    // =====================================================================
    // Storage (NEP-145 subset)
    // =====================================================================

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let id = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        let mut acc = self.accounts.get(&id).cloned().unwrap_or_default();
        if acc.storage_paid {
            if !deposit.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
            }
        } else {
            require!(deposit >= STORAGE_DEPOSIT, "attach at least the storage deposit");
            let refund = deposit.saturating_sub(STORAGE_DEPOSIT);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
            acc.storage_paid = true;
            self.accounts.insert(id.clone(), acc);
        }
        self.storage_balance_of(id).unwrap()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).filter(|a| a.storage_paid).map(|_| StorageBalance {
            total: U128(STORAGE_DEPOSIT.as_yoctonear()),
            available: U128(0),
        })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_DEPOSIT.as_yoctonear()),
            max: Some(U128(STORAGE_DEPOSIT.as_yoctonear())),
        }
    }

    // =====================================================================
    // Funds in and out
    // =====================================================================

    /// NEP-141 receiver. Only the collateral token may call it.
    ///
    /// `msg = ""` credits the sender, who must be registered (otherwise
    /// refunded: the sender is the owner). `{"credit_to": "x"}` credits `x`
    /// and **never refunds**: with 1Click the sender is a solver, so a refund
    /// would hand the trader's money to a third party. Unknown `credit_to`
    /// accounts are registered at the contract's storage expense.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral, "unsupported token");
        let amount_i = amount.0 as i128;
        require!(amount_i > 0, "zero amount");

        if msg.is_empty() {
            let Some(mut acc) = self.accounts.get(&sender_id).cloned() else {
                return PromiseOrValue::Value(amount);
            };
            if let Some(cap) = self.deposit_cap {
                if acc.cash + amount_i > cap as i128 {
                    return PromiseOrValue::Value(amount);
                }
            }
            self.credit(&mut acc, amount_i);
            self.accounts.insert(sender_id.clone(), acc);
            emit("deposit", json!({"account_id": sender_id, "amount": amount, "from": sender_id}));
            return PromiseOrValue::Value(U128(0));
        }

        let parsed: DepositMsg = serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("invalid msg"));
        if parsed.insurance == Some(true) {
            self.insurance += amount_i;
            emit("insurance_deposit", json!({"from": sender_id, "amount": amount}));
            return PromiseOrValue::Value(U128(0));
        }
        let target = parsed.credit_to.unwrap_or_else(|| env::panic_str("msg needs credit_to"));
        let mut acc = self.accounts.get(&target).cloned().unwrap_or_default();
        let excess = self.excess_over_cap(&acc, amount_i);
        let credited = amount_i - excess;
        self.credit(&mut acc, credited);
        self.accounts.insert(target.clone(), acc);
        emit("deposit", json!({"account_id": target, "amount": U128(credited as u128), "from": sender_id}));
        if excess > 0 {
            // Over the cap: the excess is never credited and goes to the
            // trader's own balance in NEAR Intents; `on_transfer_out`
            // credits back whatever does not leave. Detached on purpose: the
            // value returned here must stay 0, or the token would refund the
            // solver.
            let intents = self.intents_contract.clone().expect("checked by excess_over_cap");
            let _ = ext_ft::ext(self.collateral.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_FT_TRANSFER_CALL)
                .ft_transfer_call(intents, U128(excess as u128), None, target.to_string())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_transfer_out(target.clone(), U128(excess as u128), true),
                );
            emit("deposit_over_cap", json!({"account_id": target, "forwarded": U128(excess as u128)}));
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraw collateral to the caller's own account on the token contract.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        self.debit_for_withdrawal(&id, amount.0);
        ext_ft::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(id.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_transfer_out(id, amount, false),
            )
    }

    /// Withdraw into NEAR Intents (`intents.near` on mainnet). The tokens
    /// become owned by `receiver` (default: the caller) inside the verifier,
    /// from where 1Click moves them to any chain.
    #[payable]
    pub fn withdraw_to_intents(&mut self, amount: U128, receiver: Option<AccountId>) -> Promise {
        assert_one_yocto();
        let intents = self
            .intents_contract
            .clone()
            .unwrap_or_else(|| env::panic_str("intents not configured on this network"));
        let id = env::predecessor_account_id();
        self.debit_for_withdrawal(&id, amount.0);
        let owner = receiver.unwrap_or_else(|| id.clone());
        ext_ft::ext(self.collateral.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER_CALL)
            .ft_transfer_call(intents, amount, None, owner.to_string())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_transfer_out(id, amount, true),
            )
    }

    /// Restores whatever did not leave. Never panics.
    #[private]
    pub fn on_transfer_out(&mut self, account_id: AccountId, amount: U128, is_call: bool) -> U128 {
        let refund = match env::promise_result_checked(0, 64) {
            Err(_) => amount.0,
            Ok(bytes) if is_call => serde_json::from_slice::<U128>(&bytes)
                .map(|used| amount.0.saturating_sub(used.0))
                .unwrap_or(0),
            Ok(_) => 0,
        };
        if refund > 0 {
            let mut acc = self.accounts.get(&account_id).cloned().unwrap_or_default();
            self.credit(&mut acc, refund as i128);
            self.accounts.insert(account_id.clone(), acc);
            emit("withdraw_refund", json!({"account_id": account_id, "amount": U128(refund)}));
        }
        U128(refund)
    }

    // =====================================================================
    // Oracle
    // =====================================================================

    /// Accept the next funding intervals of a feed, in order, each signed by
    /// at least `threshold` distinct registered signers. Callable by anyone.
    pub fn submit_rates(&mut self, feed_id: u32, entries: Vec<RateEntry>) {
        require!(!entries.is_empty() && entries.len() <= MAX_RATE_BATCH, "1..=24 entries");
        let mut feed = self.feed(feed_id);
        let me = env::current_account_id();
        let now = now_secs();
        for e in entries {
            let ts = e.interval_ts.0;
            let rate = e.rate.0;
            require!(ts == feed.last_ts + feed.interval_secs, "interval out of order");
            require!(ts <= now, "interval in the future");
            require!(rate.abs() <= feed.clamp, "rate outside clamp");
            let msg = rate_message(&me, feed_id, ts, rate);
            let mut seen: u64 = 0;
            let mut valid: u8 = 0;
            for s in &e.sigs {
                let idx = s.signer as usize;
                if idx >= self.signers.len() || seen & (1 << idx) != 0 {
                    continue;
                }
                let Ok(sig) = <[u8; 64]>::try_from(s.signature.0.as_slice()) else { continue };
                if env::ed25519_verify(&sig, &msg, &self.signers[idx]) {
                    seen |= 1 << idx;
                    valid += 1;
                }
            }
            require!(valid >= self.threshold, "not enough valid signatures");
            feed.cum += rate;
            feed.last_ts = ts;
            for mid in feed.markets.clone() {
                let mut m = self.market(mid);
                if m.final_cum.is_none() && m.maturity_ts == ts {
                    m.final_cum = Some(feed.cum);
                    self.markets.insert(mid, m);
                }
            }
            emit("rate", json!({"feed_id": feed_id, "interval_ts": U64(ts), "rate": I128(rate), "cum": I128(feed.cum)}));
        }
        self.feeds.insert(feed_id, feed);
    }

    // =====================================================================
    // Trading
    // =====================================================================

    /// Place an order priced in APR ticks (1 tick = 1 bp). Needs no attached
    /// deposit, so a function-call session key can sign it.
    pub fn place_order(
        &mut self,
        market_id: u32,
        side: Side,
        size: U128,
        tick: i32,
        kind: OrderKind,
    ) -> PlaceResult {
        let taker = env::predecessor_account_id();
        let mut acc = self.account(&taker);
        require!(acc.storage_paid, "call storage_deposit first");
        self.settle_mut(&taker, &mut acc);

        let mut market = self.market(market_id);
        let now = now_secs();
        require!(market.final_cum.is_none() && now < market.maturity_ts, "market matured");
        let mode = self.effective_mode(&market, now);
        require!(mode != Mode::Paused, "market paused");

        let size = size.0 as i128;
        require!(size > 0 && size <= MAX_ORDER_SIZE, "bad size");
        let dir = side.sign();
        let max_dev = market.params.max_dev.0;
        let limit_tick = match kind {
            OrderKind::Market => {
                let edge = market.mark + dir * max_dev;
                (if dir > 0 { div_floor(edge, TICK) } else { -div_floor(-edge, TICK) }) as i32
            }
            _ => tick,
        };
        require!(limit_tick.abs() <= MAX_ABS_TICK, "tick out of range");
        require!((tick_to_rate(limit_tick) - market.mark).abs() <= max_dev, "rate outside band");

        let old_n = acc.positions.iter().find(|p| p.market_id == market_id).map_or(0, |p| p.n);
        let reduces = old_n * dir < 0 && size <= old_n.abs();
        if mode == Mode::CloseOnly {
            require!(reduces, "market is close-only");
        }

        let point = self.feed_point(&market);
        let secs_left = (market.maturity_ts - point.1) as i128;
        let mut book = self.books.get(&market_id).cloned().unwrap_or_default();
        let mut remaining = size;
        let mut fills = 0usize;
        let mut log: Vec<trade_log::TradeRecord> = Vec::new();
        {
            let opp = if dir > 0 { &mut book.asks } else { &mut book.bids };
            while remaining > 0 && fills < MAX_FILLS && !opp.is_empty() {
                let level_tick = opp[0].tick;
                let crosses = if dir > 0 { level_tick <= limit_tick } else { level_tick >= limit_tick };
                let price = tick_to_rate(level_tick);
                if !crosses || (price - market.mark).abs() > max_dev {
                    break;
                }
                let oid = opp[0].orders[0];
                let Some(mut order) = self.orders.get(&oid).cloned() else {
                    opp[0].orders.remove(0);
                    if opp[0].orders.is_empty() {
                        opp.remove(0);
                    }
                    continue;
                };
                require!(order.owner != taker, "order would self-trade");
                let q = remaining.min(order.remaining);

                let mut maker = self.account(&order.owner);
                self.settle_market_mut(&mut maker, market_id);
                let (mo, mn) = self.apply_fill(&mut maker, market_id, point, -dir * q, price);
                let (to, tn) = self.apply_fill(&mut acc, market_id, point, dir * q, price);
                market.long_oi += pos_part(mn) - pos_part(mo) + pos_part(tn) - pos_part(to);

                let fee = taker_fee(q, market.params.taker_fee_rate.0, secs_left);
                self.credit(&mut acc, -fee);
                self.insurance += fee;

                market.mark = next_mark(
                    market.mark,
                    price,
                    now.saturating_sub(market.last_mark_ts) as i128,
                    market.params.mark_window_secs as i128,
                );
                market.last_mark_ts = now;

                order.remaining -= q;
                remaining -= q;
                fills += 1;
                if order.remaining == 0 {
                    self.orders.remove(&oid);
                    maker.orders.retain(|o| *o != oid);
                    opp[0].orders.remove(0);
                    if opp[0].orders.is_empty() {
                        opp.remove(0);
                    }
                } else {
                    self.orders.insert(oid, order.clone());
                }
                self.accounts.insert(order.owner.clone(), maker);
                log.push(trade_log::TradeRecord {
                    ts: now,
                    market_id,
                    taker_side: side,
                    taker: taker.clone(),
                    maker: order.owner.clone(),
                    size: U128(q as u128),
                    rate: I128(price),
                    liquidation: false,
                });
                emit(
                    "trade",
                    json!({
                        "market_id": market_id, "taker": taker, "maker": order.owner,
                        "taker_side": side, "size": U128(q as u128), "tick": level_tick,
                        "fee": I128(fee), "mark": I128(market.mark),
                    }),
                );
            }
        }

        // Rest the remainder of a limit order unless it would leave a crossed book.
        let mut order_id = None;
        if remaining > 0 && kind == OrderKind::Limit {
            let opp = if dir > 0 { &book.asks } else { &book.bids };
            let still_crosses = opp
                .first()
                .is_some_and(|l| if dir > 0 { l.tick <= limit_tick } else { l.tick >= limit_tick });
            if !still_crosses {
                require!(acc.orders.len() < MAX_OPEN_ORDERS, "too many open orders");
                let id = self.next_order_id;
                self.next_order_id += 1;
                let own = if dir > 0 { &mut book.bids } else { &mut book.asks };
                match own.iter().position(|l| l.tick == limit_tick) {
                    Some(i) => {
                        require!(own[i].orders.len() < MAX_ORDERS_PER_LEVEL, "price level full");
                        own[i].orders.push(id);
                    }
                    None => {
                        require!(own.len() < MAX_LEVELS, "book side full");
                        let at = own
                            .iter()
                            .position(|l| if dir > 0 { l.tick < limit_tick } else { l.tick > limit_tick })
                            .unwrap_or(own.len());
                        own.insert(at, Level { tick: limit_tick, orders: vec![id] });
                    }
                }
                self.orders.insert(
                    id,
                    Order { owner: taker.clone(), market_id, side, tick: limit_tick, remaining },
                );
                acc.orders.push(id);
                order_id = Some(U64(id));
            }
        }

        let old_oi = self.market(market_id).long_oi;
        let new_oi = market.long_oi;
        self.markets.insert(market_id, market.clone());
        self.books.insert(market_id, book);

        let new_n = acc.positions.iter().find(|p| p.market_id == market_id).map_or(0, |p| p.n);
        let pure_reduction = order_id.is_none() && new_n * old_n >= 0 && new_n.abs() < old_n.abs();
        if !pure_reduction {
            let h = self.health(&acc);
            require!(h.net() >= h.im, "insufficient margin");
        }
        if mode == Mode::Active && new_oi > old_oi {
            require!(new_oi <= market.params.oi_cap.0 as i128, "open interest cap reached");
        }
        self.accounts.insert(taker, acc);
        trade_log::record(&log);
        PlaceResult { filled: U128((size - remaining) as u128), order_id }
    }

    pub fn cancel_order(&mut self, order_id: U64) {
        let id = env::predecessor_account_id();
        let order = self.orders.get(&order_id.0).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(order.owner == id, "not your order");
        let mut acc = self.account(&id);
        self.remove_order(order_id.0, &order, &mut acc);
        self.accounts.insert(id, acc);
    }

    /// Cancel all of the caller's orders, optionally only in one market.
    pub fn cancel_all(&mut self, market_id: Option<u32>) {
        let id = env::predecessor_account_id();
        let mut acc = self.account(&id);
        self.cancel_orders(&mut acc, market_id);
        self.accounts.insert(id, acc);
    }

    /// Realize pending funding for an account and close matured positions.
    /// Anyone can call it.
    pub fn settle(&mut self, account_id: AccountId) -> I128 {
        let mut acc = self.account(&account_id);
        let before = acc.cash;
        self.settle_mut(&account_id, &mut acc);
        let delta = acc.cash - before;
        self.accounts.insert(account_id, acc);
        I128(delta)
    }

    /// Take over an unhealthy account's position in one market at the mark
    /// rate. The caller earns a penalty of 25–50 % of that position's
    /// maintenance margin and must end above initial margin.
    pub fn liquidate(&mut self, account_id: AccountId, market_id: u32) -> I128 {
        let liq_id = env::predecessor_account_id();
        require!(liq_id != account_id, "cannot liquidate yourself");
        let mut victim = self.account(&account_id);
        self.settle_mut(&account_id, &mut victim);
        self.cancel_orders(&mut victim, None);
        let h = self.health(&victim);
        require!(h.net() < h.mm, "account is healthy");

        let mut market = self.market(market_id);
        let now = now_secs();
        require!(market.final_cum.is_none() && now < market.maturity_ts, "market matured");
        require!(self.effective_mode(&market, now) != Mode::Paused, "market paused");
        let n = victim.positions.iter().find(|p| p.market_id == market_id).map_or(0, |p| p.n);
        require!(n != 0, "no position in this market");

        let mut liq = self.account(&liq_id);
        require!(liq.storage_paid, "call storage_deposit first");
        self.settle_mut(&liq_id, &mut liq);

        let point = self.feed_point(&market);
        let secs_left = (market.maturity_ts - point.1) as i128;
        let p = &market.params;
        let risk = RiskParams {
            im_factor_bps: p.im_factor_bps as i128,
            rate_floor: p.rate_floor.0,
            time_floor_secs: p.time_floor_secs as i128,
        };
        let mm_pos = mul_div_ceil(initial_margin(n, market.mark, secs_left, &risk), p.mm_ratio_bps as i128, BPS);
        // Never take more than the account is worth: a penalty must not
        // create bad debt. Taking over at mark leaves net unchanged, so the
        // pre-liquidation net is the ceiling.
        let penalty = mul_div_floor(mm_pos, liquidation_penalty_bps(h.net(), h.mm), BPS)
            .min(h.net().max(0))
            .min(victim.cash.max(0));

        let (vo, vn) = self.apply_fill(&mut victim, market_id, point, -n, market.mark);
        let (lo, ln) = self.apply_fill(&mut liq, market_id, point, n, market.mark);
        market.long_oi += pos_part(vn) - pos_part(vo) + pos_part(ln) - pos_part(lo);
        self.credit(&mut victim, -penalty);
        self.credit(&mut liq, penalty);
        trade_log::record(&[trade_log::TradeRecord {
            ts: now,
            market_id,
            taker_side: if n > 0 { Side::Long } else { Side::Short },
            taker: liq_id.clone(),
            maker: account_id.clone(),
            size: U128(n.unsigned_abs()),
            rate: I128(market.mark),
            liquidation: true,
        }]);
        self.markets.insert(market_id, market);

        let lh = self.health(&liq);
        require!(lh.net() >= lh.im, "liquidator lacks margin");

        self.cover_bad_debt_internal(&account_id, &mut victim);
        emit(
            "liquidation",
            json!({"account_id": account_id, "liquidator": liq_id, "market_id": market_id,
                   "size": I128(n), "mark": I128(self.market(market_id).mark), "penalty": I128(penalty)}),
        );
        self.accounts.insert(account_id, victim);
        self.accounts.insert(liq_id, liq);
        I128(penalty)
    }

    /// Cover a flat account's negative net balance from the insurance fund.
    /// Anyone can call it; returns the amount covered.
    pub fn cover_bad_debt(&mut self, account_id: AccountId) -> I128 {
        let mut acc = self.account(&account_id);
        self.settle_mut(&account_id, &mut acc);
        let covered = self.cover_bad_debt_internal(&account_id, &mut acc);
        self.accounts.insert(account_id, acc);
        I128(covered)
    }

    // =====================================================================
    // Views
    // =====================================================================

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            collateral: self.collateral.clone(),
            gov: self.gov.clone(),
            intents_contract: self.intents_contract.clone(),
            signers: self
                .signers
                .iter()
                .map(|k| PublicKey::from_parts(CurveType::ED25519, k.to_vec()).unwrap())
                .collect(),
            threshold: self.threshold,
            insurance: I128(self.insurance),
            total_cash: I128(self.total_cash),
            deposit_cap: self.deposit_cap.map(U128),
            storage_deposit: U128(STORAGE_DEPOSIT.as_yoctonear()),
        }
    }

    pub fn list_feeds(&self) -> Vec<FeedView> {
        self.feeds
            .iter()
            .map(|(id, f)| FeedView {
                id: *id,
                name: f.name.clone(),
                interval_secs: f.interval_secs,
                cum: I128(f.cum),
                last_ts: f.last_ts,
                clamp: I128(f.clamp),
                stale_after_secs: f.stale_after_secs,
                markets: f.markets.clone(),
            })
            .collect()
    }

    pub fn get_feed(&self, feed_id: u32) -> Option<FeedView> {
        self.list_feeds().into_iter().find(|f| f.id == feed_id)
    }

    pub fn list_markets(&self) -> Vec<MarketView> {
        self.markets.keys().map(|id| self.market_view(*id)).collect()
    }

    pub fn get_market(&self, market_id: u32) -> Option<MarketView> {
        self.markets.get(&market_id).map(|_| self.market_view(market_id))
    }

    pub fn get_book(&self, market_id: u32, depth: Option<u32>) -> BookView {
        let book = self.books.get(&market_id).cloned().unwrap_or_default();
        let depth = depth.unwrap_or(MAX_LEVELS as u32) as usize;
        let side = |levels: &Vec<Level>| {
            levels
                .iter()
                .take(depth)
                .map(|l| LevelView {
                    tick: l.tick,
                    size: U128(
                        l.orders
                            .iter()
                            .filter_map(|o| self.orders.get(o))
                            .map(|o| o.remaining as u128)
                            .sum(),
                    ),
                    orders: l.orders.len() as u32,
                })
                .collect()
        };
        BookView { bids: side(&book.bids), asks: side(&book.asks) }
    }

    /// Latest trades in a market, newest first (at most 60).
    pub fn get_trades(&self, market_id: u32, limit: Option<u32>) -> Vec<trade_log::TradeRecord> {
        trade_log::market_trades(market_id, limit.unwrap_or(50) as usize)
    }

    /// Latest trades an account took part in (as taker, maker, liquidator or
    /// liquidated), newest first (at most 40).
    pub fn get_account_trades(&self, account_id: AccountId, limit: Option<u32>) -> Vec<trade_log::TradeRecord> {
        trade_log::account_trades(&account_id, limit.unwrap_or(40) as usize)
    }

    /// Hourly OHLC candles of trade rates with volume, oldest first; hours
    /// without trades are omitted. At most two weeks per call.
    pub fn get_candles(&self, market_id: u32, from_ts: U64, to_ts: Option<U64>) -> Vec<trade_log::Candle> {
        trade_log::candles(market_id, from_ts.0, to_ts.map_or(now_secs(), |t| t.0))
    }

    pub fn get_order(&self, order_id: U64) -> Option<OrderView> {
        self.orders.get(&order_id.0).map(|o| Self::order_view(order_id.0, o))
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let mut acc = self.accounts.get(&account_id)?.clone();
        self.settle_into(&mut acc, None);
        let h = self.health(&acc);
        let positions = acc
            .positions
            .iter()
            .map(|p| {
                let m = self.market(p.market_id);
                let point = self.feed_point(&m);
                let secs_left = m.maturity_ts.saturating_sub(point.1);
                PositionView {
                    market_id: p.market_id,
                    n: I128(p.n),
                    fixed_flow: I128(p.fixed_flow),
                    avg_rate: (p.n != 0).then(|| I128(p.fixed_flow / p.n)),
                    value: I128(position_value(p.n, p.fixed_flow, m.mark, secs_left as i128)),
                    initial_margin: I128(initial_margin(p.n, m.mark, secs_left as i128, &Self::risk(&m))),
                    secs_left,
                }
            })
            .collect();
        let orders = acc
            .orders
            .iter()
            .filter_map(|id| self.orders.get(id).map(|o| Self::order_view(*id, o)))
            .collect();
        Some(AccountView {
            account_id,
            cash: I128(acc.cash),
            storage_paid: acc.storage_paid,
            positions,
            orders,
            health: HealthView {
                cash: I128(h.cash),
                value: I128(h.value),
                net: I128(h.net()),
                initial_margin: I128(h.im),
                maintenance_margin: I128(h.mm),
                liquidatable: h.net() < h.mm,
                withdrawable: I128(h.withdrawable()),
            },
        })
    }

    pub fn list_accounts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountId> {
        self.accounts
            .keys()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100).min(500) as usize)
            .cloned()
            .collect()
    }

    pub fn num_accounts(&self) -> u32 {
        self.accounts.len()
    }

    /// The exact bytes signers must sign for one interval (base64), so
    /// off-chain signers can check their own encoding.
    pub fn get_rate_message(&self, feed_id: u32, interval_ts: U64, rate: I128) -> Base64VecU8 {
        Base64VecU8(rate_message(&env::current_account_id(), feed_id, interval_ts.0, rate.0))
    }
}

// =========================================================================
// Internals
// =========================================================================

impl Contract {
    fn assert_gov(&self) {
        require!(env::predecessor_account_id() == self.gov, "governance only");
    }

    fn write_signers(&mut self, signers: Vec<PublicKey>, threshold: u8) {
        require!(!signers.is_empty() && signers.len() <= MAX_SIGNERS, "1..=16 signers");
        require!(threshold >= 1 && threshold as usize <= signers.len(), "bad threshold");
        let mut keys: Vec<[u8; 32]> = Vec::with_capacity(signers.len());
        for pk in signers {
            require!(pk.curve_type() == CurveType::ED25519, "signers must be ed25519");
            let k: [u8; 32] = pk.as_bytes()[1..].try_into().unwrap();
            require!(!keys.contains(&k), "duplicate signer");
            keys.push(k);
        }
        self.signers = keys;
        self.threshold = threshold;
    }

    fn check_params(p: &MarketParams) {
        require!(p.im_factor_bps > 0 && p.mm_ratio_bps > 0 && p.mm_ratio_bps <= 10_000, "bad margin params");
        require!(p.rate_floor.0 > 0 && p.max_dev.0 > 0 && p.taker_fee_rate.0 >= 0, "bad rate params");
        require!(p.mark_window_secs > 0, "bad mark window");
    }

    fn risk(m: &Market) -> RiskParams {
        RiskParams {
            im_factor_bps: m.params.im_factor_bps as i128,
            rate_floor: m.params.rate_floor.0,
            time_floor_secs: m.params.time_floor_secs as i128,
        }
    }

    fn feed(&self, id: u32) -> Feed {
        self.feeds.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such feed"))
    }

    fn market(&self, id: u32) -> Market {
        self.markets.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such market"))
    }

    fn account(&self, id: &AccountId) -> Account {
        self.accounts.get(id).cloned().unwrap_or_else(|| env::panic_str("account not registered"))
    }

    fn effective_mode(&self, m: &Market, now: u64) -> Mode {
        if m.mode == Mode::Paused {
            return Mode::Paused;
        }
        let f = self.feed(m.feed_id);
        if m.mode == Mode::CloseOnly || now > f.last_ts + f.stale_after_secs {
            Mode::CloseOnly
        } else {
            Mode::Active
        }
    }

    /// (index, covered-until timestamp) a position in `m` settles against.
    fn feed_point(&self, m: &Market) -> (i128, u64) {
        match m.final_cum {
            Some(c) => (c, m.maturity_ts),
            None => {
                let f = self.feed(m.feed_id);
                (f.cum, f.last_ts)
            }
        }
    }

    /// How much of a `credit_to` deposit lies above `deposit_cap`. Zero when
    /// there is no cap, no intents contract to forward to, or not enough gas
    /// left to forward: crediting over the cap beats a panic, which would
    /// refund the solver instead of the trader.
    fn excess_over_cap(&self, acc: &Account, amount: i128) -> i128 {
        let (Some(cap), Some(_)) = (self.deposit_cap, &self.intents_contract) else {
            return 0;
        };
        let excess = (acc.cash + amount - cap as i128).clamp(0, amount);
        let gas_left = env::prepaid_gas().saturating_sub(env::used_gas());
        let needed = GAS_FT_TRANSFER_CALL.saturating_add(GAS_CALLBACK).saturating_add(GAS_FORWARD_MARGIN);
        if gas_left < needed {
            return 0;
        }
        excess
    }

    fn credit(&mut self, acc: &mut Account, delta: i128) {
        acc.cash += delta;
        self.total_cash += delta;
    }

    /// Settle pending funding into `acc.cash` without touching contract
    /// state; returns the total delta. `only` limits it to one market.
    fn settle_into(&self, acc: &mut Account, only: Option<u32>) -> i128 {
        let mut delta = 0;
        for p in acc.positions.iter_mut() {
            if only.is_some_and(|m| m != p.market_id) {
                continue;
            }
            let m = self.market(p.market_id);
            let (cum, ts) = self.feed_point(&m);
            if ts > p.snap_ts || cum != p.snap_cum {
                delta += funding_owed(p.n, p.fixed_flow, cum - p.snap_cum, (ts - p.snap_ts) as i128);
                p.snap_cum = cum;
                p.snap_ts = ts;
            }
        }
        acc.cash += delta;
        if only.is_none() {
            // Matured and fully settled positions are worth nothing more.
            // Fully flat positions free their slot.
            acc.positions.retain(|p| {
                (p.n != 0 || p.fixed_flow != 0)
                    && self.markets.get(&p.market_id).is_some_and(|m| m.final_cum.is_none())
            });
        }
        delta
    }

    fn settle_mut(&mut self, _id: &AccountId, acc: &mut Account) {
        let delta = self.settle_into(acc, None);
        self.total_cash += delta;
        // Orders in matured markets can never fill; drop them.
        let now = now_secs();
        let stale: Vec<u64> = acc
            .orders
            .iter()
            .copied()
            .filter(|id| {
                self.orders
                    .get(id)
                    .is_none_or(|o| self.markets.get(&o.market_id).is_none_or(|m| now >= m.maturity_ts))
            })
            .collect();
        for id in stale {
            self.orders.remove(&id);
            acc.orders.retain(|o| *o != id);
        }
    }

    fn settle_market_mut(&mut self, acc: &mut Account, market_id: u32) {
        let delta = self.settle_into(acc, Some(market_id));
        self.total_cash += delta;
    }

    /// Add `q` (signed) at `rate` to the account's position. The position
    /// must already be settled to `point`. Returns (old n, new n).
    fn apply_fill(&self, acc: &mut Account, market_id: u32, point: (i128, u64), q: i128, rate: i128) -> (i128, i128) {
        let idx = match acc.positions.iter().position(|p| p.market_id == market_id) {
            Some(i) => i,
            None => {
                require!(acc.positions.len() < MAX_POSITIONS, "too many positions");
                acc.positions.push(Position {
                    market_id,
                    n: 0,
                    fixed_flow: 0,
                    snap_cum: point.0,
                    snap_ts: point.1,
                });
                acc.positions.len() - 1
            }
        };
        let p = &mut acc.positions[idx];
        let old = p.n;
        p.n += q;
        p.fixed_flow += q * rate;
        (old, p.n)
    }

    fn health(&self, acc: &Account) -> Health {
        let mut h = Health { cash: acc.cash, value: 0, im: 0, mm: 0 };
        for p in &acc.positions {
            let m = self.market(p.market_id);
            let point = self.feed_point(&m);
            let secs_left = m.maturity_ts.saturating_sub(point.1) as i128;
            h.value += position_value(p.n, p.fixed_flow, m.mark, secs_left);
            let im = initial_margin(p.n, m.mark, secs_left, &Self::risk(&m));
            h.im += im;
            h.mm += mul_div_ceil(im, m.params.mm_ratio_bps as i128, BPS);
        }
        for id in &acc.orders {
            let Some(o) = self.orders.get(id) else { continue };
            let m = self.market(o.market_id);
            let point = self.feed_point(&m);
            let secs_left = m.maturity_ts.saturating_sub(point.1) as i128;
            let rate = tick_to_rate(o.tick).abs().max(m.mark.abs());
            h.im += initial_margin(o.remaining, rate, secs_left, &Self::risk(&m));
        }
        h
    }

    /// Bad debt: once an account has no floating exposure left, cover any
    /// negative net balance (cash plus its locked fixed legs) from insurance.
    fn cover_bad_debt_internal(&mut self, id: &AccountId, acc: &mut Account) -> i128 {
        if !acc.positions.iter().all(|p| p.n == 0) {
            return 0;
        }
        let net = self.health(acc).net();
        if net >= 0 {
            return 0;
        }
        let cover = (-net).min(self.insurance.max(0));
        if cover > 0 {
            self.insurance -= cover;
            self.credit(acc, cover);
            emit("bad_debt_covered", json!({"account_id": id, "amount": I128(cover), "remaining": I128(-net - cover)}));
        }
        cover
    }

    fn debit_for_withdrawal(&mut self, id: &AccountId, amount: u128) {
        let mut acc = self.account(id);
        self.settle_mut(id, &mut acc);
        let a = amount as i128;
        require!(a > 0, "zero amount");
        let h = self.health(&acc);
        require!(a <= h.withdrawable(), "exceeds withdrawable balance");
        self.credit(&mut acc, -a);
        self.accounts.insert(id.clone(), acc);
        emit("withdraw", json!({"account_id": id, "amount": U128(amount)}));
    }

    fn remove_order(&mut self, id: u64, order: &Order, acc: &mut Account) {
        if let Some(mut book) = self.books.get(&order.market_id).cloned() {
            let side = if order.side == Side::Long { &mut book.bids } else { &mut book.asks };
            if let Some(i) = side.iter().position(|l| l.tick == order.tick) {
                side[i].orders.retain(|o| *o != id);
                if side[i].orders.is_empty() {
                    side.remove(i);
                }
            }
            self.books.insert(order.market_id, book);
        }
        self.orders.remove(&id);
        acc.orders.retain(|o| *o != id);
    }

    fn cancel_orders(&mut self, acc: &mut Account, market_id: Option<u32>) {
        for id in acc.orders.clone() {
            match self.orders.get(&id).cloned() {
                Some(o) if market_id.is_none_or(|m| m == o.market_id) => self.remove_order(id, &o, acc),
                Some(_) => {}
                None => acc.orders.retain(|x| *x != id),
            }
        }
    }

    fn market_view(&self, id: u32) -> MarketView {
        let m = self.market(id);
        let book = self.books.get(&id).cloned().unwrap_or_default();
        MarketView {
            id,
            feed_id: m.feed_id,
            name: m.name.clone(),
            maturity_ts: m.maturity_ts,
            mode: m.mode,
            effective_mode: self.effective_mode(&m, now_secs()),
            params: m.params.clone(),
            mark: I128(m.mark),
            last_mark_ts: m.last_mark_ts,
            long_oi: I128(m.long_oi),
            final_cum: m.final_cum.map(I128),
            best_bid: book.bids.first().map(|l| l.tick),
            best_ask: book.asks.first().map(|l| l.tick),
            volume_24h: U128(trade_log::volume_24h(id, now_secs())),
        }
    }

    fn order_view(id: u64, o: &Order) -> OrderView {
        OrderView {
            id: U64(id),
            owner: o.owner.clone(),
            market_id: o.market_id,
            side: o.side,
            tick: o.tick,
            remaining: U128(o.remaining as u128),
        }
    }
}

#[cfg(test)]
mod tests;
