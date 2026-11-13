import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { TabBrokerError } from './errors.js';

/** Per-page policy supplied by the host. An absent allowlist allows public sites; an empty one denies all. */
export interface TabUrlPolicyOptions {
  readonly allowedOrigins?: readonly string[];
  readonly blockedOrigins?: readonly string[];
  readonly allowPrivateNetworks?: boolean;
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Existing host rules, including protected application origins, stay outside the broker. */
  readonly check?: (url: URL) => void;
}

const reserved = new BlockList();
const publicScopes = new BlockList();
publicScopes.addSubnet('0.0.0.0', 0, 'ipv4');
publicScopes.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  reserved.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['2001::', 32],
  ['2002::', 16],
] as const)
  reserved.addSubnet(address, prefix, 'ipv6');

function refused(): TabBrokerError {
  return new TabBrokerError(
    'url_blocked',
    'This address isn’t allowed for this tab. Ask the person to choose another site.'
  );
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new RangeError('Use an HTTP or HTTPS origin in a tab URL policy.');
  }
  return url.origin;
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  // Node's BlockList applies IPv4 ranges to IPv4-mapped IPv6 addresses too.
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return publicScopes.check(address, type) && !reserved.check(address, type);
}

/**
 * Admission policy for navigation and every redirected request. Hosts must invoke it for each
 * destination; a DNS check is not address pinning or a substitute for a network boundary.
 */
export class TabUrlPolicy {
  private readonly allowed?: ReadonlySet<string>;
  private readonly blocked: ReadonlySet<string>;
  private readonly resolve: (hostname: string) => Promise<readonly string[]>;

  constructor(private readonly options: TabUrlPolicyOptions = {}) {
    this.allowed = options.allowedOrigins ? new Set(options.allowedOrigins.map(origin)) : undefined;
    this.blocked = new Set(options.blockedOrigins?.map(origin) ?? []);
    this.resolve =
      options.resolve ??
      (async (hostname) => (await lookup(hostname, { all: true })).map((answer) => answer.address));
  }

  /** Check schemes, site choices, host rules and every resolved address without exposing lookup details. */
  async assert(value: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw refused();
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw refused();
    if (this.blocked.has(url.origin) || (this.allowed && !this.allowed.has(url.origin)))
      throw refused();
    this.options.check?.(url);
    if (this.options.allowPrivateNetworks) return url;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) {
      if (!publicAddress(hostname)) throw refused();
      return url;
    }
    let addresses: readonly string[];
    try {
      addresses = await this.resolve(hostname);
    } catch {
      throw refused();
    }
    if (!addresses.length || !addresses.every(publicAddress)) throw refused();
    return url;
  }
}
