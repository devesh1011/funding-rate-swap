// Oracle: fetch → sign → submit.
//
// For every `hyperliquid:<COIN>` feed on the contract, each signer reads
// Hyperliquid's settled funding history on its own and signs the intervals
// it sees. An interval is submitted only when at least `threshold` signers
// fetched the identical rate; nothing is ever guessed or interpolated. Missed
// intervals are backfilled in order, up to 24 per transaction.

import { KeyPair, type KeyPairString } from "near-api-js";
import { config } from "../lib/config.ts";
import { fundingHistory, type FundingPoint } from "../lib/hyperliquid.ts";
import { log, loop } from "../lib/log.ts";
import { rateMessage } from "../lib/message.ts";
import { call, loadAccount, swap, view, type FeedView } from "../lib/near.ts";
import { formatPct, hourlyToApr } from "../lib/units.ts";

const MAX_BATCH = 24;

interface Signer {
  index: number;
  key: KeyPair;
}

function loadSigners(publicKeys: string[]): Signer[] {
  const signers: Signer[] = [];
  for (let i = 0; i < publicKeys.length; i++) {
    const secret = config.optional(`ORACLE_SIGNER_${i}`);
    if (!secret) continue;
    const key = KeyPair.fromString(secret as KeyPairString);
    const pub = key.getPublicKey().toString();
    if (pub !== publicKeys[i]) throw new Error(`ORACLE_SIGNER_${i} is ${pub}, contract expects ${publicKeys[i]}`);
    signers.push({ index: i, key });
  }
  return signers;
}

/** One signer's independent view: interval → rate. */
async function observe(coin: string, from: bigint): Promise<Map<bigint, FundingPoint>> {
  const points = await fundingHistory(coin, from);
  return new Map(points.map((p) => [p.intervalTs, p]));
}

async function processFeed(feed: FeedView, signers: Signer[], threshold: number, oracle: ReturnType<typeof loadAccount>) {
  const coin = feed.name.split(":")[1];
  const interval = BigInt(feed.interval_secs);
  const now = BigInt(Math.floor(Date.now() / 1000));
  let next = BigInt(feed.last_ts) + interval;
  if (next > now) return;

  // Each signer fetches separately; they only agree if the venue's data agrees.
  const views = await Promise.all(signers.map(() => observe(coin, next)));

  const entries: object[] = [];
  for (; next <= now && entries.length < MAX_BATCH; next += interval) {
    const seen = views.map((v) => v.get(next));
    const present = seen.filter((p): p is FundingPoint => p !== undefined);
    if (present.length < threshold) break; // not published yet
    const rate = present[0].rate;
    const agreeing = signers.filter((_, i) => seen[i]?.rate === rate);
    if (agreeing.length < threshold) {
      log("oracle", "signers disagree; not submitting", { feed: feed.id, interval: next, seen: seen.map((p) => p?.raw) });
      break;
    }
    const msg = rateMessage(config.swap, feed.id, next, rate);
    entries.push({
      interval_ts: next.toString(),
      rate: rate.toString(),
      sigs: agreeing.map((s) => ({
        signer: s.index,
        signature: Buffer.from(s.key.sign(msg).signature).toString("base64"),
      })),
    });
    log("oracle", "signed", { feed: feed.name, interval: new Date(Number(next) * 1000).toISOString(), raw: present[0].raw, apr: formatPct(hourlyToApr(rate)), signers: agreeing.map((s) => s.index) });
  }
  if (entries.length === 0) return;

  const { hash } = await call(oracle, config.swap, "submit_rates", { feed_id: feed.id, entries }, { gasTera: 300 });
  log("oracle", `submitted ${entries.length} interval(s)`, { feed: feed.name, tx: config.explorer(hash) });
}

async function main() {
  const cfg = await view<{ signers: string[]; threshold: number }>(config.swap, "get_config");
  const signers = loadSigners(cfg.signers);
  if (signers.length < cfg.threshold) {
    throw new Error(`have ${signers.length} signer keys, contract needs ${cfg.threshold}`);
  }
  const oracle = loadAccount("ORACLE", "oracle.fundswap-treasury.testnet");
  log("oracle", "started", { contract: config.swap, submitter: oracle.accountId, signers: signers.map((s) => s.index), threshold: cfg.threshold });

  await loop("oracle", config.num("ORACLE_POLL_SECS", 60) * 1000, async () => {
    const feeds = (await swap.feeds()).filter((f) => f.name.startsWith("hyperliquid:"));
    for (const feed of feeds) await processFeed(feed, signers, cfg.threshold, oracle);
  });
}

await main();
