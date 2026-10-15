/**
 * The pages a mini-app tab can be placed on, with the names Settings shows
 * (spec `mini-app-placement`). Keys are `pageKeyForPath` keys; a test checks
 * each one is a real route, so this list and the router cannot drift apart.
 *
 * @module features/extensions/lib/placement-pages
 */
import { placementFromInput } from '@dorkos/shared/mini-app-placement';

/** One page a tab can show on. */
export interface PlacementPage {
  /** The page key, as `pageKeyForPath` computes it. */
  key: string;
  /** What Settings calls it. */
  label: string;
}

/** Every page offered in Settings, in the order offered. */
export const PLACEMENT_PAGES: readonly PlacementPage[] = [
  { key: 'session', label: 'Every chat' },
  { key: 'channels', label: 'Every channel' },
  { key: 'home', label: 'Home' },
  { key: 'activity', label: 'Activity' },
  { key: 'tasks', label: 'Scheduled' },
  { key: 'workspaces', label: 'Workspaces' },
  { key: 'team', label: 'Team' },
  { key: 'connections', label: 'Connections' },
  { key: 'marketplace', label: 'Marketplace' },
];

/**
 * What Settings calls a page key: its label, "Everywhere" for the wildcard, a
 * named add-on page for `x/<id>`, or the key itself for one an agent wrote.
 *
 * @param key - A page key.
 */
export function placementPageLabel(key: string): string {
  if (key === '*') return 'Everywhere';
  if (key.startsWith('x/')) return `Add-on page ${key.slice(2)}`;
  return PLACEMENT_PAGES.find((page) => page.key === key)?.label ?? key;
}

/** The page keys `showIn` may name, besides `x/<id>` and `'*'`. */
const KNOWN_PAGE_KEYS = new Set(PLACEMENT_PAGES.map((page) => page.key));

/**
 * Say so in the console when a tab's `showIn` would hide it everywhere by
 * mistake: a declaration that names nothing usable (a typo'd key, a string
 * where a list goes), or a page key no page has. Either one silently puts the
 * tab nowhere, which is the hardest kind of mistake for an author to spot.
 *
 * @param extId - The extension.
 * @param tabId - The tab's slot-local id.
 * @param showIn - The declaration, as passed.
 */
export function warnOnUnusableShowIn(extId: string, tabId: string, showIn: unknown): void {
  const placement = placementFromInput(showIn);
  const named = placement
    ? placement.show.agents.length + placement.show.rooms.length + placement.show.pages.length
    : 0;
  if (named === 0) {
    console.warn(
      `[extensions] ${extId}: showIn for right-panel tab '${tabId}' names no agent, room or page, so the tab shows nowhere. Omit showIn to show it everywhere.`
    );
    return;
  }
  const unknown = placement!.show.pages.filter(
    (key) => key !== '*' && !key.startsWith('x/') && !KNOWN_PAGE_KEYS.has(key)
  );
  if (unknown.length > 0) {
    console.warn(
      `[extensions] ${extId}: showIn for right-panel tab '${tabId}' names unknown page ${unknown.map((k) => `'${k}'`).join(', ')}; known pages: ${[...KNOWN_PAGE_KEYS].join(', ')}, x/<extension-id>, '*'.`
    );
  }
}
