/**
 * The `allow.net` entry grammar for an extension that runs separately
 * (`serverCapabilities.runtime: "subprocess"`, DOR-2686).
 *
 * One pure module, shared by the manifest schema (which refuses a bad entry
 * with a reason the author can act on), by consent (an approval for one list
 * must never cover a wider one) and, later, by the network guard inside the
 * extension's own process. Keeping all three on one parser is the point: an
 * entry that means one thing to the schema and another to the guard is a
 * hole, whichever way round it goes.
 *
 * ## The grammar
 *
 * `host[:port]`, where `host` is one of:
 *
 * - a lowercase ASCII DNS name (`api.example.com`), optionally led by `*.`,
 *   which matches one or more labels BELOW the named domain and never the
 *   domain itself;
 * - an IPv4 literal in plain dotted-quad form (`192.168.1.10`);
 * - a bracketed IPv6 literal (`[2001:db8::1]`).
 *
 * An omitted port means any port. Entries are deliberately strict, because a
 * permission list a person reads has to have one spelling per meaning:
 *
 * - no scheme, path, query or credentials (`https://x`, `x/y`, `u@x`);
 * - no uppercase and no non-ASCII: an international name is written in its
 *   `xn--` form, and compared exactly as written, so the same host can never
 *   appear under two spellings that compare differently;
 * - no trailing dot (a host being matched has its trailing dot ignored);
 * - no number-only "names" (`2130706433`, `0x7f000001`, `127.1`): the system
 *   resolver reads those as IPv4 addresses, so one could smuggle a loopback
 *   address past the "local needs a port" rule;
 * - a local address needs an explicit port: loopback (`localhost`,
 *   `*.localhost`, `127.0.0.0/8`, `::1`), private (RFC 1918, CGNAT
 *   `100.64.0.0/10`, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`,
 *   `*.local`), the unspecified address (`0.0.0.0/8`, `::`) and single-label
 *   names, which resolve through the computer's own search domains;
 * - a wildcard needs at least two labels under it (`*.example.com`, never
 *   `*.com`) and never sits on an address.
 *
 * IPv6 literals are canonicalized (RFC 5952: lowercase, leading zeros
 * dropped, the longest zero run compressed) so `[0:0::1]` and `[::1]` are one
 * entry.
 *
 * @module extension-api/net-allowlist
 */

/** What kind of host an `allow.net` entry names. */
export type NetEntryKind = 'name' | 'ipv4' | 'ipv6';

/** One parsed, canonical `allow.net` entry. */
export interface ParsedNetEntry {
  /**
   * The host, canonical: a lowercase DNS name WITHOUT any `*.` prefix, a
   * dotted-quad IPv4 address, or an RFC 5952 IPv6 address without brackets.
   */
  host: string;
  /** Whether the entry was `*.host`: it matches names below `host`, never `host` itself. */
  wildcard: boolean;
  /** The one port it allows, or `null` for any port. */
  port: number | null;
  /** The kind of host. */
  kind: NetEntryKind;
}

/** Why an entry was refused, in words an extension author can act on. */
export interface NetEntryError {
  /** The reason, one sentence. */
  error: string;
}

/** The longest entry accepted, in characters. */
const MAX_ENTRY_LENGTH = 260;

/** The reason given for a scheme, path, query or credentials. */
export const NET_ENTRY_JUST_HOST = 'Write just the host, like api.example.com';

/** The reason given for a local address without a port. */
export const NET_ENTRY_LOCAL_NEEDS_PORT = 'Add a port for a local address, like localhost:8080';

/** One DNS label: letters, digits and inner hyphens, 1 to 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A label the system resolver would read as part of a number-form IPv4 address. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;

/**
 * Parse a dotted-quad IPv4 address with no leading zeros.
 *
 * @param text - The candidate.
 * @returns The four octets, or `null`.
 */
function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * Parse an IPv6 address (no brackets, no zone) into its eight 16-bit groups.
 *
 * @param text - The candidate, lowercase.
 * @returns The groups, or `null`.
 */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string, allowV4Tail: boolean): number[] | null => {
    if (part === '') return [];
    const pieces = part.split(':');
    const groups: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (allowV4Tail && i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = toGroups(halves[0]!, true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = toGroups(halves[0]!, false);
  const tail = toGroups(halves[1]!, true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Format eight IPv6 groups the RFC 5952 way.
 *
 * @param groups - The eight groups.
 */
function formatIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart === -1) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/**
 * Whether an IPv4 address is loopback, private, link-local, CGNAT or
 * unspecified.
 *
 * @param octets - The four octets.
 */
function isLocalIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number];
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
 * Whether an IPv6 address is loopback, unspecified, unique-local, link-local,
 * or an IPv4 address (mapped, compatible, or NAT64) that is local.
 *
 * @param groups - The eight groups.
 */
function isLocalIpv6(groups: readonly number[]): boolean {
  const v4Of = (): number[] => [
    groups[6]! >> 8,
    groups[6]! & 0xff,
    groups[7]! >> 8,
    groups[7]! & 0xff,
  ];
  const zeroTo = (n: number): boolean => groups.slice(0, n).every((g) => g === 0);
  if (zeroTo(7) && (groups[7] === 0 || groups[7] === 1)) return true;
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) reach the IPv4 address.
  if (zeroTo(5) && (groups[5] === 0xffff || groups[5] === 0)) return isLocalIpv4(v4Of());
  // 64:ff9b::a.b.c.d (NAT64) can reach it too.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isLocalIpv4(v4Of());
  }
  return false;
}

/**
 * Whether a DNS name is local: `localhost`, anything under `.localhost` or
 * `.local`, or a single label (resolved through the computer's search
 * domains, so it usually means a machine on the local network).
 *
 * @param name - The canonical name.
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
 * Check a DNS name: lowercase ASCII labels, at most 253 characters, and not a
 * number in disguise.
 *
 * @param name - The candidate, without any `*.` prefix.
 * @returns A reason, or `null` when it is a good name.
 */
function nameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 253) return 'Write a host, like api.example.com';
  if (name.endsWith('.')) return 'Leave off the trailing dot, like api.example.com';
  const labels = name.split('.');
  if (!labels.every((label) => LABEL.test(label))) {
    return 'Use letters, digits, hyphens and dots only, like api.example.com';
  }
  if (NUMERIC_LABEL.test(labels[labels.length - 1]!)) {
    return 'Write an IPv4 address as four numbers, like 192.168.1.10';
  }
  return null;
}

/**
 * Parse one `allow.net` entry. Pure: nothing is resolved or looked up.
 *
 * @param entry - The entry as the manifest wrote it.
 * @returns The canonical entry, or the reason it was refused.
 */
export function parseNetEntry(entry: string): ParsedNetEntry | NetEntryError {
  if (typeof entry !== 'string' || entry.length === 0) {
    return { error: 'Write a host, like api.example.com' };
  }
  if (entry.length > MAX_ENTRY_LENGTH) return { error: 'This host is too long' };
  // Anything that is not a host: a scheme, a path, a query, credentials,
  // a Windows-style path, or whitespace.
  if (/[/\\@?#\s]/.test(entry) || entry.includes('://')) return { error: NET_ENTRY_JUST_HOST };
  if (/[^\x21-\x7e]/.test(entry)) {
    return {
      error: 'Write an international name in its xn-- form, like xn--bcher-kva.example',
    };
  }
  if (/[A-Z]/.test(entry)) return { error: 'Write the host in lowercase, like api.example.com' };
  if (entry === '*' || entry === '*.') {
    return { error: 'Name a host: "*" alone would allow every host' };
  }

  // Split host and port.
  let hostPart: string;
  let portPart: string | null = null;
  let bracketed = false;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) return { error: 'Close the IPv6 address with "]", like [2001:db8::1]:443' };
    hostPart = entry.slice(1, close);
    bracketed = true;
    const rest = entry.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return { error: NET_ENTRY_JUST_HOST };
      portPart = rest.slice(1);
    }
  } else {
    const colons = entry.split(':').length - 1;
    if (colons > 1) {
      return { error: 'Put an IPv6 address in brackets, like [2001:db8::1]:443' };
    }
    if (colons === 1) {
      const at = entry.indexOf(':');
      hostPart = entry.slice(0, at);
      portPart = entry.slice(at + 1);
    } else {
      hostPart = entry;
    }
  }

  let port: number | null = null;
  if (portPart !== null) {
    if (!/^[1-9][0-9]{0,4}$/.test(portPart) || Number(portPart) > 65535) {
      return { error: 'Use a port from 1 to 65535, like api.example.com:443' };
    }
    port = Number(portPart);
  }

  if (bracketed) {
    if (hostPart.includes('%')) return { error: 'Leave the zone off an IPv6 address' };
    const groups = parseIpv6(hostPart);
    if (!groups) return { error: 'This is not a valid IPv6 address' };
    if (port === null && isLocalIpv6(groups)) return { error: NET_ENTRY_LOCAL_NEEDS_PORT };
    return { host: formatIpv6(groups), wildcard: false, port, kind: 'ipv6' };
  }

  const v4 = parseIpv4(hostPart);
  if (v4) {
    if (port === null && isLocalIpv4(v4)) return { error: NET_ENTRY_LOCAL_NEEDS_PORT };
    return { host: v4.join('.'), wildcard: false, port, kind: 'ipv4' };
  }

  let wildcard = false;
  let name = hostPart;
  if (name.startsWith('*.')) {
    wildcard = true;
    name = name.slice(2);
  }
  if (name.includes('*')) {
    return { error: 'Use "*." only at the start, like *.example.com' };
  }
  const problem = nameProblem(name);
  if (problem) return { error: problem };
  // A wildcard needs at least two labels under it. That stops `*.com` but
  // not a wildcard over a multi-label public suffix (`*.co.uk`,
  // `*.github.io`): refusing those needs the Public Suffix List, which this
  // dependency-free contract package does not carry. Such an entry is shown
  // to a person verbatim on the card before it is approved, and the network
  // guard re-checks every resolved address, so it is a broad yes, never a
  // silent one.
  if (wildcard && !name.includes('.')) {
    return { error: 'A wildcard needs a domain under it, like *.example.com' };
  }
  if (port === null && isLocalName(name)) return { error: NET_ENTRY_LOCAL_NEEDS_PORT };
  return { host: name, wildcard, port, kind: 'name' };
}

/**
 * Whether {@link parseNetEntry} refused the entry.
 *
 * @param parsed - Its result.
 */
export function isNetEntryError(parsed: ParsedNetEntry | NetEntryError): parsed is NetEntryError {
  return 'error' in parsed;
}

/**
 * The one spelling of a parsed entry, e.g. `*.example.com`, `[::1]:3000`.
 *
 * @param entry - A parsed entry.
 */
export function formatNetEntry(entry: ParsedNetEntry): string {
  const host = entry.kind === 'ipv6' ? `[${entry.host}]` : entry.host;
  const withWildcard = entry.wildcard ? `*.${host}` : host;
  return entry.port === null ? withWildcard : `${withWildcard}:${entry.port}`;
}

/**
 * Parse every entry, dropping the ones {@link parseNetEntry} refuses. A
 * refused entry allows nothing.
 *
 * @param entries - Entries as written.
 */
function parseAll(entries: readonly string[]): ParsedNetEntry[] {
  return entries.map(parseNetEntry).filter((p): p is ParsedNetEntry => !isNetEntryError(p));
}

/**
 * Turn a host being connected to into the form entries are compared in:
 * lowercase, one trailing dot ignored, brackets dropped, IP literals
 * canonical. Non-ASCII is left as given, so it never matches an entry.
 *
 * @param host - The host as a caller named it.
 */
function normalizeTarget(host: string): { host: string; kind: NetEntryKind } | null {
  let target = host.toLowerCase();
  if (target.startsWith('[') && target.endsWith(']')) target = target.slice(1, -1);
  if (target.endsWith('.')) target = target.slice(0, -1);
  if (target.length === 0) return null;
  const v4 = parseIpv4(target);
  if (v4) return { host: v4.join('.'), kind: 'ipv4' };
  if (target.includes(':')) {
    const groups = parseIpv6(target);
    return groups ? { host: formatIpv6(groups), kind: 'ipv6' } : null;
  }
  return { host: target, kind: 'name' };
}

/**
 * Whether one entry names a host.
 *
 * @param entry - A parsed entry.
 * @param host - A normalized host.
 * @param kind - Its kind.
 */
function entryNamesHost(entry: ParsedNetEntry, host: string, kind: NetEntryKind): boolean {
  if (entry.kind !== kind) return false;
  if (!entry.wildcard) return entry.host === host;
  return host.endsWith(`.${entry.host}`);
}

/**
 * Whether a connection to `host` on `port` is allowed by any of `entries`.
 *
 * Case-insensitive, a trailing dot on `host` is ignored, IP literals compare
 * canonically, and an international name compares only in the `xn--` form it
 * was written in. A wildcard entry matches names below its domain, never the
 * domain itself. Entries that do not parse allow nothing.
 *
 * @param entries - The `allow.net` list.
 * @param host - The host being connected to.
 * @param port - The port being connected to.
 * @returns `true` when the connection is allowed.
 */
export function matchesNetEntry(entries: readonly string[], host: string, port: number): boolean {
  const target = normalizeTarget(host);
  if (!target) return false;
  return parseAll(entries).some(
    (entry) =>
      (entry.port === null || entry.port === port) &&
      entryNamesHost(entry, target.host, target.kind)
  );
}

/**
 * Whether one entry allows everything another allows: the same host and port,
 * an approved entry with no port for that host, or an approved wildcard whose
 * domain is above the declared host (or above, or equal to, a declared
 * wildcard's domain). A declared entry with no port is covered only by an
 * approved entry with no port.
 *
 * @param approved - The wider candidate.
 * @param declared - The entry that must fit inside it.
 */
function entryCovers(approved: ParsedNetEntry, declared: ParsedNetEntry): boolean {
  if (approved.port !== null && approved.port !== declared.port) return false;
  if (approved.kind !== declared.kind) return false;
  if (!approved.wildcard) return !declared.wildcard && approved.host === declared.host;
  if (declared.wildcard) {
    return declared.host === approved.host || declared.host.endsWith(`.${approved.host}`);
  }
  return declared.host.endsWith(`.${approved.host}`);
}

/**
 * Whether every host and port `declared` allows is already allowed by one of
 * the `approved` entries. A declared entry that does not parse is never
 * covered, so a list that cannot be read never rides on an approval.
 *
 * @param approved - The entries a person approved.
 * @param declared - One entry a manifest declares now.
 * @returns `true` when nothing new is allowed.
 */
export function isNetEntryCovered(approved: readonly string[], declared: string): boolean {
  const parsed = parseNetEntry(declared);
  if (isNetEntryError(parsed)) return false;
  return parseAll(approved).some((entry) => entryCovers(entry, parsed));
}
