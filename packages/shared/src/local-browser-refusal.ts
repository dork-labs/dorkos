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
 * What the agent's page reading says on a refusal. It never suggests a retry, another
 * browser identity or a way past the check: the site said no to this browser.
 */
export const LOCAL_BROWSER_REFUSAL_NEXT =
  'This site refused the Agent browser. Stop, and hand it to the person with local_browser_ask_person (reason: password). Don’t retry, change the browser or try to get past the check.';

/** What one page showed. `text` is optional: the desktop shell has only the title. */
export interface LocalBrowserRefusalPage {
  url: string;
  title?: string;
  text?: string;
}

const GOOGLE_SIGN_IN_HOST = 'accounts.google.com';
const GOOGLE_REJECTED_PATH = /^\/(?:v\d+\/)?signin\/rejected(?:\/|$)/;
const GOOGLE_REFUSAL_WORDS = [/couldn[’']t sign you in/i, /browser or app may not be secure/i];

/** Titles and words bot checks and edge blocks show. Each one alone is enough. */
const BLOCK_TITLES = [
  /^just a moment\.{3}$/i,
  /^attention required! \| cloudflare$/i,
  /^access denied$/i,
  /^access to this page has been denied\.?$/i,
];
const BLOCK_PATHS = [/^\/cdn-cgi\/challenge-platform\//];
const BLOCK_HOSTS = [/(^|\.)captcha-delivery\.com$/i];
const BLOCK_WORDS = [
  /errors\.edgesuite\.net/i,
  /press (?:&|and) hold/i,
  /\bpx-captcha\b/i,
  /verify you are human/i,
];

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
  if (
    BLOCK_TITLES.some((words) => words.test(title)) ||
    BLOCK_PATHS.some((path) => path.test(url.pathname)) ||
    BLOCK_HOSTS.some((name) => name.test(url.hostname)) ||
    BLOCK_WORDS.some((words) => words.test(text))
  )
    return { kind: 'blocked', host };
  return null;
}
