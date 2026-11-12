//! Fixed-point maths for the rate swap. Pure functions, no state.
//!
//! Units:
//! - USDC amounts and notionals: token base units (1e6 per USDC).
//! - Rates (per-interval funding fractions, APRs, the cumulative index): 1e12 = 1.0.
//! - Time: seconds.
//!
//! Every rounding goes against the account the amount belongs to, so the
//! contract never owes more than it holds.

pub const RATE_ONE: i128 = 1_000_000_000_000;
pub const YEAR_SECS: i128 = 31_536_000;
/// One order-book tick = 1 basis point of APR.
pub const TICK: i128 = RATE_ONE / 10_000;
pub const BPS: i128 = 10_000;

/// `a * b / d`, rounded toward negative infinity. Panics on overflow (`overflow-checks`).
pub fn mul_div_floor(a: i128, b: i128, d: i128) -> i128 {
    div_floor(a * b, d)
}

/// `a * b / d`, rounded toward positive infinity.
pub fn mul_div_ceil(a: i128, b: i128, d: i128) -> i128 {
    -div_floor(-(a * b), d)
}

pub fn div_floor(n: i128, d: i128) -> i128 {
    assert!(d > 0, "division by non-positive");
    let q = n / d;
    if n % d != 0 && n < 0 { q - 1 } else { q }
}

pub fn tick_to_rate(tick: i32) -> i128 {
    tick as i128 * TICK
}

/// Funding owed to a position (negative = the position pays) between two
/// snapshots of the feed: floating leg minus the locked fixed leg.
///
/// `n` is signed notional (long YU > 0), `fixed_flow` is Σ(size × rate) of
/// every fill, `d_cum` the change in the cumulative per-interval funding
/// index, `d_secs` the seconds of funding covered.
pub fn funding_owed(n: i128, fixed_flow: i128, d_cum: i128, d_secs: i128) -> i128 {
    div_floor(n * d_cum * YEAR_SECS - fixed_flow * d_secs, YEAR_SECS * RATE_ONE)
}

/// Mark-to-market value of a position with `secs_left` of funding still to
/// come: what the remaining fixed leg is worth if floating pays `mark` APR.
pub fn position_value(n: i128, fixed_flow: i128, mark: i128, secs_left: i128) -> i128 {
    div_floor((n * mark - fixed_flow) * secs_left, YEAR_SECS * RATE_ONE)
}

pub struct RiskParams {
    pub im_factor_bps: i128,
    pub rate_floor: i128,
    pub time_floor_secs: i128,
}

/// Initial margin for `size` of exposure at `rate` APR with `secs_left` to
/// maturity: IMf × |N| × max(τ, τ_floor) × max(|rate|, rate_floor).
pub fn initial_margin(size: i128, rate: i128, secs_left: i128, p: &RiskParams) -> i128 {
    if size == 0 {
        return 0;
    }
    let r = rate.abs().max(p.rate_floor);
    let t = secs_left.max(p.time_floor_secs);
    let per_year = mul_div_ceil(size.abs(), r, RATE_ONE);
    mul_div_ceil(per_year * t, p.im_factor_bps, YEAR_SECS * BPS)
}

/// Taker fee: an APR charged on the notional for the time left.
pub fn taker_fee(size: i128, fee_rate: i128, secs_left: i128) -> i128 {
    mul_div_ceil(mul_div_ceil(size.abs(), fee_rate, RATE_ONE), secs_left, YEAR_SECS)
}

/// Time-weighted EMA step for the mark rate.
pub fn next_mark(mark: i128, trade_rate: i128, elapsed_secs: i128, window_secs: i128) -> i128 {
    let w = elapsed_secs.clamp(0, window_secs);
    mark + (trade_rate - mark) * w / window_secs
}

/// Liquidation penalty share of maintenance margin, in bps: 25 % at the
/// maintenance line, rising linearly to 50 % at zero net balance.
pub fn liquidation_penalty_bps(net: i128, mm: i128) -> i128 {
    if mm <= 0 {
        return 2_500;
    }
    let shortfall = (mm - net.max(0)).clamp(0, mm);
    2_500 + 2_500 * shortfall / mm
}

#[cfg(test)]
mod tests {
    use super::*;

    const USDC: i128 = 1_000_000;
    const DAY: i128 = 86_400;

    fn pct(x: f64) -> i128 {
        (x / 100.0 * RATE_ONE as f64).round() as i128
    }

    #[test]
    fn rounding_goes_against_the_holder() {
        assert_eq!(div_floor(7, 2), 3);
        assert_eq!(div_floor(-7, 2), -4);
        assert_eq!(mul_div_ceil(7, 1, 2), 4);
        assert_eq!(mul_div_ceil(-7, 1, 2), -3);
    }

    /// Design-page worked example: long 100,000 YU at 10 %, one hour of
    /// funding at 0.00125 % → receives $1.25, pays $1.14, net about +$0.11.
    #[test]
    fn one_hour_of_funding() {
        let n = 100_000 * USDC;
        let flow = n * pct(10.0);
        let owed = funding_owed(n, flow, pct(0.00125), 3_600);
        // 1.25 − 100000 × 0.10 / 8760 = 1.25 − 1.141552… = 0.108447…
        assert_eq!(owed, 108_447);
        // The short side owes the exact negative, rounded against it.
        let short = funding_owed(-n, -flow, pct(0.00125), 3_600);
        assert_eq!(short, -108_448);
        assert!(owed + short <= 0);
    }

    /// Mark moves to 12 % with six days left: unrealized = 100,000 × 0.02 × 6/365 ≈ $32.88.
    #[test]
    fn mark_to_market() {
        let n = 100_000 * USDC;
        let v = position_value(n, n * pct(10.0), pct(12.0), 6 * DAY);
        assert_eq!(v, 32_876_712); // $32.876712
    }

    /// IMf 3 × 100,000 × 7/365 × 10 % ≈ $575.34.
    #[test]
    fn initial_margin_example() {
        let p = RiskParams { im_factor_bps: 30_000, rate_floor: pct(5.0), time_floor_secs: DAY };
        let im = initial_margin(100_000 * USDC, pct(10.0), 7 * DAY, &p);
        assert_eq!(im, 575_342_466);
        // Rate and time floors kick in.
        let floored = initial_margin(100_000 * USDC, pct(1.0), 3_600, &p);
        assert_eq!(floored, initial_margin(100_000 * USDC, pct(5.0), DAY, &p));
    }

    #[test]
    fn closing_locks_the_spread() {
        // Long 100k at 10 %, then sell 100k at 12 %: n = 0, flow = −2 % × 100k.
        let n = 100_000 * USDC;
        let flow = n * pct(10.0) - n * pct(12.0);
        // No floating exposure left: funding at any rate pays the locked 2 %.
        let a = funding_owed(0, flow, pct(0.5), 3_600);
        let b = funding_owed(0, flow, 0, 3_600);
        assert_eq!(a, b);
        assert_eq!(b, 228_310); // 100000 × 0.02 / 8760 = $0.2283
    }

    #[test]
    fn mark_ema_and_penalty() {
        assert_eq!(next_mark(pct(10.0), pct(12.0), 450, 900), pct(11.0));
        assert_eq!(next_mark(pct(10.0), pct(12.0), 0, 900), pct(10.0));
        assert_eq!(next_mark(pct(10.0), pct(12.0), 5_000, 900), pct(12.0));
        assert_eq!(liquidation_penalty_bps(100, 100), 2_500);
        assert_eq!(liquidation_penalty_bps(0, 100), 5_000);
        assert_eq!(liquidation_penalty_bps(-50, 100), 5_000);
        assert_eq!(liquidation_penalty_bps(50, 100), 3_750);
    }
}
