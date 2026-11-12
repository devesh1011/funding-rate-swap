// Deployment constants shared by server and browser code. The site serves
// both deployments: mainnet at `/` and `/trade`, testnet under `/testnet`.

export type Net = "mainnet" | "testnet";

export interface NetConfig {
  id: Net;
  label: string;
  /** Route prefix: "" for mainnet, "/testnet" for testnet. */
  base: "" | "/testnet";
  swap: string;
  collateral: string;
  /** What the collateral is called in the UI. */
  symbol: string;
  /** Fallbacks from docs.near.org/api/rpc/providers, all CORS-enabled. */
  rpc: string[];
  archivalRpc: string[];
  nearblocksApi: string;
  explorerBase: string;
  oracle: string;
  keeper: string | null;
  /** Testnet only: /api/faucet mints test collateral. */
  faucet: boolean;
  /** Per-account deposit cap in whole USDC, if the contract has one. */
  depositCap: number | null;
}

export const NETS: Record<Net, NetConfig> = {
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    base: "",
    swap: "fundswap.near",
    collateral: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    symbol: "USDC",
    rpc: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
    archivalRpc: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
    nearblocksApi: "https://api.nearblocks.io/v3",
    explorerBase: "https://nearblocks.io",
    oracle: "oracle.fundswap.near",
    keeper: null,
    faucet: false,
    depositCap: 10,
  },
  testnet: {
    id: "testnet",
    label: "Testnet",
    base: "/testnet",
    swap: "fundswap-lab.testnet",
    collateral: "tusdc.token.primitives.testnet",
    symbol: "tUSDC",
    // rpc.testnet.near.org is deprecated and answers every call with an error.
    rpc: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
    archivalRpc: ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
    nearblocksApi: "https://api-testnet.nearblocks.io/v3",
    explorerBase: "https://testnet.nearblocks.io",
    oracle: "oracle.fundswap-treasury.testnet",
    keeper: "keeper.fundswap-treasury.testnet",
    faucet: true,
    depositCap: null,
  },
};

export const isNet = (x: unknown): x is Net => x === "mainnet" || x === "testnet";

export const explorer = (net: Net) => ({
  tx: (hash: string) => `${NETS[net].explorerBase}/txns/${hash}`,
  account: (id: string) => `${NETS[net].explorerBase}/address/${id}`,
});

/** The mainnet deployment that NEAR Intents (1Click) deposits are quoted into. */
export const MAINNET_SWAP_CONTRACT = NETS.mainnet.swap;
