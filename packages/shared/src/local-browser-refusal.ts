/**
 * Pages where a site refuses the Agent browser itself (DOR-4097, DOR-4650).
 *
 * Google answers a sign-in from an embedded browser with an ordinary 200 page,
 * and bot checks look like any other page, so the browser's own error codes never
 * see them. This reads only what a page already showed: its address, its title
 * and, where the caller has it, its text. It never loads anything.
 */

/** Which kind of refusal: a sign-in the site won't take here, or a bot check or block. */
export type LocalBrowserRefusalKind = 'sign-in' | 'blocked';

/** A refusal, named by kind and the page's own host. */
export interface LocalBrowserRefusal {
  kind: LocalBrowserRefusalKind;
  /** The host from the page's address, never from its text. */
  host: string;
}

/**
 * What the agent's page reading says on a refusal (DOR-4662). Handing the site to the
 * person is the way on, the same instruction `local_browser_ask_person` gives; it never
 * suggests a retry, another browser identity or a way past the check.
 *
 * @param kind - A sign-in refusal hands over as `password`, a block as `wall`.
 */
export function localBrowserRefusalNext(kind: LocalBrowserRefusalKind): string {
  const reason = kind === 'sign-in' ? 'password' : 'wall';
  return `This site refused the Agent browser. Stop, and hand the site to the person with local_browser_ask_person (reason: ${reason}): that is the way on. Don’t retry, change the browser or try to get yourself past the check.`;
}

/**
 * What the reading says instead when this turn can't hand the site over (DOR-4693): a stranger
 * started the chat or the turn, or the turn holds outside words. The handoff would refuse, so it
 * never points there; the person opens the plain sign-in window from the browser's own notice.
 */
export const LOCAL_BROWSER_REFUSAL_HELD_NEXT =
  'This site refused the Agent browser, and this turn can’t hand it to a person. Stop, and tell the person the site refused the browser, with the tool that notifies them, never an outside sender’s thread. They can sign in from the notice in the Agent browser. Don’t retry, change the browser or try to get yourself past the check.';

/** What one page showed. `text` is optional: the desktop shell has only the title. */
export interface LocalBrowserRefusalPage {
  url: string;
  title?: string;
  text?: string;
  /**
   * Whether the page names Akamai's reference host, from the desktop shell's own
   * true-or-false check when it has no page text. Text, when given, is read too.
   */
  akamaiReference?: boolean;
}

const GOOGLE_SIGN_IN_HOST = 'accounts.google.com';
const GOOGLE_REJECTED_PATH = /^\/(?:v\d+\/)?signin\/rejected(?:\/|$)/;
const GOOGLE_REFUSAL_WORDS = [/couldn[’']t sign you in/i, /browser or app may not be secure/i];

/**
 * Block signals: only a vendor's own block page carries them, so each is enough alone.
 * Cloudflare's two challenge titles and its challenge path, and DataDome's host.
 */
const VENDOR_BLOCK_TITLES = [/^just a moment\.{3}$/i, /^attention required! \| cloudflare$/i];
const BLOCK_PATHS = [/^\/cdn-cgi\/challenge-platform\//];
const BLOCK_HOSTS = [/(^|\.)captcha-delivery\.com$/i];

/**
 * A generic block title, and the words that make it a vendor's (DOR-4662). Neither counts
 * alone: a plain site 403 is titled "Access denied" too, and help pages say "press and
 * hold". Status adds nothing here, since a plain 403 and an Akamai block share it.
 */
const AKAMAI_TITLE = /^access denied$/i;
const AKAMAI_REFERENCE = /errors\.edgesuite\.net/i;
const PERIMETERX_TITLE = /^access to this page has been denied\.?$/i;
const PERIMETERX_WORDS = /press (?:&|and) hold|\bpx-captcha\b/i;

/**
 * Whether this page is a site refusing the Agent browser.
 *
 * @param page - The page's address, and its title and text where the caller has them.
 * @returns The refusal, or null for an ordinary page or an address that isn't a web page.
 */
export function classifyRefusal(page: LocalBrowserRefusalPage): LocalBrowserRefusal | null {
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.host;
  const title = page.title?.trim() ?? '';
  const text = page.text ?? '';
  if (url.hostname === GOOGLE_SIGN_IN_HOST) {
    if (GOOGLE_REJECTED_PATH.test(url.pathname)) return { kind: 'sign-in', host };
    if (GOOGLE_REFUSAL_WORDS.some((words) => words.test(title) || words.test(text)))
      return { kind: 'sign-in', host };
    return null;
  }
  const vendorBlock =
    VENDOR_BLOCK_TITLES.some((words) => words.test(title)) ||
    BLOCK_PATHS.some((path) => path.test(url.pathname)) ||
    BLOCK_HOSTS.some((name) => name.test(url.hostname));
  const akamai =
    AKAMAI_TITLE.test(title) && (page.akamaiReference === true || AKAMAI_REFERENCE.test(text));
  const perimeterX = PERIMETERX_TITLE.test(title) && PERIMETERX_WORDS.test(text);
  return vendorBlock || akamai || perimeterX ? { kind: 'blocked', host } : null;
}
