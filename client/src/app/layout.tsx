import type { Metadata } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import "./globals.css";

// Hyperliquid's system: a grotesk for text, one italic serif accent. Inter is
// their body face; Instrument Serif italic stands in for their Teodor (licensed).
const sans = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const accent = Instrument_Serif({
  variable: "--font-accent",
  weight: "400",
  style: "italic",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fundswap — Lock the funding rate",
  description:
    "Trade Hyperliquid BTC funding as a fixed-for-floating swap on NEAR. Settled hourly, onchain, with margin from any chain via NEAR Intents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${accent.variable} antialiased`}>
      <body className="min-h-dvh bg-ink font-sans text-paper">{children}</body>
    </html>
  );
}
