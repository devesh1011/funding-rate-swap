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

## Mainnet

Not deployed. Phase 3 (NEAR Intents) needs an explicit sign-off first.
