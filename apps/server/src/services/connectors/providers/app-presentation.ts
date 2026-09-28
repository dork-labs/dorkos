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

/** A first sentence shorter than this is too thin to stand alone; the next one joins it. */
const SENTENCE_MIN_LENGTH = 20;

/** Words whose full stop never ends a sentence ("Acme Inc. makes…", "tools, e.g. Slack"). */
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'inc.',
  'ltd.',
  'co.',
  'corp.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'st.',
  'no.',
  'jr.',
  'sr.',
]);

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
  // https with the default port only. That leaves a Nango server reached over
  // plain http, or on its own port (a self-hosted one, often), with no logos:
  // on purpose, since the rule is one simple check that never fetches over an
  // unencrypted link or from an arbitrary port on a host. Those apps keep their
  // letter tile. An app whose id is not a safe file name and path segment
  // (`CONNECTOR_LOGO_SERVICE_ID`) also gets none, because its logo could not be
  // kept or named by a same-origin path.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
  if (!hosts.includes(url.hostname.toLowerCase())) return undefined;
  const href = url.toString();
  return href.length <= 2_000 ? href : undefined;
}

/**
 * The first sentence of already-flattened text. A sentence ends at `.`, `!` or
 * `?` followed by the end or by a space and a capital, so "Node.js" or "v2.1"
 * never ends one; an abbreviation never ends one; and a stop before
 * {@link SENTENCE_MIN_LENGTH} characters is skipped, so "Hi." is never a line.
 */
function firstSentence(flat: string): string {
  for (const match of flat.matchAll(/[.!?](?=$|\s+[A-Z])/g)) {
    const end = match.index + 1;
    const lastWord = flat.slice(0, end).split(' ').at(-1)?.toLowerCase() ?? '';
    if (end < SENTENCE_MIN_LENGTH || ABBREVIATIONS.has(lastWord)) continue;
    return flat.slice(0, end);
  }
  return flat;
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
  const sentence = firstSentence(flat);
  if (sentence.length <= DESCRIPTION_MAX_LENGTH) return sentence;
  const cut = sentence.slice(0, DESCRIPTION_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, '')}…`;
}
