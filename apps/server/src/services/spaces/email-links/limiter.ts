import { isIPv4, isIPv6 } from 'node:net';
import { RateLimited } from '../http.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How many attempts a key may spend: in any rolling minute, and optionally in any rolling hour. */
export interface EmailLinkLimit {
  perMinute: number;
  perHour?: number;
}

/**
 * The key a per-caller limit counts against: an IPv4 address as it is, an IPv6 address by its
 * /64 (one home or one server usually holds a whole /64, so counting single IPv6 addresses would
 * hand one caller 2^64 budgets). An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) counts as
 * the IPv4 address. Anything else (a proxy that sent junk) is used as it is.
 */
export function callerLimitKey(address: string): string {
  const bare = address.split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(bare)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(bare)) return bare;
  const [head, tail = ''] = bare.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded IPv4 tail (`::1.2.3.4`) is two groups; it never reaches the first four.
  const width = right.reduce((sum, group) => sum + (group.includes('.') ? 2 : 1), 0);
  const groups = bare.includes('::')
    ? [...left, ...Array<string>(8 - left.length - width).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':')}::/64`;
}

/**
 * The rolling-window limits for mailed links, in their own bounded memory.
 *
 * Not `app.ts`'s shared attempt map: that one evicts its oldest key when it fills, so a caller
 * spraying keys into it (invite previews, many addresses) could evict an account's password-guess
 * budget. Keeping these keys apart means neither store's traffic can evict the other's.
 *
 * Bounded at `maxKeys`. When full, keys idle for an hour go first; if every key is still live,
 * the least recently used goes. Evicting here can only reset budgets for keys the caller already
 * controls, because each key is a caller address (or /64) or a hashed token use.
 *
 * Per replica: with several replicas each enforces its own limits, so the host-wide total is at
 * most the replica count times the setting. The per-address and host-wide caps on mail actually
 * queued live in the database, in the resolver, and hold across replicas.
 */
export class EmailLinkLimiter {
  private readonly times = new Map<string, number[]>();

  constructor(
    private readonly maxKeys = 50_000,
    private readonly clock: () => number = () => Date.now()
  ) {}

  /** How many keys the store holds now. */
  get size(): number {
    return this.times.size;
  }

  /**
   * Spend one attempt under `key`, or throw `429 RATE_LIMITED` with `Retry-After` when the
   * minute or the hour is already spent. A refused attempt is not counted.
   *
   * @throws {RateLimited} When either window is full.
   */
  spend(key: string, limit: EmailLinkLimit): void {
    const now = this.clock();
    const kept = (this.times.get(key) ?? []).filter((time) => now - time < HOUR_MS);
    const lastMinute = kept.filter((time) => now - time < MINUTE_MS);
    if (lastMinute.length >= limit.perMinute)
      throw limited(lastMinute[lastMinute.length - limit.perMinute] + MINUTE_MS - now);
    if (limit.perHour !== undefined && kept.length >= limit.perHour)
      throw limited(kept[kept.length - limit.perHour] + HOUR_MS - now);
    kept.push(now);
    // Re-inserted, so the map's order is least recently used first.
    this.times.delete(key);
    if (this.times.size >= this.maxKeys) this.evict(now);
    this.times.set(key, kept);
  }

  private evict(now: number) {
    for (const [key, times] of this.times)
      if (times.length === 0 || now - times[times.length - 1] >= HOUR_MS) this.times.delete(key);
    while (this.times.size >= this.maxKeys) this.times.delete(this.times.keys().next().value!);
  }
}

function limited(waitMs: number) {
  return new RateLimited(
    'Too many requests. Wait a minute, then try again.',
    Math.max(1, Math.ceil(waitMs / 1000))
  );
}
