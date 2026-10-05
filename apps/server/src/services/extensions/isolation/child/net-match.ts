/**
 * The network guard's matcher (DOR-2686, spec §4): whether a host and port the
 * extension connects to are in its `allow.net` list, and what kind of address
 * a resolved IP is.
 *
 * The list is parsed ONCE, by the same `parseNetEntry` the manifest schema and
 * consent use, when the guard is installed and before any extension code runs.
 * After that, every decision runs here, on the captured built-ins in
 * `intrinsics.ts`, so an extension that rewrites `String.prototype` or
 * `Array.prototype` cannot change an answer. That is also why this file
 * re-implements address parsing rather than calling the shared module at run
 * time: the shared module uses `split`, regular expressions and array methods,
 * all of which the extension can replace.
 *
 * Everything here fails closed: a host that does not parse matches nothing.
 *
 * @module services/extensions/isolation/child/net-match
 */
import { isNetEntryError, parseNetEntry } from '@dorkos/extension-api';
import { charCodeAt, endsWith, freeze, slice, toLowerCase } from './intrinsics.js';

/** A host the extension named, normalized for comparison. */
export type NetTarget =
  | { kind: 'name'; name: string }
  | { kind: 'ipv4'; v4: Uint8Array }
  | { kind: 'ipv6'; v6: Uint16Array };

/** One `allow.net` entry, prepared for the matcher. */
export interface GuardEntry {
  readonly kind: 'name' | 'ipv4' | 'ipv6';
  /** The name, for a name entry (without any `*.`). */
  readonly name: string;
  /** `.` + name, for a wildcard entry. */
  readonly suffix: string;
  readonly wildcard: boolean;
  /** The one port allowed, or `null` for any. */
  readonly port: number | null;
  readonly v4: Uint8Array | null;
  readonly v6: Uint16Array | null;
  /**
   * Whether the entry itself names a local place (a loopback, private or
   * link-local name or address). Only such an entry lets a name resolve to a
   * local address; the grammar already makes it carry a port.
   */
  readonly local: boolean;
}

/**
 * Parse a decimal number from `text[start, end)` with no sign and no leading
 * zero (except `0` itself). Returns -1 when it is not one.
 *
 * @param text - The string.
 * @param start - First index.
 * @param end - One past the last index.
 * @param maxDigits - Most digits allowed.
 */
function parseDecimal(text: string, start: number, end: number, maxDigits: number): number {
  const length = end - start;
  if (length < 1 || length > maxDigits) return -1;
  if (length > 1 && charCodeAt(text, start) === 48) return -1;
  let value = 0;
  for (let i = start; i < end; i++) {
    const c = charCodeAt(text, i);
    if (c < 48 || c > 57) return -1;
    value = value * 10 + (c - 48);
  }
  return value;
}

/**
 * Parse a strict dotted-quad IPv4 address (no leading zeros).
 *
 * @param text - The candidate.
 * @returns The four octets, or `null`.
 */
export function parseIpv4(text: string): Uint8Array | null {
  const out = new Uint8Array(4);
  let part = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || charCodeAt(text, i) === 46) {
      if (part > 3) return null;
      const value = parseDecimal(text, start, i, 3);
      if (value < 0 || value > 255) return null;
      out[part] = value;
      part++;
      start = i + 1;
    }
  }
  return part === 4 ? out : null;
}

/**
 * The value of one hexadecimal digit, or -1.
 *
 * @param c - A character code (lowercase expected).
 */
function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/**
 * Parse an IPv6 address (no brackets, no zone) into eight groups: `::`
 * compression and an IPv4 tail are understood.
 *
 * @param text - The candidate.
 * @returns The groups, or `null`.
 */
export function parseIpv6(text: string): Uint16Array | null {
  const out = new Uint16Array(8);
  // Groups before `::`, then groups after it, written to a scratch array.
  const tail = new Uint16Array(8);
  let headCount = 0;
  let tailCount = 0;
  let compressed = false;
  let i = 0;
  const n = text.length;
  if (n < 2) return null;
  if (charCodeAt(text, 0) === 58) {
    if (charCodeAt(text, 1) !== 58) return null;
    compressed = true;
    i = 2;
    if (i === n) return out;
  }
  while (i < n) {
    // A dotted IPv4 tail?
    let j = i;
    let sawDot = false;
    while (j < n && charCodeAt(text, j) !== 58) {
      if (charCodeAt(text, j) === 46) sawDot = true;
      j++;
    }
    if (sawDot) {
      if (j !== n) return null;
      const v4 = parseIpv4(slice(text, i, j));
      if (!v4) return null;
      const count = compressed ? tailCount : headCount;
      if (count > 6) return null;
      const target = compressed ? tail : out;
      target[count] = (v4[0]! << 8) | v4[1]!;
      target[count + 1] = (v4[2]! << 8) | v4[3]!;
      if (compressed) tailCount += 2;
      else headCount += 2;
      break;
    }
    const length = j - i;
    if (length < 1 || length > 4) return null;
    let value = 0;
    for (let k = i; k < j; k++) {
      const d = hexDigit(charCodeAt(text, k));
      if (d < 0) return null;
      value = value * 16 + d;
    }
    if (compressed) {
      if (tailCount >= 8) return null;
      tail[tailCount++] = value;
    } else {
      if (headCount >= 8) return null;
      out[headCount++] = value;
    }
    if (j === n) break;
    // j is at a colon.
    if (j + 1 < n && charCodeAt(text, j + 1) === 58) {
      if (compressed) return null;
      compressed = true;
      i = j + 2;
      if (i === n) break;
    } else {
      if (j + 1 === n) return null;
      i = j + 1;
    }
  }
  if (!compressed) return headCount === 8 ? out : null;
  if (headCount + tailCount > 7) return null;
  for (let k = 0; k < tailCount; k++) out[8 - tailCount + k] = tail[k]!;
  return out;
}

/**
 * Whether an IPv4 address is loopback (`127.0.0.0/8`) or unspecified (`0.0.0.0/8`).
 *
 * @param v4 - The octets.
 */
export function isLoopbackV4(v4: Uint8Array): boolean {
  return v4[0] === 127 || v4[0] === 0;
}

/**
 * Whether an IPv4 address is local: loopback, unspecified, RFC 1918, CGNAT or
 * link-local. Mirrors the shared grammar's rule.
 *
 * @param v4 - The octets.
 */
export function isLocalV4(v4: Uint8Array): boolean {
  const a = v4[0]!;
  const b = v4[1]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * The IPv4 address an IPv6 address carries (mapped `::ffff:a.b.c.d`,
 * compatible `::a.b.c.d`, or NAT64 `64:ff9b::a.b.c.d`), or `null`.
 *
 * @param g - The groups.
 */
function embeddedV4(g: Uint16Array): Uint8Array | null {
  const zeroTo = (count: number): boolean => {
    for (let i = 0; i < count; i++) if (g[i] !== 0) return false;
    return true;
  };
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0;
  if (!((zeroTo(5) && (g[5] === 0xffff || g[5] === 0)) || (nat64 && g[5] === 0))) return null;
  const v4 = new Uint8Array(4);
  v4[0] = g[6]! >> 8;
  v4[1] = g[6]! & 0xff;
  v4[2] = g[7]! >> 8;
  v4[3] = g[7]! & 0xff;
  return v4;
}

/**
 * Whether an IPv6 address is loopback or unspecified, directly or through an
 * embedded IPv4 address.
 *
 * @param g - The groups.
 */
export function isLoopbackV6(g: Uint16Array): boolean {
  let zero = true;
  for (let i = 0; i < 7; i++) if (g[i] !== 0) zero = false;
  if (zero && (g[7] === 0 || g[7] === 1)) return true;
  const v4 = embeddedV4(g);
  return v4 !== null && !(v4[0] === 0 && v4[1] === 0 && v4[2] === 0) && isLoopbackV4(v4);
}

/**
 * Whether an IPv6 address is local: loopback, unspecified, unique-local,
 * link-local, or carrying a local IPv4 address.
 *
 * @param g - The groups.
 */
export function isLocalV6(g: Uint16Array): boolean {
  if (isLoopbackV6(g)) return true;
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  const v4 = embeddedV4(g);
  return v4 !== null && isLocalV4(v4);
}

/**
 * Normalize a host the extension connects to: lowercase, brackets and one
 * trailing dot dropped, IP literals parsed.
 *
 * @param host - The host, already known to be a string.
 * @returns The target, or `null` when it cannot be a host.
 */
export function normalizeTarget(host: string): NetTarget | null {
  let t = toLowerCase(host);
  if (t.length >= 2 && charCodeAt(t, 0) === 91 && charCodeAt(t, t.length - 1) === 93) {
    t = slice(t, 1, t.length - 1);
  }
  if (t.length > 0 && charCodeAt(t, t.length - 1) === 46) t = slice(t, 0, t.length - 1);
  if (t.length === 0 || t.length > 253) return null;
  const v4 = parseIpv4(t);
  if (v4) return { kind: 'ipv4', v4 };
  for (let i = 0; i < t.length; i++) {
    if (charCodeAt(t, i) === 58) {
      const v6 = parseIpv6(t);
      return v6 ? { kind: 'ipv6', v6 } : null;
    }
  }
  return { kind: 'name', name: t };
}

/**
 * Whether two byte or group arrays hold the same address.
 *
 * @param a - One address.
 * @param b - The other.
 */
function sameAddress(a: Uint8Array | Uint16Array, b: Uint8Array | Uint16Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Whether a name is local by the shared grammar's rule: `localhost`, under
 * `.localhost` or `.local`, or a single label. Used at install time only.
 *
 * @param name - A canonical name.
 */
function isLocalName(name: string): boolean {
  return (
    !name.includes('.') ||
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local')
  );
}

/**
 * Prepare an `allow.net` list for the guard. Runs at install, before any
 * extension code, so ordinary string methods are safe here. Entries the
 * shared grammar refuses allow nothing.
 *
 * @param allowNet - The list as declared.
 * @returns A frozen list of frozen entries.
 */
export function prepareEntries(allowNet: readonly string[]): readonly GuardEntry[] {
  const out: GuardEntry[] = [];
  for (const raw of allowNet) {
    const parsed = parseNetEntry(raw);
    if (isNetEntryError(parsed)) continue;
    const v4 = parsed.kind === 'ipv4' ? parseIpv4(parsed.host) : null;
    const v6 = parsed.kind === 'ipv6' ? parseIpv6(parsed.host) : null;
    if (parsed.kind === 'ipv4' && !v4) continue;
    if (parsed.kind === 'ipv6' && !v6) continue;
    const local =
      parsed.kind === 'name'
        ? isLocalName(parsed.host)
        : parsed.kind === 'ipv4'
          ? isLocalV4(v4!)
          : isLocalV6(v6!);
    out.push(
      freeze({
        kind: parsed.kind,
        name: parsed.kind === 'name' ? parsed.host : '',
        suffix: parsed.kind === 'name' ? `.${parsed.host}` : '',
        wildcard: parsed.wildcard,
        port: parsed.port,
        v4,
        v6,
        local,
      })
    );
  }
  return freeze(out);
}

/** What the entries say about one target. */
export interface MatchResult {
  /** Some entry allows the target (on the port, when one is given). */
  matched: boolean;
  /** Some entry that allows it names a local place. */
  local: boolean;
}

/**
 * Match a target against the prepared entries. Run-time safe.
 *
 * @param entries - From {@link prepareEntries}.
 * @param target - From {@link normalizeTarget}.
 * @param port - The port, or `null` to ignore ports (a DNS question has none).
 */
export function matchTarget(
  entries: readonly GuardEntry[],
  target: NetTarget,
  port: number | null
): MatchResult {
  let matched = false;
  let local = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (port !== null && entry.port !== null && entry.port !== port) continue;
    if (entry.kind !== target.kind) continue;
    const hit =
      target.kind === 'name'
        ? entry.wildcard
          ? target.name.length > entry.suffix.length && endsWith(target.name, entry.suffix)
          : target.name === entry.name
        : target.kind === 'ipv4'
          ? sameAddress(entry.v4!, target.v4)
          : sameAddress(entry.v6!, target.v6);
    if (hit) {
      matched = true;
      if (entry.local) local = true;
    }
  }
  return { matched, local };
}

/**
 * Whether an IP target is local (loopback, private, link-local, unspecified).
 *
 * @param target - An IP target.
 */
export function isLocalTarget(target: NetTarget): boolean {
  if (target.kind === 'ipv4') return isLocalV4(target.v4);
  if (target.kind === 'ipv6') return isLocalV6(target.v6);
  return false;
}

/**
 * Whether an IP target is loopback or unspecified.
 *
 * @param target - An IP target.
 */
export function isLoopbackTarget(target: NetTarget): boolean {
  if (target.kind === 'ipv4') return isLoopbackV4(target.v4);
  if (target.kind === 'ipv6') return isLoopbackV6(target.v6);
  return false;
}

/**
 * Whether a target is one of the given addresses.
 *
 * @param target - An IP target.
 * @param addresses - Prepared addresses.
 */
export function isOneOf(target: NetTarget, addresses: readonly NetTarget[]): boolean {
  for (let i = 0; i < addresses.length; i++) {
    const a = addresses[i]!;
    if (a.kind === 'ipv4' && target.kind === 'ipv4' && sameAddress(a.v4, target.v4)) return true;
    if (a.kind === 'ipv6' && target.kind === 'ipv6' && sameAddress(a.v6, target.v6)) return true;
  }
  return false;
}

/**
 * A stable key for an IP target and port, for the approved-destination set.
 *
 * @param target - An IP target.
 * @param port - The port.
 */
export function addressKey(target: NetTarget, port: number): string {
  let key = target.kind === 'ipv4' ? '4' : '6';
  const parts = target.kind === 'ipv4' ? target.v4 : target.kind === 'ipv6' ? target.v6 : null;
  if (!parts) return '';
  for (let i = 0; i < parts.length; i++) key += `:${parts[i]!}`;
  return `${key}|${port}`;
}

/**
 * How a host and port read in a refusal: `host:port`, IPv6 in brackets.
 *
 * @param host - The host as named.
 * @param port - The port.
 */
export function displayHostPort(host: string, port: number): string {
  for (let i = 0; i < host.length; i++) {
    if (charCodeAt(host, i) === 58 && charCodeAt(host, 0) !== 91) return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}
