# Bots

Three long-running processes keep the testnet market alive. Each one signs real transactions from its own account. They are written in TypeScript, run directly by Node ≥ 24 (no build step), and use `near-api-js` 7.4.

| Bot | What it does | Account |
| --- | --- | --- |
| `oracle` | For each `hyperliquid:<COIN>` feed: every signer independently reads Hyperliquid's settled `fundingHistory`, signs `(contract, feed, interval, rate)` with its ed25519 key, and the submitter sends `submit_rates` once ≥ k signers agree. It backfills missed intervals in order, up to 24 per transaction, and never guesses: no data or no agreement means no submission, and the markets go close-only. | `oracle.fundswap-treasury.testnet` |
| `maker` | Two-sided quotes on every active market, around the 24-hour mean of Hyperliquid funding (annualised) ± `MAKER_SPREAD_BPS`. It stops quoting the side that would grow inventory past the cap, and re-quotes when fair moves or a quote is mostly filled. | `maker.fundswap-treasury.testnet` |
| `keeper` | Walks all accounts via `list_accounts` / `get_account`. It liquidates any account below maintenance margin, taking the position over at mark and earning the penalty, and settles positions in matured markets. | `keeper.fundswap-treasury.testnet` |

## Run

```bash
pnpm install
cp .env.example .env          # add ORACLE_SIGNER_0..2; bot keys come from ~/.near-credentials or *_PRIVATE_KEY
pnpm test                     # units + rate-message test vector shared with the contract
pnpm check-encoding           # local encoding == deployed contract's get_rate_message
pnpm oracle                   # add --once for a single pass
pnpm maker
pnpm keeper
pnpm fund <account> <usdc>    # treasury → tUSDC → storage → ft_transfer_call into the swap
```

## Units

`fundingRate` from Hyperliquid is the fraction paid for **one hourly payment** (`0.0001` = 0.01 % for that hour). It is parsed exactly into the contract's 1e12 scale (`0.0001` → `100_000_000`), with no ÷8 and no floats. Hyperliquid stamps payments a few ms after the hour, so the interval key is the timestamp floored to the hour. The contract rejects any |rate| above 4 %/h, which is Hyperliquid's cap.

## Trust model

In this hackathon build the team runs all three signers, and they read the same public API. The contract enforces quorum, ordering, the clamp and no rewrites, but it cannot tell whether the signers are honest. Anyone can recompute every submitted rate from Hyperliquid's public history, because each `rate` event carries the interval timestamp.

## Staged liquidation demo

`pnpm demo:liquidation [market]` (with the maker running as `MAKER_SKIP_MARKETS=<market>`) opens a 1M-YU long at 7 % for an account with barely more than initial margin. After the 15-minute mark window it prints a trade at −10 % between two other accounts. The victim falls below maintenance, and the running keeper liquidates it. Every step is a real testnet transaction between separate accounts. It is staged because ordinary hourly funding can't push a properly margined account under in a demo-length window.
