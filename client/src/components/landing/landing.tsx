import type { Net } from "@/lib/config";
import { AnyChain } from "./any-chain";
import { Closing } from "./closing";
import { Hero } from "./hero";
import { HowItWorks } from "./how-it-works";
import { Markets } from "./markets";
import { RateSection } from "./rate-section";
import { Trust } from "./trust";

/** The whole landing page for one deployment (mainnet at `/`, testnet at `/testnet`). */
export function Landing({ net }: { net: Net }) {
  return (
    <main>
      <Hero net={net} />
      <RateSection net={net} />
      <HowItWorks net={net} />
      <Markets net={net} />
      <AnyChain />
      <Trust net={net} />
      <Closing net={net} />
    </main>
  );
}
