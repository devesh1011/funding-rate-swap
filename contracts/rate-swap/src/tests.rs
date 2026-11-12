//! Unit tests against the mocked runtime. Oracle signatures are real
//! ed25519 signatures checked by the runtime's `ed25519_verify`.

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const T0: u64 = 1_800_000_000; // interval-aligned
const HOUR: u64 = 3_600;
const USDC: i128 = 1_000_000;

fn pct(x: f64) -> i128 {
    (x / 100.0 * RATE_ONE as f64).round() as i128
}
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn keys() -> Vec<SigningKey> {
    (1u8..=3).map(|i| SigningKey::from_bytes(&[i; 32])).collect()
}
fn pk(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn ctx(predecessor: &str, now: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(id("swap.testnet"))
        .predecessor_account_id(id(predecessor))
        .block_timestamp(now * 1_000_000_000)
        .attached_deposit(deposit)
        .build());
}

fn params() -> MarketParams {
    MarketParams {
        im_factor_bps: 30_000,
        mm_ratio_bps: 6_600,
        rate_floor: I128(pct(5.0)),
        time_floor_secs: 86_400,
        max_dev: I128(pct(50.0)),
        taker_fee_rate: I128(pct(0.1)),
        mark_window_secs: 900,
        oi_cap: U128(10_000_000 * USDC as u128),
    }
}

struct Env {
    c: Contract,
    now: u64,
    deposited: i128,
}

impl Env {
    fn new() -> Self {
        ctx("gov.testnet", T0 + 60, NearToken::from_yoctonear(0));
        let mut c = Contract::new(
            id("tusdc.testnet"),
            id("gov.testnet"),
            keys().iter().map(pk).collect(),
            2,
            None,
            None,
        );
        c.create_feed("hyperliquid:BTC".into(), HOUR, U64(T0), I128(pct(4.0)), 3 * HOUR);
        c.create_market(0, "BTC-24h".into(), U64(T0 + 24 * HOUR), I128(pct(10.0)), params());
        Env { c, now: T0 + 60, deposited: 0 }
    }

    fn as_(&self, who: &str) {
        ctx(who, self.now, NearToken::from_yoctonear(0));
    }

    fn fund(&mut self, who: &str, usdc: i128) {
        ctx(who, self.now, STORAGE_DEPOSIT);
        self.c.storage_deposit(None, None);
        ctx("tusdc.testnet", self.now, NearToken::from_yoctonear(0));
        let _ = self.c.ft_on_transfer(id(who), U128((usdc * USDC) as u128), String::new());
        self.deposited += usdc * USDC;
    }

    fn sign(&self, ts: u64, rate: i128, signers: &[usize]) -> RateEntry {
        let msg = rate_message(&id("swap.testnet"), 0, ts, rate);
        let ks = keys();
        RateEntry {
            interval_ts: U64(ts),
            rate: I128(rate),
            sigs: signers
                .iter()
                .map(|&i| SignerSig {
                    signer: i as u8,
                    signature: Base64VecU8(ks[i].sign(&msg).to_bytes().to_vec()),
                })
                .collect(),
        }
    }

    /// Advance to the end of the next interval and submit it.
    fn next_rate(&mut self, rate: i128) {
        let ts = self.c.feed(0).last_ts + HOUR;
        self.now = self.now.max(ts + 30);
        let e = self.sign(ts, rate, &[0, 2]);
        self.as_("oracle.testnet");
        self.c.submit_rates(0, vec![e]);
    }

    fn cash(&self, who: &str) -> i128 {
        self.c.get_account(id(who)).unwrap().cash.0
    }

    fn view(&self, who: &str) -> AccountView {
        self.c.get_account(id(who)).unwrap()
    }

    /// Invariant 2: once every account is settled, credited balances never
    /// exceed what the contract holds, and only rounding dust is left over.
    fn assert_solvent(&mut self) {
        self.as_("anyone.testnet");
        for a in self.c.list_accounts(None, None) {
            self.c.settle(a);
        }
        let held = self.deposited;
        let owed = self.c.total_cash + self.c.insurance;
        assert!(owed <= held, "owes {owed} > holds {held}");
        assert!(held - owed < 100, "dust {} too large", held - owed);
    }
}

fn trade_pair(e: &mut Env, size_usdc: i128) {
    // alice rests a short at 10 %, bob lifts it.
    e.as_("alice.testnet");
    let r = e.c.place_order(0, Side::Short, U128((size_usdc * USDC) as u128), 1_000, OrderKind::Limit);
    assert!(r.order_id.is_some());
    e.as_("bob.testnet");
    let r = e.c.place_order(0, Side::Long, U128((size_usdc * USDC) as u128), 0, OrderKind::Market);
    assert_eq!(r.filled.0, (size_usdc * USDC) as u128);
}

// ---------------------------------------------------------------- oracle

#[test]
fn oracle_accepts_quorum_and_accumulates() {
    let mut e = Env::new();
    e.next_rate(pct(0.00125));
    e.next_rate(pct(-0.002));
    let f = e.c.feed(0);
    assert_eq!(f.cum, pct(0.00125) + pct(-0.002));
    assert_eq!(f.last_ts, T0 + 2 * HOUR);
}

#[test]
#[should_panic(expected = "not enough valid signatures")]
fn oracle_rejects_single_signer() {
    let mut e = Env::new();
    e.now = T0 + HOUR + 1;
    let entry = e.sign(T0 + HOUR, pct(0.001), &[1]);
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "not enough valid signatures")]
fn oracle_rejects_duplicate_signer() {
    let mut e = Env::new();
    e.now = T0 + HOUR + 1;
    let mut entry = e.sign(T0 + HOUR, pct(0.001), &[1]);
    entry.sigs.push(entry.sigs[0].clone());
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "not enough valid signatures")]
fn oracle_rejects_tampered_rate() {
    let mut e = Env::new();
    e.now = T0 + HOUR + 1;
    let mut entry = e.sign(T0 + HOUR, pct(0.001), &[0, 1]);
    entry.rate = I128(pct(0.002));
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "interval out of order")]
fn oracle_rejects_skipped_interval() {
    let mut e = Env::new();
    e.now = T0 + 2 * HOUR + 1;
    let entry = e.sign(T0 + 2 * HOUR, pct(0.001), &[0, 1]);
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "interval out of order")]
fn oracle_never_rewrites_an_interval() {
    let mut e = Env::new();
    e.next_rate(pct(0.001));
    let entry = e.sign(T0 + HOUR, pct(0.002), &[0, 1]);
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "interval in the future")]
fn oracle_rejects_future_interval() {
    let mut e = Env::new();
    let entry = e.sign(T0 + HOUR, pct(0.001), &[0, 1]);
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
#[should_panic(expected = "rate outside clamp")]
fn oracle_rejects_rate_beyond_hyperliquid_cap() {
    let mut e = Env::new();
    e.now = T0 + HOUR + 1;
    let entry = e.sign(T0 + HOUR, pct(4.01), &[0, 1]);
    e.as_("oracle.testnet");
    e.c.submit_rates(0, vec![entry]);
}

#[test]
fn oracle_batch_backfills_in_order() {
    let mut e = Env::new();
    e.now = T0 + 3 * HOUR + 5;
    let batch = (1..=3).map(|i| e.sign(T0 + i * HOUR, pct(0.001), &[1, 2])).collect();
    e.as_("anyone.testnet");
    e.c.submit_rates(0, batch);
    assert_eq!(e.c.feed(0).last_ts, T0 + 3 * HOUR);
}

// ---------------------------------------------------------------- deposits

#[test]
fn deposit_from_registered_sender() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    assert_eq!(e.cash("alice.testnet"), 1_000 * USDC);
    e.assert_solvent();
}

#[test]
fn deposit_from_unregistered_sender_is_refunded() {
    let mut e = Env::new();
    ctx("tusdc.testnet", e.now, NearToken::from_yoctonear(0));
    let r = e.c.ft_on_transfer(id("stranger.testnet"), U128(5), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(5))));
}

#[test]
fn credit_to_never_refunds_and_registers() {
    let mut e = Env::new();
    ctx("tusdc.testnet", e.now, NearToken::from_yoctonear(0));
    let r = e.c.ft_on_transfer(
        id("solver.near"),
        U128(7 * USDC as u128),
        r#"{"credit_to":"trader.testnet"}"#.into(),
    );
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    e.deposited += 7 * USDC;
    let v = e.view("trader.testnet");
    assert_eq!(v.cash.0, 7 * USDC);
    assert!(!v.storage_paid, "auto-registered accounts still pay storage before trading");
    e.assert_solvent();
}

#[test]
#[should_panic(expected = "unsupported token")]
fn other_tokens_rejected() {
    let mut e = Env::new();
    ctx("evil.testnet", e.now, NearToken::from_yoctonear(0));
    let _ = e.c.ft_on_transfer(id("alice.testnet"), U128(1), String::new());
}

// ---------------------------------------------------------------- trading

#[test]
fn trade_then_funding_is_zero_sum() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.fund("bob.testnet", 1_000);
    trade_pair(&mut e, 100_000);

    let a = e.view("alice.testnet");
    assert_eq!(a.positions[0].n.0, -100_000 * USDC);
    assert_eq!(a.positions[0].avg_rate.as_ref().unwrap().0, pct(10.0));
    let fee = 1_000 * USDC - e.cash("bob.testnet");
    assert!(fee > 0, "taker paid a fee");

    let (a0, b0) = (e.cash("alice.testnet"), e.cash("bob.testnet"));
    e.next_rate(pct(0.00125)); // 10.95 % annualised, above the 10 % fixed
    let (a1, b1) = (e.cash("alice.testnet"), e.cash("bob.testnet"));
    // Long receives 1.25 floating, pays 1.1416 fixed → +0.1084.
    assert_eq!(b1 - b0, 108_447);
    assert_eq!(a1 - a0, -108_448);

    e.as_("anyone.testnet");
    e.c.settle(id("alice.testnet"));
    e.c.settle(id("bob.testnet"));
    e.assert_solvent();
}

#[test]
fn price_then_time_priority() {
    let mut e = Env::new();
    for w in ["m1.testnet", "m2.testnet", "m3.testnet", "bob.testnet"] {
        e.fund(w, 10_000);
    }
    e.as_("m1.testnet");
    e.c.place_order(0, Side::Short, U128(1_000 * USDC as u128), 1_100, OrderKind::Limit);
    e.as_("m2.testnet");
    e.c.place_order(0, Side::Short, U128(1_000 * USDC as u128), 1_000, OrderKind::Limit);
    e.as_("m3.testnet");
    e.c.place_order(0, Side::Short, U128(1_000 * USDC as u128), 1_000, OrderKind::Limit);

    let book = e.c.get_book(0, None);
    assert_eq!(book.asks.iter().map(|l| l.tick).collect::<Vec<_>>(), vec![1_000, 1_100]);

    e.as_("bob.testnet");
    e.c.place_order(0, Side::Long, U128(1_500 * USDC as u128), 1_100, OrderKind::Ioc);
    // Best price first (m2 then m3 at 1000, by time), m1 at 1100 untouched.
    assert_eq!(e.view("m2.testnet").positions[0].n.0, -1_000 * USDC);
    assert_eq!(e.view("m3.testnet").positions[0].n.0, -500 * USDC);
    assert!(e.view("m1.testnet").positions.is_empty());
    e.assert_solvent();
}

#[test]
#[should_panic(expected = "order would self-trade")]
fn self_trade_rejected() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.as_("alice.testnet");
    e.c.place_order(0, Side::Short, U128(1_000 * USDC as u128), 1_000, OrderKind::Limit);
    e.c.place_order(0, Side::Long, U128(1_000 * USDC as u128), 1_000, OrderKind::Ioc);
}

#[test]
#[should_panic(expected = "insufficient margin")]
fn trade_beyond_margin_rejected() {
    let mut e = Env::new();
    e.fund("alice.testnet", 10);
    e.as_("alice.testnet");
    // IM ≈ 3 × 100,000 × 1/365 × 10 % ≈ $82 > $10.
    e.c.place_order(0, Side::Short, U128(100_000 * USDC as u128), 1_000, OrderKind::Limit);
}

#[test]
#[should_panic(expected = "rate outside band")]
fn order_outside_band_rejected() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.as_("alice.testnet");
    e.c.place_order(0, Side::Short, U128(USDC as u128), 7_000, OrderKind::Limit);
}

#[test]
fn closing_locks_spread_and_frees_margin() {
    let mut e = Env::new();
    for w in ["alice.testnet", "bob.testnet", "carol.testnet"] {
        e.fund(w, 1_000);
    }
    trade_pair(&mut e, 10_000);
    // bob sells his long to carol at 12 %.
    e.as_("carol.testnet");
    e.c.place_order(0, Side::Long, U128(10_000 * USDC as u128), 1_200, OrderKind::Limit);
    e.as_("bob.testnet");
    e.c.place_order(0, Side::Short, U128(10_000 * USDC as u128), 1_200, OrderKind::Ioc);

    let b = e.view("bob.testnet");
    assert_eq!(b.positions[0].n.0, 0);
    assert_eq!(b.health.initial_margin.0, 0, "no floating exposure left");
    assert!(b.positions[0].value.0 > 0, "locked 2 % spread has value");
    // Bob's locked spread pays out as funding arrives, whatever the rate.
    let before = e.cash("bob.testnet");
    e.next_rate(pct(0.5));
    assert_eq!(e.cash("bob.testnet") - before, 22_831); // 10k × 2 % / 8760, floored
    e.assert_solvent();
}

#[test]
fn close_only_when_oracle_is_stale() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.now = T0 + 2 * HOUR;
    e.as_("anyone.testnet");
    assert_eq!(e.c.get_market(0).unwrap().effective_mode, Mode::Active);
    e.now = T0 + 4 * HOUR;
    e.as_("anyone.testnet");
    assert_eq!(e.c.get_market(0).unwrap().effective_mode, Mode::CloseOnly);
}

// ---------------------------------------------------------------- risk

#[test]
fn liquidation_transfers_position_and_pays_penalty() {
    let mut e = Env::new();
    e.fund("alice.testnet", 5_000);
    e.fund("bob.testnet", 90);
    e.fund("carol.testnet", 5_000);
    trade_pair(&mut e, 100_000);
    assert!(!e.view("bob.testnet").health.liquidatable);

    // Funding goes against the long for one hour: −0.05 % → about −$51.
    e.next_rate(pct(-0.05));
    assert!(e.view("bob.testnet").health.liquidatable);

    let carol_before = e.cash("carol.testnet");
    e.as_("carol.testnet");
    let penalty = e.c.liquidate(id("bob.testnet"), 0).0;
    assert!(penalty > 0);
    assert_eq!(e.cash("carol.testnet") - carol_before, penalty);
    // Taken over at the mark the fixed legs cancel, so bob is flat.
    assert!(e.view("bob.testnet").positions.iter().all(|p| p.n.0 == 0));
    assert_eq!(e.view("carol.testnet").positions[0].n.0, 100_000 * USDC);
    e.assert_solvent();
}

#[test]
#[should_panic(expected = "account is healthy")]
fn healthy_accounts_cannot_be_liquidated() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.fund("bob.testnet", 1_000);
    e.fund("carol.testnet", 1_000);
    trade_pair(&mut e, 10_000);
    e.as_("carol.testnet");
    e.c.liquidate(id("bob.testnet"), 0);
}

#[test]
fn withdrawable_excludes_margin_and_unrealized_gains() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.fund("bob.testnet", 1_000);
    trade_pair(&mut e, 100_000);
    let h = e.view("bob.testnet").health;
    assert_eq!(h.withdrawable.0, h.cash.0 + h.value.0.min(0) - h.initial_margin.0);
}

#[test]
#[should_panic(expected = "exceeds withdrawable balance")]
fn cannot_withdraw_margin() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.fund("bob.testnet", 1_000);
    trade_pair(&mut e, 100_000);
    ctx("bob.testnet", e.now, NearToken::from_yoctonear(1));
    let _ = e.c.withdraw(U128(1_000 * USDC as u128));
}

// ---------------------------------------------------------------- maturity

#[test]
fn maturity_settles_and_releases_everything() {
    let mut e = Env::new();
    e.fund("alice.testnet", 1_000);
    e.fund("bob.testnet", 1_000);
    trade_pair(&mut e, 10_000);
    let bob_after_trade = e.cash("bob.testnet");
    for _ in 0..24 {
        e.next_rate(pct(0.00125));
    }
    assert!(e.c.get_market(0).unwrap().final_cum.is_some());
    // Rates after maturity do not reach matured positions.
    e.next_rate(pct(1.0));
    e.as_("anyone.testnet");
    e.c.settle(id("alice.testnet"));
    e.c.settle(id("bob.testnet"));
    for who in ["alice.testnet", "bob.testnet"] {
        let v = e.view(who);
        assert!(v.positions.is_empty());
        assert_eq!(v.health.withdrawable.0, v.cash.0);
    }
    // 24 h at 10.95 % floating vs 10 % fixed on $10k ≈ +$0.2603 to the long.
    let gain = e.cash("bob.testnet") - bob_after_trade;
    assert!((260_200..=260_300).contains(&gain), "gain {gain}");
    e.assert_solvent();
}

#[test]
fn rate_message_layout_is_stable() {
    // Pinned bytes: the off-chain signer has the same test vector.
    let m = rate_message(&id("swap.testnet"), 0, T0 + HOUR, 12_500_000);
    let hex: String = m.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex,
        "1000000066756e64737761702d726174652d76310c000000737761702e746573746e65740000000010e0496b0000000020bcbe00000000000000000000000000"
    );
}
