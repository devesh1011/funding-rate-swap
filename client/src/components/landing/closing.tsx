import Link from "next/link";
import { LogoMark, Wordmark } from "@/components/logo";
import { explorer, NETS, type Net } from "@/lib/chain";

function columns(net: Net): { title: string; links: { label: string; href: string; external?: boolean }[] }[] {
  const c = NETS[net];
  const ex = explorer(net);
  return [
    {
      title: "Learn",
      links: [
        { label: "How it works", href: `${c.base}/#how-it-works` },
        { label: "Markets", href: `${c.base}/#markets` },
        { label: "Oracle", href: `${c.base}/#oracle` },
        { label: "Docs", href: "/docs" },
      ],
    },
    {
      title: "App",
      links: [
        { label: `Trade on ${c.label.toLowerCase()}`, href: `${c.base}/trade` },
        ...(c.faucet ? [{ label: "Get test tUSDC", href: `${c.base}/trade` }] : [{ label: "Try it on testnet", href: "/testnet/trade" }]),
      ],
    },
    {
      title: "Onchain",
      links: [
        { label: "Contract", href: ex.account(c.swap), external: true },
        { label: "Oracle signer", href: ex.account(c.oracle), external: true },
        ...(c.keeper ? [{ label: "Keeper", href: ex.account(c.keeper), external: true }] : []),
      ],
    },
  ];
}

export function Closing({ net }: { net: Net }) {
  return (
    <section className="relative overflow-hidden">
      {/* Rays only behind the call to action: under the blended wordmark they would show through as stripes. */}
      <div className="relative pt-36 pb-12 text-center">
        <div className="rays rays-fade !h-[95%]" />
        <h2 className="relative text-[clamp(3.5rem,8.5vw,9.5rem)] leading-none font-normal tracking-[-0.045em]">
          Funding, <span className="accent text-lime">fixed.</span>
        </h2>
        <Link href={`${NETS[net].base}/trade`} className="pill pill-lime relative mt-10 px-16 py-5 text-xl">
          Launch app
        </Link>
      </div>

      {/* Hyperliquid-style sign-off: a full-width wordmark standing on the
          footer band. Its baseline sits on the band's edge and the descender
          runs into the band; `difference` keeps it lime over the page and
          turns it dark over the lime band, so every letter stays whole. */}
      <div
        className="pointer-events-none relative z-10 mt-28 -mb-[var(--descent)] px-4 text-[clamp(4.5rem,23.5vw,26rem)] leading-[0.8] text-lime mix-blend-difference [--descent:0.068em] lg:px-8"
        aria-hidden
      >
        <Wordmark className="block whitespace-nowrap" />
      </div>
      <footer className="relative bg-lime text-ink">
        <div className="mx-auto grid max-w-[1500px] gap-14 px-6 pt-[max(5rem,calc(4.6vw+3rem))] pb-16 md:grid-cols-[1fr_auto] lg:px-10">
          <LogoMark className="size-20 text-ink" />
          <nav className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 sm:gap-x-20" aria-label="Footer">
            {columns(net).map((c) => (
              <div key={c.title}>
                <div className="text-[0.95rem] font-medium tracking-[0.02em] text-ink/55 uppercase">{c.title}</div>
                <ul className="mt-7 space-y-2">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      {l.external ? (
                        <a href={l.href} target="_blank" rel="noreferrer" className="text-[1.05rem] font-medium uppercase hover:underline">
                          {l.label} ↗
                        </a>
                      ) : (
                        <Link href={l.href} className="text-[1.05rem] font-medium uppercase hover:underline">
                          {l.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="mx-auto flex max-w-[1500px] flex-wrap justify-between gap-4 border-t border-ink/15 px-6 py-6 text-[0.8rem] font-medium tracking-[0.02em] uppercase lg:px-10">
          <span>{NETS[net].label} · built on NEAR</span>
          <span className="text-ink/60">Rates from Hyperliquid BTC funding, signed 2-of-3</span>
        </div>
      </footer>
    </section>
  );
}
