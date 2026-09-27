/**
 * How a connection service's app list becomes something a person reads: a
 * logo address the server may fetch, and one short line about the app.
 *
 * The provider clients call these while mapping a service's raw app list, so
 * everything past them (the catalog, the logo route) only ever sees a logo URL
 * that is https and on that service's own logo host, and a description that is
 * already one short sentence (connection-app-details design §2, §3).
 *
 * @module services/connectors/providers/app-presentation
 */

/** The longest description the catalog carries; a longer sentence is cut at a word. */
const DESCRIPTION_MAX_LENGTH = 200;

/**
 * The logo URL a service sent, if DorkOS may fetch it: https, on one of the
 * service's own logo hosts, with no credentials in it. Anything else is
 * dropped, so the app keeps its letter tile rather than DorkOS fetching from a
 * host the service does not own.
 *
 * @param raw - The logo field from the service's app list.
 * @param hosts - The hosts that service serves its logos from, lower-case.
 */
export function trustedLogoUrl(
  raw: string | null | undefined,
  hosts: readonly string[]
): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (!hosts.includes(url.hostname.toLowerCase())) return undefined;
  const href = url.toString();
  return href.length <= 2_000 ? href : undefined;
}

/**
 * A service's description of an app, cut to one short plain line: whitespace
 * collapsed, the first sentence only, and at most {@link DESCRIPTION_MAX_LENGTH}
 * characters (cut at a word, with an ellipsis). Empty text gives `undefined`.
 *
 * @param text - The description as the service sent it.
 */
export function oneSentence(text: string | null | undefined): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  // A sentence ends at . ! or ? followed by the end or by a space and a capital,
  // so "Node.js" or "v2.1" never ends one early.
  const sentence = /^.*?[.!?](?=$|\s+[A-Z])/.exec(flat)?.[0] ?? flat;
  if (sentence.length <= DESCRIPTION_MAX_LENGTH) return sentence;
  const cut = sentence.slice(0, DESCRIPTION_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
