/**
 * What a person typed into a browser's address bar, read the way a browser
 * reads it: an address, a search, or something that does not open here.
 *
 * These rules are for the PERSON's own typing only, and they are UX, not
 * enforcement. The refusals they show are checked again where it counts: the
 * desktop main process on every navigation, and the server on every navigate
 * call. An agent's URL never passes through here, so nothing in this file can
 * widen what an agent may open.
 *
 * @module shared/lib/browser-address
 */

/**
 * Hostnames treated as loopback.
 *
 * `0.0.0.0` is in this set on purpose, and the server's `trusted-origins.ts`
 * deliberately treats it as public — the two are answering different questions.
 * The server is asked "may a request claiming this origin be trusted", where
 * `0.0.0.0` means every interface and so cannot be vouched for. Here the question
 * is "where will this page's browser go if it loads this URL", and a browser
 * pointed at `0.0.0.0` goes to the machine it is running on. Same string,
 * opposite meaning, both correct.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

/**
 * Whether a URL's hostname is a loopback address. A trailing dot (`localhost.`)
 * names the same host, so it is read the same.
 *
 * @param hostname - A URL's hostname, as `URL.hostname` reports it.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = withoutTrailingDot(hostname);
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/** A hostname with its one trailing dot, if any, removed: `a.example.` names `a.example`. */
function withoutTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

/** Default port for a URL that omits one, by protocol. */
function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/** The parts of the page's own `Location` {@link isThisAppsAddress} reads. */
export interface PageAddress {
  /** The page's origin, e.g. `http://localhost:4242`. */
  origin: string;
  /** The page's hostname, e.g. `localhost`. */
  hostname: string;
  /** The page's port as `Location` reports it (`''` for the scheme's default). */
  port: string;
  /** The page's scheme with its colon, e.g. `http:`. */
  protocol: string;
}

/**
 * Whether a URL is this app's own server, so framing it with
 * `allow-same-origin`, or opening it in the Agent browser, would hand the page
 * the app's own powers.
 *
 * Three shapes count. The page's exact origin, which a tunnel or Wi-Fi address
 * reaches as an external target. Any of the server's own other addresses
 * (`ownOrigins`: its tunnel, Wi-Fi and hub origins, from the server's config),
 * which a page open on `localhost` would otherwise read as a stranger's (DOR-4132).
 * And, while the page is on a loopback name, any loopback name on the page's own
 * port: `127.0.0.1:4242` is a different origin string from `localhost:4242` but
 * the same server, and the server trusts both. A trailing dot on the source's
 * host names the same host and is ignored. A source that does not parse is
 * treated as this app's, since a relative URL resolves onto the page's own origin.
 *
 * @param src - The URL in question (absolute, or relative to the page).
 * @param page - The page asking, normally `window.location`.
 * @param ownOrigins - The server's own other origins, as `GET /api/config` reports them.
 */
export function isThisAppsAddress(
  src: string,
  page: PageAddress,
  ownOrigins: readonly string[] = []
): boolean {
  let target: URL;
  try {
    target = new URL(src, page.origin);
  } catch {
    return true;
  }
  target.hostname = withoutTrailingDot(target.hostname);
  if (target.origin === page.origin) return true;
  if (ownOrigins.some((origin) => sameOrigin(origin, target.origin))) return true;
  if (!isLoopbackHost(page.hostname) || !isLoopbackHost(target.hostname)) return false;
  const pagePort = page.port || String(defaultPort(page.protocol));
  const targetPort = target.port || String(defaultPort(target.protocol));
  return pagePort === targetPort;
}

/** Whether a configured origin names `origin`. One that does not parse names nothing. */
function sameOrigin(configured: string, origin: string): boolean {
  try {
    const parsed = new URL(configured);
    parsed.hostname = withoutTrailingDot(parsed.hostname);
    return parsed.origin === origin;
  } catch {
    return false;
  }
}

/** Where a search typed into the address bar goes. */
export const ADDRESS_SEARCH_URL = 'https://duckduckgo.com/';

/** The address field's placeholder, naming the search it falls back to. */
export const ADDRESS_PLACEHOLDER = 'Search DuckDuckGo or type an address';

/** The one line shown under the address bar when what was typed does not open. */
export const ADDRESS_NOTICES = {
  otherScheme: 'Only web pages open here. Try an address starting with https://.',
  file: 'Files don’t open here. Ask the agent to put it on the canvas.',
  ownAddress: 'DorkOS doesn’t open its own pages in the Agent browser.',
  incomplete: 'That address isn’t complete. Check it and try again.',
} as const;

/** What the address bar does with what was typed. */
export type AddressInput =
  /** Empty, or the page already open: reload it. */
  | { kind: 'reload' }
  /**
   * Open this URL. `httpFallback` is set only for a bare host the person typed
   * with no scheme (`example.com`): when the `https://` address cannot connect
   * (refused or timed out, never a certificate error), try this once.
   */
  | { kind: 'open'; url: string; httpFallback?: string }
  /** Search for the text. */
  | { kind: 'search'; url: string }
  /** It does not open here; say why. */
  | { kind: 'refused'; notice: string };

/** Options for {@link normalizeAddressInput}. */
export interface AddressInputOptions {
  /** The address already open, so typing it again reloads. */
  current?: string;
  /** Whether a URL is this DorkOS app's own address, which never opens here. */
  isOwnAddress?: (url: string) => boolean;
}

/** `scheme:` followed by anything but a port, so `localhost:3000` is not a scheme. */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i;
/** A dotted IPv4 address. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** A bracketed IPv6 address. */
const IPV6 = /^\[[0-9a-f:.]+\]$/i;
/** One host label: letters, digits and inner hyphens. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
/** A top-level domain made of letters, or its punycode form. */
const LETTER_TLD = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i;

/**
 * Whether a dotted IPv4 address is on this machine or a private network:
 * 127/8, 10/8, 172.16/12 and 192.168/16. Those are dev servers, routers and
 * printers, which speak plain `http://`.
 */
function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** The host and port before the first `/`, `?` or `#`, split; `null` port when absent. */
function splitAuthority(text: string): { host: string; port: string | null } {
  const authority = text.split(/[/?#]/, 1)[0];
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end === -1) return { host: authority, port: null };
    const rest = authority.slice(end + 1);
    return { host: authority.slice(0, end + 1), port: rest.startsWith(':') ? rest.slice(1) : null };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1) return { host: authority, port: null };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * Read what a person typed into the address bar. The rules, in order:
 *
 * 1. empty, or the address already open → reload;
 * 2. `https://…` or `http://…` → opened as typed;
 * 3. `about:blank` → a new empty page;
 * 4. any other scheme (`file:`, `javascript:`, `data:`, `chrome:`, `mailto:`…) →
 *    refused with a notice, and a local path (`/…`, `./…`, `../…`, `~/…`) is
 *    read as a file;
 * 5. this machine or a private network — `localhost`, `*.localhost`, `127.x`,
 *    `[::1]`, `0.0.0.0`, `10.x`, `172.16–31.x`, `192.168.x` — with or without a
 *    port → `http://` in front;
 * 6. any other bare IPv4 or `[IPv6]` address, with or without a port → `http://`;
 * 7. `word:1234` (a one-label host and a port) → `http://`;
 * 8. anything with a space → a search;
 * 9. no dot, no port, not localhost → a search;
 * 10. a dotted host ending in a letters TLD (`google.com`) → `https://` in front,
 *     with `http://` as the one fallback when it cannot connect;
 * 11. anything else → a search.
 *
 * An address that opens is also refused when it is this app's own, and one
 * that does not parse as a URL gets the "not complete" notice.
 *
 * @param input - Raw address-bar text.
 * @param options - The open address and the own-address check.
 * @returns What to do: reload, open, search, or refuse with a notice.
 */
export function normalizeAddressInput(
  input: string,
  options: AddressInputOptions = {}
): AddressInput {
  const text = input.trim();
  if (text === '' || text === options.current) return { kind: 'reload' };
  const result = readAddress(text);
  if (result.kind !== 'open') return result;
  if (!parses(result.url)) return { kind: 'refused', notice: ADDRESS_NOTICES.incomplete };
  if (result.url === options.current) return { kind: 'reload' };
  if (options.isOwnAddress?.(result.url))
    return { kind: 'refused', notice: ADDRESS_NOTICES.ownAddress };
  return result;
}

/** Rules 2–11 of {@link normalizeAddressInput}, before the own-address and parse checks. */
function readAddress(text: string): AddressInput {
  if (/^https?:\/\//i.test(text)) return { kind: 'open', url: text };
  if (text.toLowerCase() === 'about:blank') return { kind: 'open', url: 'about:blank' };
  if (/^(?:\/|\.{1,2}\/|~\/)/.test(text)) return { kind: 'refused', notice: ADDRESS_NOTICES.file };
  const scheme = SCHEME.exec(text)?.[1].toLowerCase();
  if (scheme !== undefined) {
    return {
      kind: 'refused',
      notice: scheme === 'file' ? ADDRESS_NOTICES.file : ADDRESS_NOTICES.otherScheme,
    };
  }

  const { host, port } = splitAuthority(text);
  const hasPort = port !== null;
  const plainHttp = { kind: 'open', url: `http://${text}` } as const;
  if (!/\s/.test(host)) {
    const ipv4 = IPV4.exec(host);
    const octets = ipv4?.slice(1).map(Number);
    if (isLoopbackHost(host.toLowerCase()) || (octets && isPrivateIpv4(octets))) return plainHttp;
    if (octets || IPV6.test(host)) return plainHttp;
    if (hasPort && LABEL.test(host)) return plainHttp;
  }

  if (/\s/.test(text)) return search(text);
  if (!host.includes('.') && !hasPort) return search(text);
  const labels = host.split('.');
  const tld = labels.at(-1) ?? '';
  if (port === null || /^\d+$/.test(port)) {
    if (labels.every((label) => LABEL.test(label)) && LETTER_TLD.test(tld)) {
      return { kind: 'open', url: `https://${text}`, httpFallback: `http://${text}` };
    }
  }
  return search(text);
}

/** A search for `text` on {@link ADDRESS_SEARCH_URL}. */
function search(text: string): AddressInput {
  const url = new URL(ADDRESS_SEARCH_URL);
  url.searchParams.set('q', text);
  return { kind: 'search', url: url.toString() };
}

/** Whether a URL parses, so it can be opened at all. */
function parses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
