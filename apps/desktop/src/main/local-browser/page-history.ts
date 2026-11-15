import { createHash } from 'node:crypto';
import type { WebContents } from 'electron';
import { isWebLink } from '../window-manager';

/**
 * The Agent browser's own address rules in the main process (DOR-4419,
 * DOR-4449), for the Mac app's native page. The server checks too, but only
 * this process sees a redirect before it loads, so it refuses here first: a
 * page may only go to a website that is not this DorkOS app.
 */

/** A host name without IPv6 brackets, in lower case. */
function bare(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Names one machine's loopback interface, whatever it is called. */
function isLoopbackHost(host: string): boolean {
  const name = bare(host);
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    name === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(name) ||
    // `[::ffff:127.0.0.1]`, which URL parsing writes as `[::ffff:7f00:1]`.
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(name)
  );
}

/** Marks a server list entry that matches its host on any scheme and any port. */
const ANY_PORT = 'dorkos-any-port:';

/** The address rules' inputs: the app's own origin, and the server's list of its addresses. */
export interface AddressRules {
  rendererUrl?: string;
  /** Every address the DorkOS server answers to (`localBrowserAppOrigins`), when it has said. */
  refused?: readonly string[];
}

/** The port an address really uses, its scheme's default included. */
function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * Whether an address is this DorkOS app: the server the app's windows load
 * (and the dev server, in development), under any loopback name on its port,
 * or any address on the server's own list (its network names, tunnel and
 * trusted hosts), which only the server knows in full.
 *
 * @param url - The address to check.
 * @param rules - The app's own origin and the server's list.
 */
export function isAppAddress(url: string, rules: AddressRules = {}): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const listed = (rules.refused ?? []).some((entry) => {
    let known: URL;
    try {
      known = new URL(entry);
    } catch {
      return false;
    }
    if (bare(known.hostname) !== bare(target.hostname)) return false;
    if (known.protocol === ANY_PORT) return true;
    return known.protocol === target.protocol && portOf(known) === portOf(target);
  });
  if (listed) return true;
  const own = [process.env.ELECTRON_RENDERER_URL, rules.rendererUrl].filter(Boolean) as string[];
  return own.some((origin) => {
    let app: URL;
    try {
      app = new URL(origin);
    } catch {
      return false;
    }
    if (portOf(app) !== portOf(target)) return false;
    if (app.hostname === target.hostname) return true;
    return isLoopbackHost(app.hostname) && isLoopbackHost(target.hostname);
  });
}

/**
 * Whether the native page may load this address on a navigation or a
 * redirect: http or https, and not this app.
 *
 * @param url - Where the page is going.
 * @param rules - The app's own origin and the server's list.
 */
export function guestNavigationAllowed(url: string, rules: AddressRules = {}): boolean {
  return isWebLink(url) && !isAppAddress(url, rules);
}

/**
 * Whether a history step may land on this entry: the same rule as a
 * navigation, plus `about:blank`, every tab's first page.
 *
 * @param url - The entry's address.
 * @param rules - The app's own origin and the server's list.
 */
export function historyEntryAllowed(url: string, rules: AddressRules = {}): boolean {
  return url === 'about:blank' || guestNavigationAllowed(url, rules);
}

/** What a guest page's navigation events carry, as far as the guard reads them. */
interface NavigationEvent {
  url: string;
  preventDefault(): void;
}

/** The part of a guest's `WebContents` the guard listens on. */
type GuardedContents = Pick<WebContents, 'on'>;

/**
 * Refuse a guest page's own navigations and every server redirect it meets
 * (a history step's included) to anywhere {@link guestNavigationAllowed}
 * refuses. `will-navigate` alone misses redirects and history steps.
 *
 * @param contents - The guest page.
 * @param rules - Live accessor for the app's own origin and the server's list.
 * @param onRefused - Told each time a load is refused, so a step can say so.
 */
export function guardGuestNavigation(
  contents: GuardedContents,
  rules: () => AddressRules,
  onRefused: () => void = () => undefined
): void {
  const guard = (event: NavigationEvent) => {
    if (guestNavigationAllowed(event.url, rules())) return;
    event.preventDefault();
    onRefused();
  };
  contents.on('will-navigate', guard as never);
  contents.on('will-redirect', guard as never);
}

/** A guest's history, by address only. */
export interface GuestHistory {
  index: number;
  entries: { url: string }[];
}

/** The part of a guest's `WebContents` history reads and steps use. */
export type HistoryContents = Pick<
  WebContents,
  'navigationHistory' | 'once' | 'removeListener' | 'stop'
>;

/**
 * Read a guest's history.
 *
 * @param contents - The guest page.
 */
export function readGuestHistory(contents: HistoryContents): GuestHistory {
  const history = contents.navigationHistory;
  const entries = history.getAllEntries().map(({ url }) => ({ url }));
  return { index: history.getActiveIndex(), entries };
}

/** How long a step may take before the host answers that it settled anyway. */
const STEP_TIMEOUT_MS = 15_000;

/** The events that end a step: it moved, or it stopped without moving. */
const SETTLED = ['did-navigate', 'did-navigate-in-page', 'did-fail-load', 'did-stop-loading'];

/**
 * Move a guest to one history entry, after checking it is still the entry the
 * server asked for and that this process's own rule allows it. Settles once
 * the page moved or stopped; `refused` says whether the guard refused a load
 * on the way ({@link guardGuestNavigation}).
 *
 * @param contents - The guest page.
 * @param index - The entry to move to.
 * @param urlHash - The SHA-256 of the address the server saw at that entry.
 * @param rules - The app's own origin and the server's list.
 * @param refusedSince - Counts the guard's refusals, read before and after the step.
 */
export async function stepGuestHistory(
  contents: HistoryContents,
  index: number,
  urlHash: string,
  rules: AddressRules,
  refusedSince: () => number
): Promise<'moved' | 'refused' | 'changed'> {
  const history = contents.navigationHistory;
  const entry = Number.isInteger(index) ? history.getEntryAtIndex(index) : undefined;
  if (!entry || createHash('sha256').update(entry.url).digest('hex') !== urlHash) return 'changed';
  if (!historyEntryAllowed(entry.url, rules)) return 'refused';
  const before = refusedSince();
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      for (const name of SETTLED) contents.removeListener(name as never, done);
      resolve();
    };
    // A step that outlasts its time is stopped, so it can't land after the answer.
    const timer = setTimeout(() => {
      contents.stop();
      done();
    }, STEP_TIMEOUT_MS);
    for (const name of SETTLED) contents.once(name as never, done);
    history.goToIndex(index);
  });
  return refusedSince() > before ? 'refused' : 'moved';
}
