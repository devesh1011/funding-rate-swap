/** Slanted "F" mark: two bars and a stem, cut at the same angle. Takes the text colour. */
export function LogoMark({ className = "size-9 text-lime" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} fill="currentColor" aria-hidden>
      <path d="M10 4h28l-4 8H10z" />
      <path d="M10 16h20l-4 8H10z" />
      <path d="M2 4h8v28l-8 6z" />
    </svg>
  );
}

/** "Fund" in the grotesk, "swap" in the italic serif accent. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`tracking-[-0.04em] ${className}`}>
      Fund<span className="accent">swap</span>
    </span>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-3">
      <LogoMark />
      <Wordmark className="text-[1.75rem] leading-none" />
    </span>
  );
}
