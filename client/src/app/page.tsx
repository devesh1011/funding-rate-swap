import { AnyChain } from "@/components/landing/any-chain";
import { Closing } from "@/components/landing/closing";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Markets } from "@/components/landing/markets";
import { RateSection } from "@/components/landing/rate-section";
import { Trust } from "@/components/landing/trust";

export default function Home() {
  return (
    <main>
      <Hero />
      <RateSection />
      <HowItWorks />
      <Markets />
      <AnyChain />
      <Trust />
      <Closing />
    </main>
  );
}
