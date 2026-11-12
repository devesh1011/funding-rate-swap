import type { Metadata } from "next";
import { TradeRoute } from "@/components/trade/trade-route";

export const metadata: Metadata = {
  title: "Trade · Fundswap",
  description: "Trade Hyperliquid BTC funding as a fixed-for-floating swap on NEAR mainnet.",
};

export default function TradePage() {
  return <TradeRoute net="mainnet" />;
}
