/**
 * The pure parts of reading and posting a Community channel's messages, kept
 * apart from Playwright so the unit tests can hold them.
 *
 * @module community-two-desktop/entries
 */

/** One page of a channel's history as an app's local server returns it, oldest first. */
export interface EntryPage<T> {
  entries: T[];
  /** `null` once there is nothing newer; the only sign the history is exhausted. */
  nextCursor: string | null;
}

/** The most pages {@link readAllEntries} reads before deciding the cursor never ends. */
export const MAX_ENTRY_PAGES = 200;

/**
 * Read a channel's whole top-level history, oldest first.
 *
 * A page without a cursor is the OLDEST page, not the newest. A held live
 * community keeps every earlier run's messages, so after a couple of runs this
 * run's messages are no longer on the first page, and a single
 * `?limit=100` read misses them. Following the cursor to its end is what makes
 * a re-run inside the same hold see what it just posted.
 *
 * @param readPage - Reads one page; `undefined` asks for the first (oldest) one.
 * @throws When the cursor repeats or the history runs past {@link MAX_ENTRY_PAGES} pages.
 */
export async function readAllEntries<T>(
  readPage: (cursor: string | undefined) => Promise<EntryPage<T>>
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_ENTRY_PAGES; pages++) {
    const page = await readPage(cursor);
    all.push(...page.entries);
    if (page.nextCursor === null) return all;
    if (seen.has(page.nextCursor))
      throw new Error(`channel history repeated a cursor after ${pages + 1} pages`);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`channel history still had more after ${MAX_ENTRY_PAGES} pages`);
}

/** The local server's route an app posts a Community message through. */
const ENTRY_POST_PATH = /^\/api\/communities\/[^/]+\/rooms\/[^/]+\/entries$/;

/**
 * Whether a request is the app posting this exact message to a Community
 * channel or thread, so a send can be confirmed by its own request rather than
 * by reading the feed.
 *
 * @param method - The request's HTTP method.
 * @param url - The request's full URL.
 * @param body - The request's body, if any.
 * @param text - The message that was sent.
 */
export function isEntryPostFor(
  method: string,
  url: string,
  body: string | null,
  text: string
): boolean {
  if (method !== 'POST' || !ENTRY_POST_PATH.test(new URL(url).pathname) || !body) return false;
  try {
    const sent = (JSON.parse(body) as { text?: unknown }).text;
    return typeof sent === 'string' && sent.trim() === text.trim();
  } catch {
    return false;
  }
}
