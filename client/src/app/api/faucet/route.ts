import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
import { isNearAccountId } from "@fundswap/intents/oneclick";
import { NETS } from "@/lib/config";

// Testnet only: mainnet collateral is real USDC.
const COLLATERAL_TOKEN = NETS.testnet.collateral;

// Testnet faucet: the token treasury registers the caller's wallet on tUSDC
// and sends it FAUCET_USDC. Real testnet transactions; the treasury key never
// leaves the server (TREASURY_PRIVATE_KEY, else the near-cli keychain file).

const TREASURY = process.env.TREASURY_ACCOUNT ?? "fundswap-treasury.testnet";
const FAUCET_USDC = 10_000n;
const USDC = 1_000_000n;
/** Wallets already holding this much can't claim again. */
const REFILL_BELOW = 1_000n * USDC;

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
    await provider.viewAccount({ accountId }).catch(() => {
      throw Object.assign(new Error("Account does not exist on testnet"), { status: 400 });
    });
    const balance = BigInt((await view<string>("ft_balance_of", { account_id: accountId })) ?? "0");
    if (balance >= REFILL_BELOW) return fail(429, `This wallet already holds ${balance / USDC} tUSDC`);

    const t = treasury();
    const txs: string[] = [];
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
    return Response.json({ amount: FAUCET_USDC.toString(), txs });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return fail(status, e instanceof Error ? e.message : "Faucet failed");
  } finally {
    inFlight.delete(accountId);
  }
}
