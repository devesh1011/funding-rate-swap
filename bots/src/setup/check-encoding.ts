// Compares the local rate-message encoding with the deployed contract's
// `get_rate_message` view for a few values, so a signer can't silently sign
// bytes the contract will not accept.

import { config } from "../lib/config.ts";
import { rateMessage } from "../lib/message.ts";
import { view } from "../lib/near.ts";

const cases: [number, bigint, bigint][] = [
  [0, 1_794_477_600n, 9_846_600n],
  [0, 1_794_481_200n, -5_129_300n],
  [0, 1_794_484_800n, 40_000_000_000n],
];

let ok = true;
for (const [feed, ts, rate] of cases) {
  const local = Buffer.from(rateMessage(config.swap, feed, ts, rate)).toString("base64");
  const remote = await view<string>(config.swap, "get_rate_message", {
    feed_id: feed,
    interval_ts: ts.toString(),
    rate: rate.toString(),
  });
  const match = local === remote;
  ok &&= match;
  console.log(`${match ? "match" : "MISMATCH"} feed=${feed} ts=${ts} rate=${rate}`);
}
if (!ok) process.exit(1);
