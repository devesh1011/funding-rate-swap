/** Slanted "F" mark: two bars and a stem, cut at the same angle. */
export function LogoMark({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden>
      <path d="M10 4h28l-4 8H10z" fill="#c6f432" />
      <path d="M10 16h20l-4 8H10z" fill="#c6f432" />
      <path d="M2 4h8v28l-8 6z" fill="#c6f432" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-3">
      <LogoMark />
      <span className="font-serif text-[2rem] leading-none tracking-tight">Fundswap</span>
    </span>
  );
}
