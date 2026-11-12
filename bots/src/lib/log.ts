export function log(scope: string, msg: string, extra?: Record<string, unknown>) {
  const line = `${new Date().toISOString()} [${scope}] ${msg}`;
  console.log(extra ? `${line} ${JSON.stringify(extra, (_, v) => (typeof v === "bigint" ? v.toString() : v))}` : line);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `tick` forever every `everyMs`, logging and surviving errors. */
export async function loop(scope: string, everyMs: number, tick: () => Promise<void>, once = process.argv.includes("--once")) {
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(scope, "tick failed", { error: e instanceof Error ? e.message : String(e) });
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await sleep(everyMs);
  }
}
