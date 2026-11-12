# Intents

How money gets into and out of the swap from any chain, through the [NEAR Intents 1Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api). NEAR Intents has no testnet, so everything here runs against mainnet.

| File | What it is |
| --- | --- |
| `src/oneclick.ts` | `fetch`-only 1Click client (tokens, quote, deposit/submit, status polling) and the two quote builders the app uses. It has no Node APIs, so the Next.js client imports it directly. |
| `scripts/quotes.ts` | `pnpm quotes`: live dry quotes for every route. Nothing executes. |
| `scripts/roundtrip.ts` | `pnpm roundtrip`: the mainnet round trip (≤ 5 USDC). It refuses to execute without `--i-confirm-mainnet`. |

## Routes

**In (one step).** The trader asks 1Click for NEAR USDC with `recipient` = the swap contract and `customRecipientMsg` = `{"credit_to":"<trader>.near"}`. 1Click delivers with `ft_transfer_call`, so the contract's `ft_on_transfer` credits the trader's margin in the same receipt. The message is built only from a validated NEAR account id, never from free text.

- Because the sender is a solver, a `credit_to` deposit is **never refunded**: a refund would go to the solver, not the trader.
- If the deposit would push the account past `deposit_cap` (10 USDC on mainnet), the contract credits up to the cap and forwards the rest to the trader's own balance in `intents.near`.
- If too little gas is left to forward, it credits everything instead of panicking, because a panic would also refund the solver.

**Out (two transactions, one wallet prompt).** The trader calls `withdraw`, then sends the NEAR USDC with `ft_transfer` to the deposit address of a 1Click quote to Hyperliquid perp, Base or Arbitrum. Refunds go to the trader's NEAR account. The contract also has `withdraw_to_intents`, which moves funds into the trader's `intents.near` balance. Spending that balance through 1Click (`depositType: INTENTS`) needs a partner API key and a signed NEP-413 intent, so the app uses the direct route.

## Live findings (2026-11-12)

`pnpm quotes` with 5 USDC, unauthenticated:

| Route | Out | Cost | Time |
| --- | --- | --- | --- |
| USDC Base → margin | 4.9995 | 0.0005 | ~35 s |
| USDC Arbitrum → margin | 4.9994 | 0.0006 | ~25 s |
| USDC Ethereum → margin | 4.9994 | 0.0006 | ~45 s |
| USDC NEAR → margin | 5.0000 | 0 | ~20 s |
| NEAR USDC → USDC Base | 4.9966 | 0.0034 | ~22 s |
| NEAR USDC → USDC Arbitrum | 4.9941 | 0.0059 | ~19 s |
| NEAR USDC → Hyperliquid perp | 4.6837 | 0.3163 | ~30 s |

- Stablecoin routes quoted about 0.01 % without an API key, not the extra 0.25 % the docs describe. The client shows each live quote's own numbers.
- 1Click answers an opaque **HTTP 500** when a NEAR account in the request does not exist. The client validates the account id first, and the signed-in wallet account always exists.
- 1Click rejects burn addresses (`0x…dEaD`) as `refundTo`.

## Run

```bash
pnpm quotes                                        # dry, safe
pnpm test                                          # quote builders
# mainnet, after sign-off: see .env.example
pnpm roundtrip --amount 2 --out hyperliquid:0x…    # checks + dry quotes only
pnpm roundtrip --amount 2 --out hyperliquid:0x… --i-confirm-mainnet
```
