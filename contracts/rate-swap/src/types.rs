//! Stored state (Borsh) and the JSON shapes the contract exposes.

use near_sdk::json_types::{Base64VecU8, I128, U128, U64};
use near_sdk::{near, AccountId, PublicKey};

// ---------- limits: every loop in the contract is bounded by one of these ----------

pub const MAX_FILLS: usize = 16;
pub const MAX_LEVELS: usize = 32;
pub const MAX_ORDERS_PER_LEVEL: usize = 16;
pub const MAX_OPEN_ORDERS: usize = 32;
pub const MAX_POSITIONS: usize = 8;
pub const MAX_MARKETS_PER_FEED: usize = 8;
pub const MAX_RATE_BATCH: usize = 24;
pub const MAX_SIGNERS: usize = 16;
/// 100,000,000 USDC of notional in one order.
pub const MAX_ORDER_SIZE: i128 = 100_000_000 * 1_000_000;
/// ±500 % APR.
pub const MAX_ABS_TICK: i32 = 50_000;

// ---------- enums shared by state and JSON ----------

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// Long YU: pay fixed, receive floating.
    Long,
    /// Short YU: pay floating, receive fixed.
    Short,
}

impl Side {
    pub fn sign(self) -> i128 {
        match self {
            Side::Long => 1,
            Side::Short => -1,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Active,
    /// Only orders that shrink an existing position are accepted.
    CloseOnly,
    /// No trading or liquidation. Cancels, settlement and withdrawals still work.
    Paused,
}

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// Rest whatever does not fill.
    Limit,
    /// Fill what crosses now, drop the rest.
    Ioc,
    /// IOC at the edge of the rate band; `tick` is ignored.
    Market,
}

// ---------- stored state ----------

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct MarketParams {
    /// Initial-margin multiplier, bps (30000 = 3×).
    pub im_factor_bps: u32,
    /// Maintenance as a share of initial margin, bps (6600 = 0.66).
    pub mm_ratio_bps: u32,
    /// Minimum |rate| used for margin, 1e12 = 100 % APR.
    pub rate_floor: I128,
    /// Minimum time to maturity used for margin.
    pub time_floor_secs: u64,
    /// Max distance of any order rate from the mark, 1e12 = 100 % APR.
    pub max_dev: I128,
    /// Taker fee, an APR on notional × time left, 1e12 = 100 %.
    pub taker_fee_rate: I128,
    /// Mark EMA window.
    pub mark_window_secs: u64,
    /// Cap on long open interest, USDC base units.
    pub oi_cap: U128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Feed {
    pub name: String,
    pub interval_secs: u64,
    /// Σ per-interval funding fractions, 1e12 scale.
    pub cum: i128,
    /// End timestamp (secs) of the last accepted interval.
    pub last_ts: u64,
    /// Max |rate| accepted for one interval.
    pub clamp: i128,
    /// Markets switch to CloseOnly when no interval lands for this long.
    pub stale_after_secs: u64,
    pub markets: Vec<u32>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Market {
    pub feed_id: u32,
    pub name: String,
    pub maturity_ts: u64,
    pub mode: Mode,
    pub params: MarketParams,
    /// Mark APR, 1e12 scale.
    pub mark: i128,
    pub last_mark_ts: u64,
    pub long_oi: i128,
    /// Index value at maturity, set when the maturity interval is accepted.
    pub final_cum: Option<i128>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Level {
    pub tick: i32,
    /// FIFO: index 0 has time priority.
    pub orders: Vec<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Book {
    /// Highest tick first.
    pub bids: Vec<Level>,
    /// Lowest tick first.
    pub asks: Vec<Level>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Order {
    pub owner: AccountId,
    pub market_id: u32,
    pub side: Side,
    pub tick: i32,
    pub remaining: i128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub market_id: u32,
    /// Signed notional, USDC base units. Long YU > 0.
    pub n: i128,
    /// Σ fill size × fill rate. The locked fixed leg, including spreads
    /// locked by closing trades.
    pub fixed_flow: i128,
    pub snap_cum: i128,
    pub snap_ts: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Account {
    pub cash: i128,
    /// Paid the flat NEAR storage deposit, so it may place orders.
    pub storage_paid: bool,
    pub positions: Vec<Position>,
    pub orders: Vec<u64>,
}

// ---------- JSON inputs ----------

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignerSig {
    /// Index into the contract's signer list.
    pub signer: u8,
    /// 64-byte ed25519 signature over `rate_message(...)`.
    pub signature: Base64VecU8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RateEntry {
    /// Venue funding timestamp (secs) that closes the interval.
    pub interval_ts: U64,
    /// Funding fraction paid for this interval, 1e12 scale.
    pub rate: I128,
    pub sigs: Vec<SignerSig>,
}

/// `msg` accepted by `ft_on_transfer`. Empty string = credit the sender.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct DepositMsg {
    /// Credit this account instead of the sender (1Click deposits).
    pub credit_to: Option<AccountId>,
    /// Donate to the insurance fund.
    pub insurance: Option<bool>,
}

// ---------- JSON views ----------

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub collateral: AccountId,
    pub gov: AccountId,
    pub intents_contract: Option<AccountId>,
    pub signers: Vec<PublicKey>,
    pub threshold: u8,
    pub insurance: I128,
    pub total_cash: I128,
    pub deposit_cap: Option<U128>,
    pub storage_deposit: U128,
}

#[near(serializers = [json])]
pub struct FeedView {
    pub id: u32,
    pub name: String,
    pub interval_secs: u64,
    pub cum: I128,
    pub last_ts: u64,
    pub clamp: I128,
    pub stale_after_secs: u64,
    pub markets: Vec<u32>,
}

#[near(serializers = [json])]
pub struct MarketView {
    pub id: u32,
    pub feed_id: u32,
    pub name: String,
    pub maturity_ts: u64,
    pub mode: Mode,
    pub effective_mode: Mode,
    pub params: MarketParams,
    pub mark: I128,
    pub last_mark_ts: u64,
    pub long_oi: I128,
    pub final_cum: Option<I128>,
    pub best_bid: Option<i32>,
    pub best_ask: Option<i32>,
}

#[near(serializers = [json])]
pub struct LevelView {
    pub tick: i32,
    pub size: U128,
    pub orders: u32,
}

#[near(serializers = [json])]
pub struct BookView {
    pub bids: Vec<LevelView>,
    pub asks: Vec<LevelView>,
}

#[near(serializers = [json])]
pub struct OrderView {
    pub id: U64,
    pub owner: AccountId,
    pub market_id: u32,
    pub side: Side,
    pub tick: i32,
    pub remaining: U128,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub market_id: u32,
    pub n: I128,
    pub fixed_flow: I128,
    /// fixed_flow / n, 1e12 scale. None when flat.
    pub avg_rate: Option<I128>,
    pub value: I128,
    pub initial_margin: I128,
    pub secs_left: u64,
}

#[near(serializers = [json])]
pub struct HealthView {
    pub cash: I128,
    pub value: I128,
    pub net: I128,
    pub initial_margin: I128,
    pub maintenance_margin: I128,
    pub liquidatable: bool,
    pub withdrawable: I128,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub account_id: AccountId,
    /// Cash after settling all pending funding.
    pub cash: I128,
    pub storage_paid: bool,
    pub positions: Vec<PositionView>,
    pub orders: Vec<OrderView>,
    pub health: HealthView,
}

#[near(serializers = [json])]
pub struct PlaceResult {
    pub filled: U128,
    pub order_id: Option<U64>,
}
