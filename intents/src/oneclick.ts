// NEAR Intents 1Click client. Plain `fetch`, no Node APIs, so the Next.js
// client (phase 4) imports this file as-is.
//
// Every asset id comes from GET /v0/tokens; nothing here builds one by hand.

export const ONECLICK_URL = "https://1click.chaindefuser.com";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number | string;
  contractAddress?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type Endpoint = "ORIGIN_CHAIN" | "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  slippageTolerance: number;
  originAsset: string;
  depositType: Endpoint;
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: Endpoint;
  recipient: string;
  recipientType: Endpoint;
  deadline: string;
  customRecipientMsg?: string;
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut?: string;
  deadline?: string;
  timeEstimate: number;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export const TERMINAL = ["SUCCESS", "FAILED", "REFUNDED", "INCOMPLETE_DEPOSIT"] as const;
export type Status =
  | (typeof TERMINAL)[number]
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING";

export interface StatusResponse {
  correlationId: string;
  status: Status;
  updatedAt: string;
  swapDetails?: {
    amountInFormatted?: string;
    amountOutFormatted?: string;
    originChainTxHashes?: { hash: string; explorerUrl: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl: string }[];
    refundedAmount?: string;
    refundReason?: string;
  };
}

export class OneClickError extends Error {
  readonly httpStatus: number;
  readonly correlationId?: string;
  constructor(httpStatus: number, message: string, correlationId?: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.correlationId = correlationId;
  }
}

export interface ClientOptions {
  baseUrl?: string;
  /** Partner JWT. Optional: without it the live quote shows whatever fee applies. */
  jwt?: string;
}

export function oneClick(opts: ClientOptions = {}) {
  const base = opts.baseUrl ?? ONECLICK_URL;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`;

  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + path, { ...init, headers });
    const body = (await res.json().catch(() => ({}))) as { message?: string; correlationId?: string };
    if (!res.ok) throw new OneClickError(res.status, body.message ?? res.statusText, body.correlationId);
    return body as T;
  }

  return {
    tokens: () => req<Token[]>("/v0/tokens"),
    quote: (q: QuoteRequest) => req<QuoteResponse>("/v0/quote", { method: "POST", body: JSON.stringify(q) }),
    submitDeposit: (d: { txHash: string; depositAddress: string; nearSenderAccount?: string }) =>
      req<StatusResponse>("/v0/deposit/submit", { method: "POST", body: JSON.stringify(d) }),
    status: (depositAddress: string) =>
      req<StatusResponse>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`),

    /** Polls until a terminal status; `onChange` sees every new status. */
    async waitFor(
      depositAddress: string,
      { intervalMs = 3_000, timeoutMs = 15 * 60_000, onChange }: { intervalMs?: number; timeoutMs?: number; onChange?: (s: StatusResponse) => void } = {},
    ): Promise<StatusResponse> {
      const end = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < end) {
        const s = await this.status(depositAddress);
        if (s.status !== last) {
          last = s.status;
          onChange?.(s);
        }
        if ((TERMINAL as readonly string[]).includes(s.status)) return s;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`no terminal status for ${depositAddress} after ${timeoutMs / 1000}s`);
    },
  };
}

export type OneClick = ReturnType<typeof oneClick>;

// ---------------------------------------------------------------- assets

export function findToken(tokens: Token[], symbol: string, blockchain: string): Token {
  const t = tokens.find((x) => x.symbol.toLowerCase() === symbol.toLowerCase() && x.blockchain === blockchain);
  if (!t) throw new Error(`1Click lists no ${symbol} on ${blockchain}`);
  return t;
}

/** NEAR's native USDC: the contract's collateral on mainnet. */
export const nearUsdc = (tokens: Token[]) => findToken(tokens, "USDC", "near");

/**
 * USDC credited to a Hyperliquid **perp** balance. Two USDC entries are listed
 * on `hypercore`; the perp one is the 8-decimal `hip1` asset.
 */
export function hyperliquidUsdc(tokens: Token[]): Token {
  const t = tokens.find((x) => x.blockchain === "hypercore" && x.symbol === "USDC" && x.assetId.includes(":hip1:"));
  if (!t) throw new Error("1Click lists no Hyperliquid perp USDC");
  return t;
}

/** The token contract an `nep141:` asset id points at. */
export function nep141Contract(assetId: string): string {
  if (!assetId.startsWith("nep141:")) throw new Error(`${assetId} is not a NEP-141 asset`);
  return assetId.slice("nep141:".length);
}

// ---------------------------------------------------------------- quotes

const deadlineIn = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

export interface DepositToSwap {
  dry: boolean;
  /** Source token (any chain 1Click lists). */
  origin: Token;
  /** NEAR USDC, the contract's collateral. */
  collateral: Token;
  amount: bigint;
  /** Where 1Click refunds on failure; must be valid on the origin chain. */
  refundTo: string;
  swapContract: string;
  /** The NEAR account credited inside the contract. Never free text. */
  trader: string;
  slippageBps?: number;
}

/**
 * One-step deposit (plan 3.4): 1Click delivers NEAR USDC to the swap contract
 * with `ft_transfer_call`, and `msg` credits `trader`'s margin.
 */
export function depositToSwapQuote(d: DepositToSwap): QuoteRequest {
  if (!isNearAccountId(d.trader)) throw new Error(`not a NEAR account id: ${d.trader}`);
  return {
    dry: d.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: d.slippageBps ?? 100,
    originAsset: d.origin.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: d.collateral.assetId,
    amount: d.amount.toString(),
    refundTo: d.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: d.swapContract,
    recipientType: "DESTINATION_CHAIN",
    customRecipientMsg: creditToMsg(d.trader),
    deadline: deadlineIn(10),
    referral: "fundswap",
  };
}

export interface WithdrawFromNear {
  dry: boolean;
  /** NEAR USDC that just left the contract via `withdraw`. */
  collateral: Token;
  destination: Token;
  amount: bigint;
  /** Address on the destination chain (`0x…` for Hyperliquid / EVM). */
  recipient: string;
  /** The trader's NEAR account: refunds come back here. */
  trader: string;
  slippageBps?: number;
}

/**
 * Withdrawal leg: after `withdraw`, the trader sends NEAR USDC to the quote's
 * deposit address with `ft_transfer`. Works without a partner key; the
 * `depositType: INTENTS` route needs one for signed-intent execution.
 */
export function withdrawFromNearQuote(w: WithdrawFromNear): QuoteRequest {
  return {
    dry: w.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: w.slippageBps ?? 100,
    originAsset: w.collateral.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: w.destination.assetId,
    amount: w.amount.toString(),
    refundTo: w.trader,
    refundType: "ORIGIN_CHAIN",
    recipient: w.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadlineIn(10),
    referral: "fundswap",
  };
}

/** The `ft_on_transfer` message that credits `trader` in the swap contract. */
export function creditToMsg(trader: string): string {
  return JSON.stringify({ credit_to: trader });
}

/** A refund or payout address valid on `blockchain` (as 1Click names chains). */
export function isAddressFor(blockchain: string, address: string): boolean {
  if (["eth", "base", "arb", "pol", "bsc", "op", "avax", "gnosis", "hypercore"].includes(blockchain)) return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (blockchain === "sol") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (blockchain === "near") return isNearAccountId(address);
  return false;
}

/** NEAR account id rules (2–64 chars, lowercase parts split by `.`, `-`, `_`). */
export function isNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}
