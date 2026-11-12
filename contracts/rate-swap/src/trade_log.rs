//! Trade history kept in raw storage under its own key prefix ("tl/", "tu/",
//! "tc/"), so the contract struct (and its borsh layout) is unchanged and an
//! upgrade needs no migration.
//!
//! - per market: the last MARKET_TRADES trades (ring),
//! - per account: the last ACCOUNT_TRADES trades it took part in (ring),
//! - per market and hour: an OHLC candle of trade rates plus volume.
//!
//! All writes for one transaction go through `record`, which loads and stores
//! each ring once however many fills the order produced.

use near_sdk::json_types::{I128, U128};
use near_sdk::{borsh, env, near, AccountId};

use crate::types::Side;

pub const MARKET_TRADES: usize = 60;
pub const ACCOUNT_TRADES: usize = 40;
pub const HOUR: u64 = 3_600;
/// Hourly candles a view may return in one call (two weeks).
pub const MAX_CANDLES: u64 = 24 * 14;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TradeRecord {
    pub ts: u64,
    pub market_id: u32,
    /// Side of the account that crossed the spread (or, for a liquidation,
    /// the liquidator's side).
    pub taker_side: Side,
    pub taker: AccountId,
    pub maker: AccountId,
    pub size: U128,
    /// Fill rate, 1e12 = 100 % APR.
    pub rate: I128,
    pub liquidation: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Candle {
    pub hour_ts: u64,
    pub open: I128,
    pub high: I128,
    pub low: I128,
    pub close: I128,
    /// Notional traded, 1e6 = 1 YU.
    pub volume: U128,
    pub trades: u32,
}

fn key(prefix: &str, rest: &[u8]) -> Vec<u8> {
    [prefix.as_bytes(), rest].concat()
}
fn market_key(id: u32) -> Vec<u8> {
    key("tl/", &id.to_le_bytes())
}
fn account_key(id: &AccountId) -> Vec<u8> {
    key("tu/", id.as_bytes())
}
fn candle_key(id: u32, hour_ts: u64) -> Vec<u8> {
    key("tc/", &[id.to_le_bytes().as_slice(), &hour_ts.to_le_bytes()].concat())
}

fn read<T: borsh::BorshDeserialize>(k: &[u8]) -> Option<T> {
    env::storage_read(k).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("corrupt trade log")))
}
fn write<T: borsh::BorshSerialize>(k: &[u8], v: &T) {
    env::storage_write(k, &borsh::to_vec(v).unwrap_or_else(|_| env::panic_str("serialize")));
}

/// Push `new` onto a ring stored at `k`, keeping the newest `cap`.
fn push_ring(k: &[u8], new: &[&TradeRecord], cap: usize) {
    let mut ring: Vec<TradeRecord> = read(k).unwrap_or_default();
    ring.extend(new.iter().map(|t| (*t).clone()));
    if ring.len() > cap {
        ring.drain(..ring.len() - cap);
    }
    write(k, &ring);
}

/// Store the trades of one transaction.
pub fn record(trades: &[TradeRecord]) {
    if trades.is_empty() {
        return;
    }
    let mut markets: Vec<u32> = trades.iter().map(|t| t.market_id).collect();
    markets.sort_unstable();
    markets.dedup();
    for m in markets {
        let mine: Vec<&TradeRecord> = trades.iter().filter(|t| t.market_id == m).collect();
        push_ring(&market_key(m), &mine, MARKET_TRADES);
        for t in &mine {
            let hour = t.ts / HOUR * HOUR;
            let k = candle_key(m, hour);
            let mut c = read::<Candle>(&k).unwrap_or(Candle {
                hour_ts: hour,
                open: t.rate,
                high: t.rate,
                low: t.rate,
                close: t.rate,
                volume: U128(0),
                trades: 0,
            });
            c.high = I128(c.high.0.max(t.rate.0));
            c.low = I128(c.low.0.min(t.rate.0));
            c.close = t.rate;
            c.volume = U128(c.volume.0 + t.size.0);
            c.trades += 1;
            write(&k, &c);
        }
    }
    let mut accounts: Vec<&AccountId> = trades.iter().flat_map(|t| [&t.taker, &t.maker]).collect();
    accounts.sort_unstable();
    accounts.dedup();
    for a in accounts {
        let mine: Vec<&TradeRecord> = trades.iter().filter(|t| &t.taker == a || &t.maker == a).collect();
        push_ring(&account_key(a), &mine, ACCOUNT_TRADES);
    }
}

/// Newest first.
pub fn market_trades(market_id: u32, limit: usize) -> Vec<TradeRecord> {
    let ring: Vec<TradeRecord> = read(&market_key(market_id)).unwrap_or_default();
    ring.into_iter().rev().take(limit).collect()
}

/// Newest first.
pub fn account_trades(account_id: &AccountId, limit: usize) -> Vec<TradeRecord> {
    let ring: Vec<TradeRecord> = read(&account_key(account_id)).unwrap_or_default();
    ring.into_iter().rev().take(limit).collect()
}

/// Hourly candles with trades in [from, to], oldest first (empty hours
/// skipped). A range longer than MAX_CANDLES hours keeps the newest hours.
pub fn candles(market_id: u32, from_ts: u64, to_ts: u64) -> Vec<Candle> {
    let to = to_ts / HOUR * HOUR;
    let from = (from_ts / HOUR * HOUR).max(to.saturating_sub((MAX_CANDLES - 1) * HOUR));
    (0..)
        .map(|i| from + i * HOUR)
        .take_while(|h| *h <= to)
        .filter_map(|h| read(&candle_key(market_id, h)))
        .collect()
}

/// Notional traded in the last 24 hours (the current hour plus the 23 before it).
pub fn volume_24h(market_id: u32, now: u64) -> u128 {
    let hour = now / HOUR * HOUR;
    (0..24u64).filter_map(|i| read::<Candle>(&candle_key(market_id, hour - i * HOUR))).map(|c| c.volume.0).sum()
}
