/**
 * The host names and origins this server answers to on the network while Wi-Fi
 * access is open (DOR-2930), read by the host guard and the origin policy in
 * `lib/trusted-origins.ts`.
 *
 * Its own module with no service imports, so `trusted-origins.ts`, which sits
 * under every request, can read it without pulling in the auth stack. Only the
 * Wi-Fi access controller writes it: open means trusted, closed means not.
 *
 * @module services/core/lan-access/lan-trust
 */
import { readLanAddresses } from './lan-addresses.js';

/** What the open listener answers to. `null` while it is closed. */
interface LanTrust {
  /** The port other devices dial. */
  port: number;
  /** Bonjour names, lower case. Addresses are read live, not stored. */
  names: readonly string[];
  /** Whether sign-in cookies are `Secure` in this build (`AUTH_COOKIES_SECURE`). */
  secureCookies: boolean;
}

let trust: LanTrust | null = null;

/** How long one read of the network addresses is reused, in milliseconds. */
const ADDRESS_TTL_MS = 5_000;
let addressCache: { at: number; addresses: string[] } | null = null;

/**
 * The current IPv4 addresses, reread at most every {@link ADDRESS_TTL_MS}.
 * They change when the computer joins another network, so they are never
 * fixed at open time, but this runs on every request and the interface table
 * does not need reading that often.
 */
function currentAddresses(): string[] {
  const now = Date.now();
  if (!addressCache || now - addressCache.at > ADDRESS_TTL_MS) {
    addressCache = { at: now, addresses: readLanAddresses() };
  }
  return addressCache.addresses;
}

/**
 * Record that the listener opened (or closed, with `null`). Only the Wi-Fi
 * access controller calls this.
 *
 * @param next - The port and Bonjour names, or `null` when closed.
 */
export function setLanTrust(next: LanTrust | null): void {
  trust = next;
  addressCache = null;
}

/**
 * Host names (no port) this server answers to on the network right now: its
 * Bonjour names and current IPv4 addresses. Empty while Wi-Fi access is closed.
 */
export function getLanAccessHosts(): string[] {
  if (!trust) return [];
  return [...trust.names, ...currentAddresses()];
}

/**
 * Whether a request's `Host` names this computer on the network while Wi-Fi
 * access is open: its `.local` name or one of its addresses, any port.
 *
 * @param hostHeader - The raw `Host` header.
 */
export function isLanAccessHost(hostHeader: string | undefined): boolean {
  if (!trust || !hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return !!name && getLanAccessHosts().includes(name);
}

/** Whether sign-in cookies need adapting to plain `http`: open, and `Secure` in this build. */
export function lanCookiesNeedAdapting(): boolean {
  return trust?.secureCookies === true;
}

/**
 * Origins a browser on another device sends while Wi-Fi access is open:
 * `http://<host>:<port>` for each of {@link getLanAccessHosts}. Plain `http`,
 * because the listener does not encrypt yet.
 */
export function getLanAccessOrigins(): string[] {
  if (!trust) return [];
  const { port } = trust;
  return getLanAccessHosts().map((host) => `http://${host}:${port}`);
}
