export type Network = "testnet" | "mainnet";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};

export const config = {
  network: env("NEAR_NETWORK", "testnet") as Network,
  get rpcUrl() {
    return env("NEAR_RPC_URL", this.network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");
  },
  swap: env("SWAP_CONTRACT", "fundswap-lab.testnet"),
  collateral: env("COLLATERAL_TOKEN", "tusdc.token.primitives.testnet"),
  account: (role: "ORACLE" | "MAKER" | "KEEPER" | "TREASURY", fallback: string) => env(`${role}_ACCOUNT`, fallback),
  hyperliquidUrl: env("HYPERLIQUID_INFO_URL", "https://api.hyperliquid.xyz/info"),
  explorer(txHash: string) {
    return `https://${this.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${txHash}`;
  },
  num: (k: string, d: number) => Number(process.env[k] ?? d),
  optional: (k: string) => process.env[k] || undefined,
};
