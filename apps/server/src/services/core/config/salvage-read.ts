/**
 * Reading a config file `conf` refused, so its protections can be salvaged
 * before it is replaced, and the blocking wait both that read and the load
 * retry on. Moved out of `config-manager.ts` to keep it under its size ratchet.
 *
 * @module services/core/config/salvage-read
 */
import fs from 'node:fs';

/**
 * Block this thread for `ms`.
 *
 * Deliberately blocking: `ConfigManager` is constructed synchronously
 * during boot and everything after it needs the config, so there is nothing
 * useful to yield to. Only ever reached on the retry path, and bounded by
 * `CONFIG_LOAD_RETRY_DELAYS_MS`.
 *
 * @param ms - How long to block for.
 */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The result of reading a config file that `conf` refused, before replacing it.
 *
 * The two cases are kept apart because only one of them permits a replacement.
 * `read: true` means the bytes are in hand, which is both what salvage needs
 * and the only proof that the file, rather than the machine, is the problem.
 * `read: false` means the file was never read at all, and nothing may be
 * concluded from that except that DorkOS must keep its hands off it.
 */
export type SalvageRead = { read: true; value: unknown } | { read: false; error: unknown };

/**
 * Read a config file that `conf` just refused, so its protections can be
 * salvaged before the file is replaced.
 *
 * Retried on the same staircase as the load itself, and for the same reason.
 * This read happens during whatever is going wrong on the machine, so a single
 * unretried attempt is at its least likely to succeed exactly when it matters
 * most: a storm that condemns the file is still blowing when salvage runs, and
 * a salvage that comes back empty silently costs the person a protection
 * (DOR-584) rather than a preference.
 *
 * Never throws. A read that worked but whose contents will not parse is still
 * `read: true` with an `undefined` value — a truncated file is genuinely
 * unsalvageable, and that is a different fact from never having seen it.
 *
 * @param configPath - Absolute path to the config file being replaced.
 * @param retryDelaysMs - Backoff between attempts; its length is the retry count.
 * @returns The parsed contents, or the failure that stopped the read.
 */
export function readStoredConfigForSalvage(
  configPath: string,
  retryDelaysMs: readonly number[]
): SalvageRead {
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) return { read: false, error };
      sleepSync(delay);
      continue;
    }
    try {
      return { read: true, value: JSON.parse(raw) };
    } catch {
      // Read fine, will not parse. Nothing to salvage, but the file is
      // genuinely damaged and may be replaced.
      return { read: true, value: undefined };
    }
  }
}
