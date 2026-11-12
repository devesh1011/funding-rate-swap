import type { Metadata } from "next";
import { TradeRoute } from "@/components/trade/trade-route";

export const metadata: Metadata = {
  title: "Trade on testnet · Fundswap",
  description: "Trade Hyperliquid BTC funding on NEAR testnet with free test tUSDC.",
};

export default function TestnetTradePage() {
  return <TradeRoute net="testnet" />;
}
