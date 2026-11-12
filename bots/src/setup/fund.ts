// Fund a bot or test account with margin, entirely on-chain:
//   treasury registers the account on tUSDC → sends tUSDC →
//   account pays the swap's storage deposit → ft_transfer_call into the swap.
// Usage: pnpm fund <account-id> <usdc>
// The account's key must be in ~/.near-credentials/<network>/.

import { config } from "../lib/config.ts";
import { log } from "../lib/log.ts";
import { call, keychainAccount, loadAccount, view } from "../lib/near.ts";
import { USDC, formatUsdc, parseScaled } from "../lib/units.ts";

const [accountId, amountArg] = process.argv.slice(2);
if (!accountId || !amountArg) {
  console.error("usage: pnpm fund <account-id> <usdc>");
  process.exit(2);
}
const amount = parseScaled(amountArg, 6);
const YOCTO_PER_MILLINEAR = 10n ** 21n;

const treasury = loadAccount("TREASURY", "fundswap-treasury.testnet");
const target = keychainAccount(accountId);

const tokenStorage = await view<unknown>(config.collateral, "storage_balance_of", { account_id: accountId });
if (!tokenStorage) {
  const bounds = await view<{ min: string }>(config.collateral, "storage_balance_bounds");
  const r = await call(treasury, config.collateral, "storage_deposit", { account_id: accountId }, { depositYocto: BigInt(bounds.min) });
  log("fund", "registered on token", { tx: config.explorer(r.hash) });
}

const r1 = await call(treasury, config.collateral, "ft_transfer", { receiver_id: accountId, amount: amount.toString() }, { depositYocto: 1n });
log("fund", `treasury sent ${formatUsdc(amount)} tUSDC`, { tx: config.explorer(r1.hash) });

const swapStorage = await view<unknown>(config.swap, "storage_balance_of", { account_id: accountId });
if (!swapStorage) {
  const r = await call(target, config.swap, "storage_deposit", {}, { depositYocto: 100n * YOCTO_PER_MILLINEAR });
  log("fund", "paid swap storage deposit", { tx: config.explorer(r.hash) });
}

const r2 = await call(target, config.collateral, "ft_transfer_call", { receiver_id: config.swap, amount: amount.toString(), msg: "" }, { depositYocto: 1n, gasTera: 150 });
log("fund", `deposited ${formatUsdc(amount)} tUSDC as margin`, { tx: config.explorer(r2.hash) });

const acct = await view<{ cash: string } | null>(config.swap, "get_account", { account_id: accountId });
log("fund", "swap cash now", { account: accountId, cash: formatUsdc(BigInt(acct?.cash ?? "0")), whole_usdc: BigInt(acct?.cash ?? "0") / USDC });
