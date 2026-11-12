import type { Metadata } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const sans = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fundswap — Lock the funding rate",
  description:
    "Trade Hyperliquid BTC funding as a fixed-for-floating swap on NEAR. Settled hourly, onchain, with margin from any chain via NEAR Intents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} ${sans.variable} antialiased`}>
      <body className="min-h-dvh bg-ink font-sans text-paper">{children}</body>
    </html>
  );
}
