/**
 * The Cloud origin that agent browsers never reach (DOR-3196).
 *
 * The operator's browser sign-ins are saved once and every agent's browser
 * starts from them, so a Cloud sign-in saved there would let any agent's
 * browser act as the operator on their Cloud account. Two browsers are
 * guarded with the one list built here:
 *
 * - the agent browser (Playwright MCP, `@dorkos/shared/agent-browser`): its
 *   saved session is stripped of Cloud cookies and page storage on save and on
 *   every load, and it is started with the Cloud origin blocked;
 * - the local browser an agent drives (`local_browser_act` and friends): an
 *   agent may not navigate to, act on or read a page on the Cloud origin.
 *
 * The list is {@link CLOUD_ORIGIN}, the DorkOS website ({@link CLOUD_WEBSITE},
 * whose signed-in pages use the same account and can link a computer to it),
 * and the Cloud addresses the operator configured for this computer, and
 * nothing else: no agent, page or request ever adds to it. A host on the list covers its subdomains, on any port.
 * `localhost` and IP addresses are the exception: a local Cloud for
 * development is matched by its exact origin, so a dev Cloud on one port never
 * blocks every other local server.
 *
 * @module shared/cloud-origin
 */
import { links } from './links.js';

/** The production Cloud origin. Always on the list, whatever is configured. */
export const CLOUD_ORIGIN = links.cloudApi;

/**
 * The DorkOS website. Always on the list too: a DorkOS account signed in there
 * can approve things for that account, so it is a Cloud credential like any other.
 */
export const CLOUD_WEBSITE = links.site;

/**
 * What an agent is told when a browser refuses the Cloud origin. It names the
 * refusal and the way forward, and it is the exact text QA matches on.
 */
export const CLOUD_ORIGIN_REFUSAL =
  'Agent browsers can’t open DorkOS Cloud or dorkos.ai. Ask the person to open it.';

/** One entry on the list: a host (with its subdomains) or one exact local origin. */
export type CloudOriginEntry =
  { kind: 'host'; host: string } | { kind: 'origin'; protocol: string; host: string; port: string };

/** The operator's Cloud configuration, as the server and the CLI both read it from the environment. */
export interface CloudOriginConfig {
  /** Where the website and the device link live. */
  DORKOS_CLOUD_URL?: string;
  /** Where the Cloud service lives, when it is not {@link CLOUD_ORIGIN}. */
  DORKOS_CLOUD_API_URL?: string;
}

const LOCAL_HOST = /^(localhost|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$/i;

/** A hostname in the one form every comparison here uses: lower case, no trailing dot. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '');
}

function entryFor(url: string): CloudOriginEntry | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = normalizeHost(parsed.hostname);
  if (!host) return null;
  if (LOCAL_HOST.test(host))
    return { kind: 'origin', protocol: parsed.protocol, host, port: parsed.port };
  return { kind: 'host', host };
}

/**
 * The Cloud origin list: {@link CLOUD_ORIGIN} and {@link CLOUD_WEBSITE}, plus
 * the configured `DORKOS_CLOUD_API_URL` and `DORKOS_CLOUD_URL`.
 *
 * @param config - The operator's Cloud configuration; omit for the production list only.
 */
export function cloudOriginEntries(config: CloudOriginConfig = {}): CloudOriginEntry[] {
  const urls: string[] = [CLOUD_ORIGIN, CLOUD_WEBSITE];
  if (config.DORKOS_CLOUD_API_URL) urls.push(config.DORKOS_CLOUD_API_URL);
  if (config.DORKOS_CLOUD_URL) urls.push(config.DORKOS_CLOUD_URL);
  const entries: CloudOriginEntry[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const entry = entryFor(url);
    if (!entry) continue;
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function hostIsUnder(host: string, parent: string): boolean {
  return host === parent || host.endsWith(`.${parent}`);
}

/**
 * Whether a URL is on the Cloud origin (a listed host or any of its
 * subdomains, any port; a listed local origin exactly), including a `blob:`
 * URL one of them made. Anything else that is not an `http`/`https` URL is not.
 *
 * @param url - The address to test, exactly as the browser reports it.
 * @param entries - The list, from {@link cloudOriginEntries}.
 */
export function isCloudOriginUrl(
  url: string,
  entries: readonly CloudOriginEntry[] = cloudOriginEntries()
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
    // A `blob:` URL belongs to the origin that made it.
    if (parsed.protocol === 'blob:') parsed = new URL(parsed.pathname);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = normalizeHost(parsed.hostname);
  return entries.some((entry) =>
    entry.kind === 'host'
      ? hostIsUnder(host, entry.host)
      : entry.protocol === parsed.protocol && entry.host === host && entry.port === parsed.port
  );
}

/**
 * Whether a browser would send a cookie with this `domain` to the Cloud
 * origin. A host-only cookie (`cloud.example`) and a domain cookie
 * (`.example`, sent to every subdomain) both count, so a cookie set for a
 * parent domain is treated as a Cloud cookie too.
 *
 * @param domain - The cookie's `domain`, as a storage-state file holds it.
 * @param entries - The list, from {@link cloudOriginEntries}.
 */
export function cookieReachesCloud(
  domain: string,
  entries: readonly CloudOriginEntry[] = cloudOriginEntries()
): boolean {
  const isDomainCookie = domain.startsWith('.');
  const cookieHost = normalizeHost(domain.replace(/^\.+/, ''));
  if (!cookieHost) return false;
  return entries.some((entry) => {
    if (entry.kind === 'origin') return cookieHost === entry.host;
    // Sent to the Cloud host or one of its subdomains...
    if (hostIsUnder(cookieHost, entry.host)) return true;
    // ...or set on a parent domain, which the browser also sends to Cloud.
    return isDomainCookie && hostIsUnder(entry.host, cookieHost);
  });
}

/** The parts of a storage-state file this module reads: cookies by domain, page storage by origin. */
interface StorageStateLike {
  cookies: Array<{ domain: string }>;
  origins: Array<{ origin: string }>;
}

/**
 * A copy of a saved browser session with every Cloud cookie and every Cloud
 * origin's page storage removed, and how many of each it removed.
 *
 * @param state - A Playwright storage state.
 * @param entries - The list, from {@link cloudOriginEntries}.
 */
export function withoutCloudOrigin<S extends StorageStateLike>(
  state: S,
  entries: readonly CloudOriginEntry[] = cloudOriginEntries()
): { state: S; removedCookies: number; removedOrigins: number } {
  const cookies = state.cookies.filter((cookie) => !cookieReachesCloud(cookie.domain, entries));
  const origins = state.origins.filter((origin) => !isCloudOriginUrl(origin.origin, entries));
  return {
    state: { ...state, cookies, origins },
    removedCookies: state.cookies.length - cookies.length,
    removedOrigins: state.origins.length - origins.length,
  };
}

/**
 * The list as Playwright MCP's `--blocked-origins` value: semicolon-separated
 * entries, each of which it turns into a context-wide route that aborts every
 * matching request (pages, iframes and popups alike). A route never sees the
 * later hops of a redirect, which is what {@link chromeHostResolverRules} is
 * for. A host is listed bare and with `*.` for its subdomains, each also in
 * its fully qualified form with a trailing dot (`cloud.example.`, which
 * Chrome treats as a different host and a route glob would otherwise miss),
 * and each again with a wildcard port, because a bare host only matches the
 * default port.
 *
 * @param entries - The list, from {@link cloudOriginEntries}.
 */
export function playwrightBlockedOrigins(
  entries: readonly CloudOriginEntry[] = cloudOriginEntries()
): string {
  const values: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'origin') {
      const port = entry.port ? `:${entry.port}` : '';
      values.push(`${entry.protocol}//${entry.host}${port}`);
      continue;
    }
    for (const host of [entry.host, `*.${entry.host}`, `${entry.host}.`, `*.${entry.host}.`]) {
      values.push(host, `http://${host}:*`, `https://${host}:*`);
    }
  }
  return values.join(';');
}

/**
 * The list as Chrome's `--host-resolver-rules` value: every listed host and its
 * subdomains resolve to nothing, in both the plain and the trailing-dot form,
 * so no request reaches them by any path, the hops of a redirect included. A local origin is left out on purpose: a rule
 * for `localhost` would take every local server down with it, and the route
 * block still covers it.
 *
 * @param entries - The list, from {@link cloudOriginEntries}.
 */
export function chromeHostResolverRules(
  entries: readonly CloudOriginEntry[] = cloudOriginEntries()
): string {
  return entries
    .filter((entry): entry is Extract<CloudOriginEntry, { kind: 'host' }> => entry.kind === 'host')
    .flatMap((entry) =>
      [entry.host, `*.${entry.host}`, `${entry.host}.`, `*.${entry.host}.`].map(
        (host) => `MAP ${host} ~NOTFOUND`
      )
    )
    .join(', ');
}
