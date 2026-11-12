# Deployments

Every row is a real transaction; open the hash on [testnet nearblocks](https://testnet.nearblocks.io/).

## Testnet

| Role | Account |
| --- | --- |
| Rate-swap contract | [`fundswap-lab.testnet`](https://testnet.nearblocks.io/address/fundswap-lab.testnet) |
| Governance (single key, disclosed) | `gov.fundswap-lab.testnet` |
| Collateral token tUSDC (6 decimals, FT factory) | [`tusdc.token.primitives.testnet`](https://testnet.nearblocks.io/address/tusdc.token.primitives.testnet) |
| Token owner / faucet treasury | `fundswap-treasury.testnet` |
| Oracle signers (2-of-3, ed25519) | `ed25519:HpsUez8kwRKLbBqB6bGZ4CxW6b8tX8tv7p5PPYnxkb6Z`, `ed25519:AjZKtFizLeJnqSuUfriDgPpKfngA2vk6mEzFVPUp57KX`, `ed25519:FU6dgfjeCFtgdByetZ3Sbkin8HTL2WTYUQ7vip4e8x17` |

### Feeds and markets

| Id | What | Details |
| --- | --- | --- |
| feed 0 | `hyperliquid:BTC` | hourly, starts 2026-11-12 09:00 UTC (`1794474000`), clamp 4 %/h (Hyperliquid's cap), CloseOnly after 3 h without a rate |
| market 0 | BTC funding · 15 Nov 2026 | matures `1794700800` (2026-11-15 00:00 UTC) |
| market 1 | BTC funding · 22 Nov 2026 | matures `1795305600` (2026-11-22 00:00 UTC) |

Both markets: IM factor 3×, maintenance 0.66 × IM, rate floor 5 %, time floor 1 day, band ±50 % APR around mark, taker fee 0.1 % APR, mark EMA window 15 min, OI cap 1,000,000 tUSDC, opening mark 10.95 % (Hyperliquid's quiet-market baseline, 0.00125 %/h × 8760).

### Setup transactions (2026-11-12)

| Step | Tx |
| --- | --- |
| Create `gov.fundswap-lab.testnet` | `ADW9RqusHTMAevsKeq5KiL7hapEs2oPosmh3aDEtkjJw` |
| Create tUSDC through `token.primitives.testnet` | `AABGUGhdZUvwxk3HvVsv2EsC2QdhXDciJNcgXQcvkute` |
| Deploy + `new` rate-swap | `8B8Lxygce7jyRSoEDumjJjkvbW8DF7Tg9FkdZNYBD9vz` |
| Register contract on tUSDC | `7Z9t9q6GefBEeq59VCUDhFKfErAE15TxGxMaqsVgHn2` |
| `create_feed` hyperliquid:BTC | `7CUzjwo8XJ4Ep9sP29dvkCJg26v7BMahXpwiAADtqbk9` |
| `create_market` 15 Nov | `8Ntq8rpsHQJArT2yWPZZz16yW27s4ekgpVMv5Vak5Z97` |
| `create_market` 22 Nov | `GVqWCKzJtYHcH2v178bHEjatA5fY2CHjoyHsGqHmqeyN` |

### CLI smoke test (`smoke.fundswap-treasury.testnet`)

| Step | Tx | Result |
| --- | --- | --- |
| tUSDC `storage_deposit` | `6dHcU4BKyBsL7UJA1qjGLAorQs4mh6aNWt1UfMzFq3Eu` | registered on token |
| Treasury sends 1,000 tUSDC | `Fvne5ztRwcoThpjqm5u7zeiJCXVzH7ExFdpNPHrz8yGb` | |
| Swap `storage_deposit` 0.1 NEAR | `55bQNXxunEAyoBMSSqRsZhGo2oztB8fMvMutzvfitZFu` | can trade |
| `ft_transfer_call` 1,000 tUSDC, `msg: ""` | `8htFR74HpW3j36epCWYQq5m2PWz1ymk13YfGYajxWAen` | cash = 1,000 tUSDC |
| `place_order` short 1,000 YU @ 11.00 %, market 1 | `DtZT12SP2n1n9oFpuWeQ79SoDoPMCjxyU77dKMsMAqN6` | order 0 resting, IM ≈ $8.70 |
| `cancel_order` 0 | `5PZ5JSKz6M9H8avFWyN4uRj6NAjDJ8LhHbVcfxjEqet3` | book empty |

After the smoke test: `total_cash` = 1,000,000,000 = tUSDC held by the contract.

### Contract upgrade (2026-11-12 10:00 UTC)

The staged liquidation below exposed a bug: the penalty was capped at the victim's *cash*, not their *net balance*, so a large mark gap let the penalty itself create bad debt. Fixed (penalty ≤ max(net, 0)), regression test added (`penalty_is_capped_at_net_after_a_mark_gap`), plus a permissionless `cover_bad_debt`. Redeployed in place; state layout unchanged.

| Step | Tx |
| --- | --- |
| Redeploy `fundswap-lab.testnet` | `FLDKpkbK5A8EVrK8HjGZ7iyxYSqYwq73c5HwgBgD8qUJ` |
| Treasury donates 400 tUSDC to insurance (`msg: {"insurance":true}`) | `3PuzHqJxdmCBCFp8dZWcjCD7NDnELn3JmH8f5UjxSR7m` |
| `cover_bad_debt(demo-victim)`: 341.96 tUSDC covered, victim net = 0 | `7UzuzdRzGcLPN2UuA5wgYYP16w6NNrACm1zzciUgXcoE` |

### Contract upgrade (2026-11-12 14:20 UTC)

`credit_to` deposits (the 1Click path) now honour `deposit_cap`: the contract credits up to the cap and forwards the excess to the trader's own `intents.near` balance, never refunding the solver. This changes nothing on testnet, where there is no cap; the redeploy keeps the testnet wasm identical to what goes to mainnet.

| Step | Tx |
| --- | --- |
| Redeploy `fundswap-lab.testnet` | `A42ypc4pgsCv6gDC8goAWgmp9QNxSWwctLBTFXZkQoj7` |

### Contract upgrade: trade log (2026-11-12 16:40 UTC)

Trades are now kept on the contract under their own storage prefixes, so the contract struct and its state layout are unchanged: the last 60 per market, the last 40 per account, and hourly OHLC candles with volume. New views: `get_trades`, `get_account_trades`, `get_candles`, and `volume_24h` in `MarketView`. Liquidations are logged too. History starts at this upgrade; earlier fills (the staged demo) are only in the `trade` events.

| Step | Tx |
| --- | --- |
| Redeploy with trade log | `FF6uGfWQK8WeJSjFEou1qPor6tYDUaL1Sxb8ECFJvJfq` |
| Redeploy: `get_candles` keeps the newest hours on long ranges | `4k9m9YirKVTC2Zpw9rTCRE8kUdj2ehexgUDrEJnkCrAo` |
| First logged trade: `smoke` buys 1,000 YU @ 10.07 % from the maker, 22 Nov market | `8cspJ2qNMPeyhABvph16ezb9b3zz4eYPnc8ZkK8ddBvh` |
| Faucet test: treasury sends 10,000 tUSDC to `smoke` (`/api/faucet`) | `3zfJfm2UTbj1nWv7PzyXGZX2deKGGRi4EBj3i3F5193R` |

## Bots (phase 2)

| Bot | Account | Funded with |
| --- | --- | --- |
| oracle | `oracle.fundswap-treasury.testnet` | 1 NEAR (gas only) |
| maker | `maker.fundswap-treasury.testnet` | 500,000 tUSDC margin (`Bq8tWKSSPsRTrumWvq1yZrgQPVdzxG5rMUyabw5o47Gu`) |
| keeper | `keeper.fundswap-treasury.testnet` | 200,000 tUSDC margin (`J4rbgMjcXExSZ7kAi12icHEeU5WxKSymw6mipuWhQaQG`) |

| Event | Tx |
| --- | --- |
| First real funding interval: Hyperliquid BTC 10:00 UTC, `0.0000057471` (5.03 % APR), 3/3 signers | `Gs8vLpT1fcFC5qZ2v5gaDopfoxvHv85VQYMf13MpKsX1` |
| 11:00 UTC interval (5.43 % APR) | `FrtfaBznMmqAcbSFfWEsNKF4iwjrgxSsMRvMgzo9SayG` |
| 12:00 UTC interval (4.90 % APR) | `AwD3MGKpVG7xYG12aSZD5Gp6YVwYCaKdwQ4Pc56YzssU` |
| 13:00 UTC interval (10.95 % APR) | `G3p6Gftz3dsR9vM7KoowJxgjn2d5cL8Ebjucjdsj7qGN` |
| 14:00 UTC interval (−4.70 % APR, first negative) | `2WjTrGFfWZN4XB3nVwVvFFq7nTetLTyX7U7aNuefEpec` |
| Maker first quotes, market 1 (bid 5.86 % / ask 6.86 %) | `FyPAZP4katxsGUqCtmZJM8GurBKtPZsGsZge2xKjvbR5`, `CZKcKCZLcaQjLBjhTvx6rpBpsN3HN7m68wPfj9kqYuZ7` |

### Staged liquidation (market 0, every step a real tx between separate accounts)

| Step | Tx |
| --- | --- |
| `demo-whale` rests ask 1,000,000 YU @ 7.00 % | `5X36L5GLasbhY3f9NwVqVetnq34noPf5VwJqfBq8ioph` |
| `demo-victim` (1,520 tUSDC margin) buys it → mark 7.00 %, net $1,512.81 vs IM $1,510.27 | `79wu2vrm18T2QN2VFkKgZZsFyEQy4g4TrbD5yNb9ZYw` |
| 15 min later `demo-whale` rests bid 1,000 YU @ −10.00 % | `GjdN5EJJj7ivTYc4dC5LpJDV9FHGY3fNND7AUXnVFj2w` |
| `demo-bear` sells into it → mark −10.00 %, victim net $290.21 < maintenance $1,423.97 | `6stLwGAhiZAVz6zATue6TbSLWAmUpmhEMYMLcLPgXMvC` |
| **keeper bot liquidates the victim 13 s later** (takes 1M YU over at mark) | `CKaH6c19QGDDvJRLd3z9HHErFzNGCjF7Ez2bNxGXWZNS` |

## Mainnet

Not deployed. Phase 3 (NEAR Intents) needs an explicit sign-off first.
