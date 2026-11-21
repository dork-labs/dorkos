/**
 * One extension's permission set as a line of a dev-link card, and that line
 * read back (DOR-2686): where it runs, every host, program and agent grant,
 * and the places it shows in (DOR-4282). Split from `dev-link-service.ts`.
 *
 * @module services/marketplace/dev-links/permission-card-line
 */
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import {
  CONTRIBUTION_WORDS,
  EXTENSION_CONTRIBUTION_KEYS,
  type ExtensionContributionKey,
} from '@dorkos/extension-api';

/** How a card line says an extension's server half runs inside DorkOS. */
const IN_PROCESS_LINE = 'runs inside DorkOS with full access to this computer';

/** How a card line says an extension has only screens. */
const SCREENS_ONLY_LINE = 'only screens';

/** How a card line says an extension runs separately. */
const SEPARATE_LINE = 'runs separately';

/** How a card line starts the places an extension shows in. */
const PLACES_PART = 'shows in ';

/** Each place's key by its words, so a card line reads back into keys. */
const KEY_BY_WORDS: ReadonlyMap<string, ExtensionContributionKey> = new Map(
  EXTENSION_CONTRIBUTION_KEYS.map((key) => [CONTRIBUTION_WORDS[key], key])
);

/**
 * The places part of a card line: DorkOS's words for each known place, in
 * card order, or `''` when it shows in none. Unknown keys are left out.
 */
function placesPart(slots: readonly string[] | undefined): string {
  const words = EXTENSION_CONTRIBUTION_KEYS.filter((key) => (slots ?? []).includes(key)).map(
    (key) => CONTRIBUTION_WORDS[key]
  );
  return words.length > 0 ? `${PLACES_PART}${words.join(', ')}` : '';
}

/**
 * The places part read back into keys, or `null` when a word is not one
 * {@link placesPart} writes.
 */
function parsePlaces(text: string): ExtensionContributionKey[] | null {
  const keys: ExtensionContributionKey[] = [];
  for (const words of text.split(', ')) {
    const key = KEY_BY_WORDS.get(words);
    if (!key) return null;
    keys.push(key);
  }
  return keys;
}

/**
 * One extension's permission set as a card line: where it runs, then every
 * host, program and agent grant, never a count.
 *
 * @param set - What it declares.
 * @param hasServer - Whether it has a server half; without one it is screens only.
 */
export function describePermissionSet(set: ApprovedPermissionSet, hasServer: boolean): string {
  // The places it shows in (DOR-4282), in DorkOS's words, which read back to keys.
  const places = placesPart(set.slots);
  if (set.runtime === 'in-process') {
    return [hasServer ? IN_PROCESS_LINE : SCREENS_ONLY_LINE, ...(places ? [places] : [])].join(
      '; '
    );
  }
  const parts = [
    SEPARATE_LINE,
    set.net.length > 0 ? `connects to ${set.net.join(', ')}` : 'no internet',
    ...(set.run.length > 0 ? [`runs ${set.run.join(', ')}`] : []),
    ...(set.agents ? ['messages your agents'] : []),
    ...(places ? [places] : []),
  ];
  return parts.join('; ');
}

/**
 * Read a card line back into the set it describes, or `null` when it is not
 * one {@link describePermissionSet} writes. Only ever trusted after the whole
 * card text is rebuilt from what it returns and matches exactly.
 *
 * @param line - The text after `<id>: `.
 */
export function parsePermissionSet(text: string): ApprovedPermissionSet | null {
  const placesAt = text.lastIndexOf(`; ${PLACES_PART}`);
  const line = placesAt < 0 ? text : text.slice(0, placesAt);
  const slots = placesAt < 0 ? [] : parsePlaces(text.slice(placesAt + 2 + PLACES_PART.length));
  if (slots === null) return null;
  if (line === IN_PROCESS_LINE || line === SCREENS_ONLY_LINE) {
    return { runtime: 'in-process', net: [], run: [], agents: false, slots };
  }
  if (!line.startsWith(`${SEPARATE_LINE}; `)) return null;
  const set: ApprovedPermissionSet = {
    runtime: 'subprocess',
    net: [],
    run: [],
    agents: false,
    slots,
  };
  for (const part of line.slice(SEPARATE_LINE.length + 2).split('; ')) {
    if (part === 'no internet') continue;
    if (part === 'messages your agents') set.agents = true;
    else if (part.startsWith('connects to ')) set.net = part.slice(12).split(', ');
    else if (part.startsWith('runs ')) set.run = part.slice(5).split(', ');
    else return null;
  }
  return set;
}

/**
 * The narrowest permission set: a separate process that reaches no host, runs
 * no program, messages no agent and shows in no place. A fresh object each call.
 */
export function narrowestPermissionSet(): ApprovedPermissionSet {
  return { runtime: 'subprocess', net: [], run: [], agents: false, slots: [] };
}
