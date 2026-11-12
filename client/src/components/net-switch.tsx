import Link from "next/link";
import { NETS, type Net } from "@/lib/config";

/** Mainnet / Testnet segmented switch; `page` keeps you on the same page across networks. */
export function NetSwitch({ net, page }: { net: Net; page: "home" | "trade" }) {
  return (
    <div className="flex items-center rounded-full border border-white/15 p-0.5 text-xs" role="group" aria-label="Network">
      {(Object.keys(NETS) as Net[]).map((n) => {
        const href = `${NETS[n].base}${page === "trade" ? "/trade" : ""}` || "/";
        const on = n === net;
        return (
          <Link
            key={n}
            href={href}
            aria-current={on ? "page" : undefined}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium whitespace-nowrap ${on ? "bg-white/10 text-white" : "text-white/55 hover:text-white"}`}
          >
            {on && <span className="live-dot size-1.5 rounded-full bg-lime" />}
            {NETS[n].label}
          </Link>
        );
      })}
    </div>
  );
}
