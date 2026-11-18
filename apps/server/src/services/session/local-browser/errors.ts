import {
  CLOUD_ORIGIN_REFUSAL,
  cloudOriginEntries,
  isCloudOriginUrl,
  type CloudOriginEntry,
} from '@dorkos/shared/cloud-origin';
import { isLocalBrowserAppUrl, localBrowserAppOrigins, underlyingPageUrl } from './app-origins.js';

/** Machine-readable refusal plus short app copy. Raw Playwright errors never reach the UI. */
export class LocalBrowserError extends Error {
  /**
   * A refusal with a code an agent can act on.
   *
   * @param code - The refusal an agent can act on.
   * @param message - DorkOS's own words; never text from a page, a chat or a person.
   * @param fields - Untrusted text (a chat's title) kept beside the sentence, never in it.
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly fields?: Readonly<Record<string, string | null>>
  ) {
    super(message);
  }
}

/**
 * What an agent's browser call is told while agent control is paused (DOR-4678). Written for the
 * agent, which cannot resume it. The causes are examples, not a list: a person's Pause, a
 * handoff, a person's Back or Forward while it drives (DOR-4449), and a page it may not read
 * (`refuseProtectedPage`) all pause it. A closed or disconnected browser is never told this:
 * {@link assertAgentMayAct} answers {@link browserClosedRefusal} first.
 */
export function agentPausedRefusal(): LocalBrowserError {
  return new LocalBrowserError(
    'paused',
    'Agent control of this browser is paused, and only a person can resume it. It pauses, for ' +
      "example, on a person's Pause, a handoff, their Back or Forward while you drive, or a page " +
      'you may not read. Nothing you send runs until then: tell them, end your turn, and read ' +
      'the page again once it resumes.'
  );
}

/** What a person is told while their agent is paused: theirs to resume. */
export function personPausedRefusal(): LocalBrowserError {
  return new LocalBrowserError('paused', 'Your agent is paused. Resume it to continue.');
}

/** A browser that closed or was disconnected, for agent and person alike. */
export function browserClosedRefusal(): LocalBrowserError {
  return new LocalBrowserError('closed', 'The browser closed. Connect it again.');
}

/**
 * Refuse an agent's call on a browser it may not use now: closed or disconnected first, so that
 * case never reads as a pause a person could lift, then paused.
 *
 * @param status - The browser's connection status.
 * @param paused - Whether agent control is paused.
 */
export function assertAgentMayAct(status: string, paused: boolean): void {
  if (status !== 'connected') throw browserClosedRefusal();
  if (paused) throw agentPausedRefusal();
}

/** The refusal an agent gets for a page on the Cloud origin (DOR-3196). */
export function cloudOriginRefusal(): LocalBrowserError {
  return new LocalBrowserError('cloud_origin', CLOUD_ORIGIN_REFUSAL);
}

/** Agents use DorkOS tools rather than driving the app's person-only controls. */
export function appOriginRefusal(): LocalBrowserError {
  return new LocalBrowserError('dorkos_origin', 'Use DorkOS tools to work in the app.');
}

/**
 * The refusal an agent gets for a tab or frame it may not read: Cloud, this
 * app, or a local file, under any address that wraps them. Null when allowed.
 *
 * @param urls - The tab's address and its frames' addresses.
 * @param cloudOrigins - The Cloud origin list.
 * @param appOrigins - The live addresses of this DorkOS app.
 */
export function protectedPageRefusal(
  urls: readonly string[],
  cloudOrigins: readonly CloudOriginEntry[],
  appOrigins: readonly string[]
): LocalBrowserError | null {
  const pages = urls.map(underlyingPageUrl);
  if (pages.some((url) => isCloudOriginUrl(url, cloudOrigins))) return cloudOriginRefusal();
  if (pages.some((url) => isLocalBrowserAppUrl(url, appOrigins))) return appOriginRefusal();
  if (pages.some((url) => /^file:/i.test(url)))
    return new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  return null;
}

/**
 * Keep browser navigation on websites rather than browser settings or local
 * files. Agents also stay off this app and Cloud; the person may go there.
 * The person may also open `about:blank`, exactly that and nothing else under
 * `about:`, which is the address bar's "new empty page" (DOR-4419).
 *
 * @param value - The address to open.
 * @param who - Who asked: an agent unless the person's own control said so.
 * @param cloudOrigins - The Cloud origin list.
 * @param appOrigins - The live addresses of this DorkOS app.
 */
export function assertLocalBrowserUrl(
  value: string,
  who: 'agent' | 'person' = 'agent',
  cloudOrigins: readonly CloudOriginEntry[] = cloudOriginEntries(),
  appOrigins: readonly string[] = localBrowserAppOrigins()
): void {
  if (who === 'person' && value === 'about:blank') return;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with http or https.'
    );
  if (who === 'agent' && isCloudOriginUrl(value, cloudOrigins)) throw cloudOriginRefusal();
  if (who === 'agent' && isLocalBrowserAppUrl(value, appOrigins)) throw appOriginRefusal();
}

/**
 * Whether a person's Back or Forward may load this address (DOR-4449): exactly
 * `about:blank`, the first page of every tab, or a website that is not this
 * DorkOS app. The same rules the address bar keeps for typed addresses, on
 * every load a step makes, its redirects included.
 *
 * @param value - The address a step would load or landed on.
 * @param appOrigins - The live addresses of this DorkOS app.
 */
export function historyAddressAllowed(
  value: string,
  appOrigins: readonly string[] = localBrowserAppOrigins()
): boolean {
  if (value === 'about:blank') return true;
  try {
    if (!['http:', 'https:'].includes(new URL(value).protocol)) return false;
  } catch {
    return false;
  }
  return !isLocalBrowserAppUrl(value, appOrigins);
}

/**
 * Chromium's own error code, which Playwright puts first:
 * `page.goto: net::ERR_X at <address>`. The rest of the message quotes the
 * address a person typed, so a code anywhere else may be their text and is
 * never read (Security, #3859). No code in that place reads as none.
 */
function chromiumCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : '';
  return /^(?:page\.goto: )?net::(ERR_[A-Z_]+)\b/.exec(message)?.[1] ?? null;
}

/** Playwright's own timeout, or Chromium's words for a page that did not answer in time. */
function timedOut(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const code = chromiumCode(error);
  return code === 'ERR_CONNECTION_TIMED_OUT' || code === 'ERR_TIMED_OUT';
}

/** Chromium's words for a page that never connected: refused, or no route to it. */
const REFUSED = new Set(['ERR_CONNECTION_REFUSED', 'ERR_ADDRESS_UNREACHABLE']);

/** A server that answered https in plain http, what `nas.lan:5000` gives. */
const PLAIN_HTTP_ANSWER = 'ERR_SSL_PROTOCOL_ERROR';

/**
 * Whether a person's failed https navigation may try `http://` once (DOR-4450,
 * Security's ruling of Nov 16). A refused or unreachable page may. A plain-http
 * answer may only on a port the person named other than 443: `URL` drops `:443`,
 * so a bare name and `:443` never do. A timeout, a certificate error or anything
 * else never does.
 *
 * @param error - What Playwright's `goto` threw.
 * @param value - The https address that failed.
 */
export function httpFallbackAllowed(error: unknown, value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'https:') return false;
  if (timedOut(error)) return false;
  const code = chromiumCode(error);
  if (code !== null && REFUSED.has(code)) return true;
  return code === PLAIN_HTTP_ANSWER && url.port !== '';
}

/**
 * Why a person's navigation failed, as a refusal. A timeout is
 * `navigation_timed_out`; a refused, unreachable, or wrong-protocol page is
 * `navigation_unreachable`. Anything else, a certificate error included,
 * stays `navigation_uncertain`: the page may have half-loaded, and a
 * certificate error must never be stepped around.
 *
 * @param error - What Playwright's `goto` threw.
 */
export function navigationRefusal(error: unknown): LocalBrowserError {
  if (timedOut(error))
    return new LocalBrowserError(
      'navigation_timed_out',
      'That site didn’t respond. Try again in a moment.'
    );
  const code = chromiumCode(error);
  if (code !== null && (REFUSED.has(code) || code === PLAIN_HTTP_ANSWER))
    return new LocalBrowserError('navigation_unreachable', 'Couldn’t reach that site.');
  return new LocalBrowserError(
    'navigation_uncertain',
    'Couldn’t finish opening the page. Check the browser.'
  );
}

/** One recovery message for setup cancelled before the browser is ready. */
export function browserSetupCancelled(): LocalBrowserError {
  return new LocalBrowserError('cancelled', 'Browser setup stopped. Open it again to continue.');
}
