// Deployment constants shared by server and browser code.

export const NETWORK = "testnet" as const;
export const SWAP_CONTRACT = process.env.NEXT_PUBLIC_SWAP_CONTRACT ?? "fundswap-lab.testnet";
export const COLLATERAL_TOKEN = process.env.NEXT_PUBLIC_COLLATERAL_TOKEN ?? "tusdc.token.primitives.testnet";
export const PUBLIC_RPC = process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
export const ORACLE_ACCOUNT = "oracle.fundswap-treasury.testnet";
export const KEEPER_ACCOUNT = "keeper.fundswap-treasury.testnet";

export const explorer = {
  tx: (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`,
  account: (id: string) => `https://testnet.nearblocks.io/address/${id}`,
};
