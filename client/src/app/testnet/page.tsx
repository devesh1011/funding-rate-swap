import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";

export const metadata: Metadata = {
  title: "Fundswap testnet: lock the funding rate",
  description: "The Fundswap testnet deployment: trade Hyperliquid BTC funding with free test tUSDC.",
};

export default function TestnetHome() {
  return <Landing net="testnet" />;
}
