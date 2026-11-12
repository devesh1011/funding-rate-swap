import Link from "next/link";
import { Logo } from "@/components/logo";
import { explorer, SWAP_CONTRACT } from "@/lib/chain";

export function Closing() {
  return (
    <section className="relative overflow-hidden pt-36">
      <div className="rays !h-[85%]" />
      <div className="relative text-center">
        <h2 className="font-serif text-[clamp(4.5rem,11vw,12rem)] leading-none">
          Funding, <em className="text-lime">fixed.</em>
        </h2>
        <Link href="/trade" className="pill pill-lime mt-10 px-16 py-5 text-xl">
          Launch app
        </Link>
      </div>
      <footer className="relative mx-auto mt-32 flex max-w-[1500px] flex-wrap items-center justify-between gap-6 border-t border-white/15 px-6 py-8 lg:px-10">
        <Logo />
        <nav className="label flex flex-wrap items-center gap-6 text-[0.8rem]">
          <Link href="/docs" className="hover:text-lime">Docs</Link>
          <span className="text-lime">•</span>
          <a href={explorer.account(SWAP_CONTRACT)} target="_blank" rel="noreferrer" className="hover:text-lime">
            Contract ↗
          </a>
          <span className="text-lime">•</span>
          <a href="#oracle" className="hover:text-lime">Oracle</a>
        </nav>
        <div className="label flex items-center gap-4 border-white/15 text-[0.8rem] md:border-l md:pl-8">
          <span className="text-lime">Testnet</span>
          <span className="text-lime">•</span>
          <span>Built on NEAR</span>
        </div>
      </footer>
    </section>
  );
}
