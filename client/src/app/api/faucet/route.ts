import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
import { isNearAccountId } from "@fundswap/intents/oneclick";
import { NETS } from "@/lib/config";

// Testnet only: mainnet collateral is real USDC.
const COLLATERAL_TOKEN = NETS.testnet.collateral;

// Testnet faucet: the token treasury registers the caller's wallet on tUSDC
// and sends it FAUCET_USDC, plus FAUCET_NEAR for gas and the swap's account
// storage when the wallet holds almost no NEAR (new Meteor accounts hold 0).
// Real testnet transactions; the treasury key never leaves the server
// (TREASURY_PRIVATE_KEY, else the near-cli keychain file).

const TREASURY = process.env.TREASURY_ACCOUNT ?? "fundswap-treasury.testnet";
const FAUCET_USDC = 10_000n;
const USDC = 1_000_000n;
/** Wallets already holding this much can't claim again. */
const REFILL_BELOW = 1_000n * USDC;
const NEAR = 1_000_000_000_000_000_000_000_000n;
const FAUCET_NEAR = (3n * NEAR) / 10n;
/** Enough for activation (0.1 NEAR storage) plus gas; below this the faucet tops up. */
const NEAR_REFILL_BELOW = (2n * NEAR) / 10n;
/** NEAR the treasury keeps for its own gas; it stops sending NEAR below this. */
const TREASURY_RESERVE = (5n * NEAR) / 10n;

/** NEAR an account can spend: balance minus what its storage locks (1e19 yoctoNEAR per byte). */
async function spendable(accountId: string): Promise<bigint> {
  const a = await provider.viewAccount({ accountId });
  const free = BigInt(a.amount) - BigInt(a.storage_usage) * 10_000_000_000_000_000_000n;
  return free > 0n ? free : 0n;
}

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });
const inFlight = new Set<string>();

function treasury(): Account {
  const key =
    process.env.TREASURY_PRIVATE_KEY ??
    (JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${TREASURY}.json`), "utf8")).private_key as string);
  return new Account(TREASURY, provider, key as KeyPairString);
}

const view = <T,>(method: string, args: Record<string, unknown>) =>
  provider.callFunction({ contractId: COLLATERAL_TOKEN, method, args }) as Promise<T>;

const fail = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(req: Request) {
  const { accountId } = (await req.json().catch(() => ({}))) as { accountId?: string };
  if (!accountId || !isNearAccountId(accountId) || !(accountId.endsWith(".testnet") || /^[0-9a-f]{64}$/.test(accountId)))
    return fail(400, "Send a testnet account id");
  if (inFlight.has(accountId)) return fail(429, "Already sending to this account");

  inFlight.add(accountId);
  try {
    const near = await spendable(accountId).catch(() => {
      throw Object.assign(new Error("Account does not exist on testnet"), { status: 400 });
    });
    const balance = BigInt((await view<string>("ft_balance_of", { account_id: accountId })) ?? "0");
    const sendUsdc = balance < REFILL_BELOW;
    const sendNear = near < NEAR_REFILL_BELOW && (await spendable(TREASURY)) > FAUCET_NEAR + TREASURY_RESERVE;
    if (!sendUsdc && !sendNear)
      return fail(429, near < NEAR_REFILL_BELOW ? "The faucet is out of test NEAR. Get some from the NEAR testnet faucet." : `This wallet already holds ${balance / USDC} tUSDC and enough NEAR`);

    const t = treasury();
    const txs: string[] = [];
    if (sendNear) {
      const r = await t.signAndSendTransaction({ receiverId: accountId, actions: [actions.transfer(FAUCET_NEAR)] });
      txs.push(r.transaction.hash);
    }
    if (!sendUsdc) return Response.json({ tusdc: null, near: "0.3", txs });
    if (!(await view<unknown>("storage_balance_of", { account_id: accountId }))) {
      const { min } = await view<{ min: string }>("storage_balance_bounds", {});
      const r = await t.signAndSendTransaction({
        receiverId: COLLATERAL_TOKEN,
        actions: [actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, teraToGas(30), BigInt(min))],
      });
      txs.push(r.transaction.hash);
    }
    const r = await t.signAndSendTransaction({
      receiverId: COLLATERAL_TOKEN,
      actions: [actions.functionCall("ft_transfer", { receiver_id: accountId, amount: (FAUCET_USDC * USDC).toString() }, teraToGas(30), 1n)],
    });
    txs.push(r.transaction.hash);
    return Response.json({ tusdc: FAUCET_USDC.toString(), near: sendNear ? "0.3" : null, txs });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return fail(status, e instanceof Error ? e.message : "Faucet failed");
  } finally {
    inFlight.delete(accountId);
  }
}
