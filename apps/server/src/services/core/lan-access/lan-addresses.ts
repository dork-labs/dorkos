/**
 * The names and addresses another device on the same network uses to reach
 * this computer (DOR-2930): its Bonjour name (`studio.local`), which stays the
 * same when the router hands out a new address, and its current IPv4
 * addresses as a backup.
 *
 * @module services/core/lan-access/lan-addresses
 */
import { execFile } from 'node:child_process';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import os from 'node:os';

/** The shared range Tailscale hands its IPv4 addresses out of, one per device. */
const TAILNET_V4_START = '100.64.0.0';
/** The prefix length of {@link TAILNET_V4_START}'s range, `100.64.0.0/10`. */
const TAILNET_V4_PREFIX = 10;
const TAILNET_V4 = new BlockList();
TAILNET_V4.addSubnet(TAILNET_V4_START, TAILNET_V4_PREFIX, 'ipv4');
/** Tailscale's own IPv6 prefix, which every Tailscale (and Headscale) device also holds. */
const TAILNET_V6 = new BlockList();
TAILNET_V6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/**
 * Whether one interface is a Tailscale one: a single IPv4 address (a `/32`) in
 * `100.64.0.0/10` beside an address in Tailscale's own IPv6 prefix. A cellular
 * modem on carrier NAT or another VPN can hold a `/32` in that IPv4 range too,
 * but not the IPv6 address, so its carrier's other subscribers stay out.
 */
function isTailnetInterface(entries: os.NetworkInterfaceInfo[]): boolean {
  const v4 = entries.some(
    (entry) =>
      entry.family === 'IPv4' &&
      entry.cidr?.endsWith('/32') === true &&
      TAILNET_V4.check(entry.address, 'ipv4')
  );
  return v4 && entries.some((e) => e.family === 'IPv6' && TAILNET_V6.check(e.address, 'ipv6'));
}

/** One label of a host name: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * This computer's current IPv4 addresses on its networks: not loopback, and
 * not a self-assigned `169.254.x.x` address, which no other device can route to.
 *
 * IPv6 is left out on purpose. A phone typing an address types IPv4, and the
 * Bonjour name covers everything else.
 *
 * @param interfaces - The interface table; defaults to the live one.
 */
export function readLanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const found = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      found.add(entry.address);
    }
  }
  return [...found];
}

/**
 * Turn a computer name into its `.local` Bonjour name, lower case, or `null`
 * when it cannot be one (spaces, punctuation, an empty name).
 *
 * @param name - A bare name (`Studio`) or one already ending in `.local`.
 */
export function toLocalName(name: string): string | null {
  const bare = name
    .trim()
    .toLowerCase()
    .replace(/\.local\.?$/, '');
  if (!HOST_LABEL.test(bare)) return null;
  return `${bare}.local`;
}

/** Run a command and resolve its trimmed output, or `null` when it fails. */
function runForOutput(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

/**
 * This computer's Bonjour name, e.g. `studio.local`, or `null` when it has none.
 *
 * On a Mac it is the "Local hostname" in System Settings → General → Sharing,
 * which `scutil --get LocalHostName` reads; `os.hostname()` can be a different
 * name a DNS server handed out. Elsewhere the host name is the best guess, and
 * Linux (Avahi) and Windows answer `<hostname>.local` the same way.
 *
 * @param platform - The operating system; defaults to this one.
 */
export async function readLocalName(
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (platform === 'darwin') {
    const localHostName = await runForOutput('scutil', ['--get', 'LocalHostName']);
    const named = localHostName ? toLocalName(localHostName) : null;
    if (named) return named;
  }
  return toLocalName(os.hostname().split('.')[0] ?? '');
}

/**
 * Whether a connecting peer is on one of this computer's own networks: inside
 * the subnet of one of its interfaces, IPv6 link-local, or this computer.
 *
 * The listener binds every interface, which on a Mac with a public IPv6
 * address, a VPN, or a public IPv4 address includes the internet. "Devices on my
 * network" means a peer that shares a subnet with this computer, so anything else
 * is refused at the socket, before a byte of the sign-in page goes out over
 * plain `http`.
 *
 * Tailscale needs more than its own subnet (DOR-5135). It gives this computer
 * a single address in `100.64.0.0/10` (a `/32`), and every other device on the
 * tailnet has its own address in that same range. So on a Tailscale interface
 * ({@link isTailnetInterface}) the whole range counts as its network. Tailscale
 * routes that range into its own tunnel, so a reply to a 100.x peer that is not
 * on the tailnet goes nowhere, and the range never routes on the internet.
 *
 * @param peer - `socket.remoteAddress`.
 * @param interfaces - The interface table; defaults to the live one.
 */
export function isLocalNetworkPeer(
  peer: string | undefined,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): boolean {
  if (!peer) return false;
  let address = peer.toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (address.startsWith('::ffff:') && isIPv4(address.slice(7))) address = address.slice(7);
  const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
  if (!family) return false;

  const local = new BlockList();
  local.addSubnet('127.0.0.0', 8, 'ipv4');
  local.addAddress('::1', 'ipv6');
  local.addSubnet('fe80::', 10, 'ipv6');
  for (const entries of Object.values(interfaces)) {
    if (entries && isTailnetInterface(entries)) {
      local.addSubnet(TAILNET_V4_START, TAILNET_V4_PREFIX, 'ipv4');
    }
    for (const entry of entries ?? []) {
      const prefix = Number(entry.cidr?.split('/')[1]);
      // A subnet wider than a /8 (or an IPv6 /32) is no one's home network, and a
      // `/0` would let the whole internet in.
      const narrowest = entry.family === 'IPv4' ? 8 : 32;
      if (!entry.cidr || !Number.isInteger(prefix) || prefix < narrowest) continue;
      local.addSubnet(entry.address, prefix, entry.family === 'IPv4' ? 'ipv4' : 'ipv6');
    }
  }
  return local.check(address, family);
}
