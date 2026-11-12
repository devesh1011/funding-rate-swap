// Keeper: liquidates unhealthy accounts and settles matured positions.
//
// Walks every account through the contract's paginated views. For an account
// below maintenance margin it calls `liquidate` per open market, taking the
// position over at mark and earning the penalty. For positions in matured
// markets it calls `settle`, which pays final funding and releases margin.

import { config } from "../lib/config.ts";
import { log, loop } from "../lib/log.ts";
import { call, loadAccount, swap } from "../lib/near.ts";
import { formatUsdc } from "../lib/units.ts";

const keeper = loadAccount("KEEPER", "keeper.fundswap-treasury.testnet");
const PAGE = 100;

async function tick() {
  const markets = new Map((await swap.markets()).map((m) => [m.id, m]));
  for (let from = 0; ; from += PAGE) {
    const ids = await swap.accounts(from, PAGE);
    for (const id of ids) {
      if (id === keeper.accountId) continue;
      const a = await swap.account(id);
      if (!a) continue;

      if (a.health.liquidatable) {
        for (const p of a.positions.filter((p) => BigInt(p.n) !== 0n)) {
          try {
            const r = await call<string>(keeper, config.swap, "liquidate", { account_id: id, market_id: p.market_id }, { gasTera: 300 });
            log("keeper", `liquidated ${id}`, {
              market: markets.get(p.market_id)?.name,
              size: p.n,
              net: formatUsdc(BigInt(a.health.net)),
              maintenance: formatUsdc(BigInt(a.health.maintenance_margin)),
              penalty: r.value,
              tx: config.explorer(r.hash),
            });
          } catch (e) {
            log("keeper", "liquidation failed", { account: id, market: p.market_id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        continue;
      }

      const matured = a.positions.some((p) => markets.get(p.market_id)?.final_cum != null);
      if (matured) {
        const r = await call<string>(keeper, config.swap, "settle", { account_id: id });
        log("keeper", `settled matured positions of ${id}`, { realized: r.value, tx: config.explorer(r.hash) });
      }
    }
    if (ids.length < PAGE) break;
  }
}

log("keeper", "started", { account: keeper.accountId });
await loop("keeper", config.num("KEEPER_POLL_SECS", 30) * 1000, tick);
