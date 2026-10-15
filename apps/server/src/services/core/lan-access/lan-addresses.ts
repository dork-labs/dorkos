/**
 * The names and addresses another device on the same network uses to reach
 * this computer (DOR-2930): its Bonjour name (`studio.local`), which stays the
 * same when the router hands out a new address, and its current IPv4
 * addresses as a backup.
 *
 * @module services/core/lan-access/lan-addresses
 */
import { execFile } from 'node:child_process';
import os from 'node:os';

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
