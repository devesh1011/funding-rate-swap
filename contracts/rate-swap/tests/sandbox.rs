//! End-to-end on a local NEAR node (near-sandbox) with a real NEP-141 token:
//! deposit (both msg paths) → trade → signed funding → settle → withdraw,
//! the failed-withdrawal restore path, and a function-call session key.
//! After each step: Σ credited balances ≤ tokens the contract holds.

use ed25519_dalek::{Signer as _, SigningKey};
use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use near_sdk::serde_json::{json, Value};
use std::sync::Arc;

const USDC: u128 = 1_000_000;
const HOUR: u64 = 3_600;

type R<T> = testresult::TestResult<T>;

struct Ctx {
    net: NetworkConfig,
    signer: Arc<Signer>,
    token: Contract,
    swap: Contract,
}

impl Ctx {
    async fn call(&self, who: &AccountId, c: &Contract, m: &str, args: Value, deposit: NearToken) -> R<near_api::types::transaction::result::TransactionResult> {
        Ok(c.call_function(m, args)
            .transaction()
            .gas(NearGas::from_tgas(300))
            .deposit(deposit)
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn ok(&self, who: &AccountId, c: &Contract, m: &str, args: Value, deposit: NearToken) -> R<()> {
        let r = self.call(who, c, m, args, deposit).await?;
        r.assert_success();
        Ok(())
    }

    async fn view(&self, c: &Contract, m: &str, args: Value) -> R<Value> {
        Ok(c.call_function(m, args).read_only::<Value>().fetch_from(&self.net).await?.data)
    }

    async fn token_balance(&self, who: &AccountId) -> R<u128> {
        let v = self.view(&self.token, "ft_balance_of", json!({"account_id": who})).await?;
        Ok(v.as_str().unwrap().parse()?)
    }

    async fn cash(&self, who: &AccountId) -> R<i128> {
        let v = self.view(&self.swap, "get_account", json!({"account_id": who})).await?;
        Ok(v["cash"].as_str().unwrap().parse()?)
    }

    /// Settle everyone, then Σ cash + insurance ≤ token balance of the contract.
    async fn assert_solvent(&self, anyone: &AccountId) -> R<()> {
        let accounts = self.view(&self.swap, "list_accounts", json!({})).await?;
        for a in accounts.as_array().unwrap() {
            self.ok(anyone, &self.swap, "settle", json!({"account_id": a}), NearToken::from_yoctonear(0)).await?;
        }
        let cfg = self.view(&self.swap, "get_config", json!({})).await?;
        let owed: i128 = cfg["total_cash"].as_str().unwrap().parse::<i128>()?
            + cfg["insurance"].as_str().unwrap().parse::<i128>()?;
        let held = self.token_balance(self.swap.account_id()).await? as i128;
        assert!(owed <= held, "owes {owed} > holds {held}");
        assert!(held - owed < 100, "unexplained surplus {}", held - owed);
        Ok(())
    }
}

fn keys() -> Vec<SigningKey> {
    (1u8..=3).map(|i| SigningKey::from_bytes(&[i; 32])).collect()
}

fn near_pk(k: &SigningKey) -> String {
    format!("ed25519:{}", near_sdk::bs58::encode(k.verifying_key().to_bytes()).into_string())
}

async fn account(sandbox: &near_sandbox::Sandbox, name: &str) -> R<AccountId> {
    let id: AccountId = name.parse()?;
    sandbox.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(20)).send().await?;
    Ok(id)
}

fn build(manifest: &str) -> R<Vec<u8>> {
    let opts = cargo_near_build::BuildOpts::builder().manifest_path(manifest).build();
    Ok(std::fs::read(cargo_near_build::build_with_cli(opts)?)?)
}

#[tokio::test]
async fn end_to_end_on_sandbox() -> R<()> {
    let swap_wasm = build("Cargo.toml")?;
    let token_wasm = build("../test-token/Cargo.toml")?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let gov = account(&sandbox, "gov.sandbox").await?;
    let alice = account(&sandbox, "alice.sandbox").await?;
    let bob = account(&sandbox, "bob.sandbox").await?;
    let carol = account(&sandbox, "carol.sandbox").await?;
    let oracle = account(&sandbox, "oracle.sandbox").await?;
    let token_id = account(&sandbox, "tusdc.sandbox").await?;
    let swap_id = account(&sandbox, "swap.sandbox").await?;
    let zero = NearToken::from_yoctonear(0);
    let one = NearToken::from_yoctonear(1);

    Contract::deploy(token_id.clone())
        .use_code(token_wasm)
        .with_init_call("new_default_meta", json!({"owner_id": gov, "total_supply": (1_000_000 * USDC).to_string()}))?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    Contract::deploy(swap_id.clone())
        .use_code(swap_wasm)
        .with_init_call(
            "new",
            json!({"collateral": token_id, "gov": gov, "signers": keys().iter().map(near_pk).collect::<Vec<_>>(), "threshold": 2}),
        )?
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();

    let c = Ctx { net, signer, token: Contract(token_id.clone()), swap: Contract(swap_id.clone()) };

    // Token storage for the swap contract and the traders; seed balances.
    for who in [&swap_id, &alice, &bob] {
        c.ok(&gov, &c.token, "storage_deposit", json!({"account_id": who}), NearToken::from_millinear(10)).await?;
        if who != &swap_id {
            c.ok(&gov, &c.token, "ft_transfer", json!({"receiver_id": who, "amount": (10_000 * USDC).to_string()}), one).await?;
        }
    }

    // Feed starts two intervals in the past so we can submit real signed rates now.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let start = now / HOUR * HOUR - 2 * HOUR;
    c.ok(&gov, &c.swap, "create_feed", json!({"name": "hyperliquid:BTC", "interval_secs": HOUR, "start_ts": start.to_string(), "clamp": "40000000000", "stale_after_secs": 6 * HOUR}), zero).await?;
    c.ok(&gov, &c.swap, "create_market", json!({
        "feed_id": 0, "name": "BTC-48h", "maturity_ts": (start + 48 * HOUR).to_string(), "initial_mark": "100000000000",
        "params": {"im_factor_bps": 30000, "mm_ratio_bps": 6600, "rate_floor": "50000000000", "time_floor_secs": 86400,
                   "max_dev": "500000000000", "taker_fee_rate": "1000000000", "mark_window_secs": 900, "oi_cap": (10_000_000 * USDC).to_string()}
    }), zero).await?;

    // Alice: register, deposit with msg "" (credits the sender).
    c.ok(&alice, &c.swap, "storage_deposit", json!({}), NearToken::from_millinear(100)).await?;
    c.ok(&alice, &c.token, "ft_transfer_call", json!({"receiver_id": swap_id, "amount": (1_000 * USDC).to_string(), "msg": ""}), one).await?;
    assert_eq!(c.cash(&alice).await?, 1_000 * USDC as i128);

    // Bob: deposited *by someone else* with credit_to (the 1Click path), registers afterwards.
    c.ok(&gov, &c.token, "ft_transfer_call", json!({"receiver_id": swap_id, "amount": (1_000 * USDC).to_string(), "msg": json!({"credit_to": bob}).to_string()}), one).await?;
    assert_eq!(c.cash(&bob).await?, 1_000 * USDC as i128);
    c.ok(&bob, &c.swap, "storage_deposit", json!({}), NearToken::from_millinear(100)).await?;
    c.assert_solvent(&oracle).await?;

    // Bob trades through a function-call session key: no deposit, limited methods.
    let session = near_api::signer::generate_secret_key()?;
    near_api::Account(bob.clone())
        .add_key(
            AccessKeyPermission::FunctionCall(FunctionCallPermission {
                allowance: Some(NearToken::from_millinear(250)),
                receiver_id: swap_id.to_string(),
                method_names: vec!["place_order".into(), "cancel_order".into(), "cancel_all".into(), "settle".into()],
            }),
            session.public_key(),
        )
        .with_signer(c.signer.clone())
        .send_to(&c.net)
        .await?
        .assert_success();
    let session_signer = Signer::from_secret_key(session)?;

    c.ok(&alice, &c.swap, "place_order", json!({"market_id": 0, "side": "Short", "size": (100_000 * USDC).to_string(), "tick": 1000, "kind": "Limit"}), zero).await?;
    c.swap
        .call_function("place_order", json!({"market_id": 0, "side": "Long", "size": (100_000 * USDC).to_string(), "tick": 0, "kind": "Market"}))
        .transaction()
        .gas(NearGas::from_tgas(100))
        .with_signer(bob.clone(), session_signer.clone())
        .send_to(&c.net)
        .await?
        .assert_success();
    // The session key cannot withdraw (needs a deposit, which function-call keys can't attach).
    let denied = c.swap
        .call_function("withdraw", json!({"amount": "1"}))
        .transaction()
        .deposit(one)
        .with_signer(bob.clone(), session_signer)
        .send_to(&c.net)
        .await;
    assert!(denied.is_err() || denied.unwrap().into_result().is_err(), "session key must not withdraw");

    let acct = c.view(&c.swap, "get_account", json!({"account_id": bob})).await?;
    assert_eq!(acct["positions"][0]["n"], json!((100_000 * USDC).to_string()));
    c.assert_solvent(&oracle).await?;

    // Two real signed funding intervals, submitted in one batch by anyone.
    let ks = keys();
    let mut entries = vec![];
    for (i, rate) in [(1u64, 12_500_000i128), (2, -2_000_000)] {
        let ts = start + i * HOUR;
        let msg = c.view(&c.swap, "get_rate_message", json!({"feed_id": 0, "interval_ts": ts.to_string(), "rate": rate.to_string()})).await?;
        let bytes = B64.decode(msg.as_str().unwrap())?;
        let sigs: Vec<Value> = [0usize, 2]
            .iter()
            .map(|&k| json!({"signer": k, "signature": B64.encode(ks[k].sign(&bytes).to_bytes())}))
            .collect();
        entries.push(json!({"interval_ts": ts.to_string(), "rate": rate.to_string(), "sigs": sigs}));
    }
    let (a0, b0) = (c.cash(&alice).await?, c.cash(&bob).await?);
    c.ok(&oracle, &c.swap, "submit_rates", json!({"feed_id": 0, "entries": entries}), zero).await?;
    let (a1, b1) = (c.cash(&alice).await?, c.cash(&bob).await?);
    assert!(b1 - b0 + a1 - a0 <= 0 && b1 - b0 + a1 - a0 >= -2, "funding is zero-sum");
    c.assert_solvent(&oracle).await?;

    // Withdraw: tokens actually move back to alice.
    let before = c.token_balance(&alice).await?;
    c.ok(&alice, &c.swap, "withdraw", json!({"amount": (100 * USDC).to_string()}), one).await?;
    assert_eq!(c.token_balance(&alice).await? - before, 100 * USDC);
    c.assert_solvent(&oracle).await?;

    // Failed withdrawal: carol is credited but not registered on the token,
    // so ft_transfer fails and the callback must restore her cash exactly.
    c.ok(&gov, &c.token, "ft_transfer_call", json!({"receiver_id": swap_id, "amount": (50 * USDC).to_string(), "msg": json!({"credit_to": carol}).to_string()}), one).await?;
    let _ = c.call(&carol, &c.swap, "withdraw", json!({"amount": (50 * USDC).to_string()}), one).await?;
    assert_eq!(c.cash(&carol).await?, 50 * USDC as i128, "failed transfer restored");
    c.assert_solvent(&oracle).await?;

    // Unsupported token is rejected: a second token can't credit anything.
    let r = c.call(&alice, &c.swap, "ft_on_transfer", json!({"sender_id": alice, "amount": "1", "msg": ""}), zero).await?;
    assert!(r.into_result().is_err());
    Ok(())
}
