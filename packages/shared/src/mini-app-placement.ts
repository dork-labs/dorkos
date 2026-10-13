/**
 * Where a mini app's right-panel tab shows (spec `mini-app-placement`).
 *
 * A placement is two target lists, `show` and `hide`. Each names agents, rooms
 * and pages, with `'*'` meaning "any". A tab is hidden wherever `hide` matches,
 * and otherwise shows wherever `show` matches. Matching is a union: "these
 * agents, and these rooms" is every real ask, and an AND rule ("agent X, only
 * inside room Y") has no customer.
 *
 * Three layers decide a tab's placement, last one wins: the built-in default
 * (everywhere, which is how every mini-app tab behaved before placement
 * existed), the mini app's own declared default (`showIn` on
 * `registerComponent`), and the saved choice in `ui.panelTabs`.
 *
 * @module shared/mini-app-placement
 */
import { z } from 'zod';

/** The wildcard page key: in `pages`, matches everywhere. */
export const PLACEMENT_ANY = '*';

/**
 * Agents, rooms and pages, each a list of ids. Only `pages` takes a wildcard:
 * `'*'` there means everywhere. "Every chat" and "every channel" are pages too
 * (`session` and `channels`), so agents and rooms only ever hold real ids.
 *
 * Ids that no longer name anything (a deleted room, a removed agent) are kept
 * and simply never match: rewriting a person's saved choice because something
 * it named went away would be a write nobody asked for.
 */
export const PlacementTargetsSchema = z.object({
  /** Agent ids. Matches a chat with that agent. */
  agents: z.array(z.string().min(1)).default(() => []),
  /** Room ids: channels and direct messages on this computer. */
  rooms: z.array(z.string().min(1)).default(() => []),
  /** Page keys from {@link pageKeyForPath}, e.g. `activity` or `x/social-queue`. */
  pages: z.array(z.string().min(1)).default(() => []),
});

/** Agents, rooms and pages a placement names (see {@link PlacementTargetsSchema}). */
export type PlacementTargets = z.infer<typeof PlacementTargetsSchema>;

/** A tab's full placement: where it shows, and where it is hidden even so. */
export const MiniAppPlacementSchema = z.object({
  /** Where the tab shows. */
  show: PlacementTargetsSchema.default(() => ({ agents: [], rooms: [], pages: [] })),
  /** Where the tab is hidden. Wins over `show`. */
  hide: PlacementTargetsSchema.default(() => ({ agents: [], rooms: [], pages: [] })),
});

/** A tab's full placement (see {@link MiniAppPlacementSchema}). */
export type MiniAppPlacement = z.infer<typeof MiniAppPlacementSchema>;

/**
 * One saved choice in `ui.panelTabs`: the tab it is for, and its
 * placement.
 *
 * `tab` is the namespaced right-panel contribution id, `<extensionId>:<tabId>`,
 * the same id the right panel and `setTabMarker` use.
 */
export const SavedPlacementSchema = MiniAppPlacementSchema.extend({
  /** `<extensionId>:<tabId>`. */
  tab: z.string().min(1),
});

/** One saved choice (see {@link SavedPlacementSchema}). */
export type SavedPlacement = z.infer<typeof SavedPlacementSchema>;

/**
 * What a mini app may declare as its tab's default, on `registerComponent`.
 * Every list is optional; an omitted list names nothing.
 */
export interface PlacementInput {
  /** Agent ids. Ids belong to one computer, so a shared mini app leaves these to the person. */
  agents?: readonly string[];
  /** Room ids. Same caveat as `agents`. */
  rooms?: readonly string[];
  /** Page keys (`session` is every chat, `channels` every channel), or `'*'` for everywhere. */
  pages?: readonly string[];
}

/** Empty target lists. A fresh object each call, safe to mutate. */
export function emptyTargets(): PlacementTargets {
  return { agents: [], rooms: [], pages: [] };
}

/** The built-in placement: everywhere. */
export const EVERYWHERE_PLACEMENT: MiniAppPlacement = Object.freeze({
  show: Object.freeze({ agents: [], rooms: [], pages: [PLACEMENT_ANY] }) as PlacementTargets,
  hide: Object.freeze({ agents: [], rooms: [], pages: [] }) as PlacementTargets,
}) as MiniAppPlacement;

/**
 * Turn a mini app's declared `showIn` into a placement, dropping anything that
 * is not a non-empty string. Returns `null` for no declaration.
 *
 * @param input - The declaration, as the mini app passed it (untrusted shape).
 */
export function placementFromInput(input: unknown): MiniAppPlacement | null {
  if (input === null || typeof input !== 'object') return null;
  const pick = (key: keyof PlacementInput): string[] => {
    const value = (input as Record<string, unknown>)[key];
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  };
  return {
    show: { agents: pick('agents'), rooms: pick('rooms'), pages: pick('pages') },
    hide: emptyTargets(),
  };
}

/**
 * Where the person is, as placement sees it.
 *
 * `page` is always set. `roomId` is set on a room on this computer (a channel,
 * a direct message, or Home, which is #team). `agentId` is set in a chat with
 * an agent.
 */
export interface PlacementHere {
  /** The page key (see {@link pageKeyForPath}). */
  page: string;
  /** The room on screen, when it is one on this computer. */
  roomId?: string | null;
  /** The agent of the chat on screen. */
  agentId?: string | null;
}

/**
 * The page key for a pathname: the first segment (`/activity` → `activity`),
 * `home` for `/`, and `x/<extensionId>` for a mini app's pages.
 *
 * @param pathname - The router's pathname.
 */
export function pageKeyForPath(pathname: string): string {
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!first) return 'home';
  if (first === 'x' && second) return `x/${second}`;
  return first;
}

/**
 * Whether target lists name the place the person is.
 *
 * @param targets - The lists to test.
 * @param here - Where the person is.
 */
export function targetsMatch(targets: PlacementTargets, here: PlacementHere): boolean {
  const has = (list: readonly string[], id: string | null | undefined): boolean =>
    id != null && id !== '' && list.includes(id);
  return (
    targets.pages.includes(PLACEMENT_ANY) ||
    has(targets.pages, here.page) ||
    (here.roomId != null && has(targets.rooms, here.roomId)) ||
    (here.agentId != null && has(targets.agents, here.agentId))
  );
}

/**
 * Whether a tab with this placement shows here: hidden if `hide` matches,
 * otherwise shown if `show` matches.
 *
 * @param placement - The tab's effective placement.
 * @param here - Where the person is.
 */
export function placementShows(placement: MiniAppPlacement, here: PlacementHere): boolean {
  if (targetsMatch(placement.hide, here)) return false;
  return targetsMatch(placement.show, here);
}

/**
 * The saved choice for one tab. The LAST entry wins when a list somehow holds
 * two for the same tab (an agent appended instead of replacing), and every
 * reader goes through this so the panel, Settings and the menu agree.
 *
 * @param saved - The saved choices.
 * @param tab - The tab, `<extensionId>:<tabId>`.
 */
export function savedPlacementFor(
  saved: readonly SavedPlacement[],
  tab: string
): SavedPlacement | null {
  for (let i = saved.length - 1; i >= 0; i--) {
    const entry = saved[i];
    if (entry?.tab === tab) return entry;
  }
  return null;
}

/**
 * The placement in force for one tab: the saved choice, else the mini app's
 * declared default, else everywhere.
 *
 * @param saved - The saved choice for this tab, if any.
 * @param declared - The mini app's declared default, if any.
 */
export function effectivePlacement(
  saved: MiniAppPlacement | null | undefined,
  declared: MiniAppPlacement | null | undefined
): MiniAppPlacement {
  return saved ?? declared ?? EVERYWHERE_PLACEMENT;
}

/**
 * The single most specific target for where the person is: the room in a room,
 * the agent in a chat, the page elsewhere. This is what "Show here" and "Hide
 * here" add. Null where nothing narrower than a whole kind of page exists.
 *
 * @param here - Where the person is.
 */
export function mostSpecificTarget(
  here: PlacementHere
): { kind: keyof PlacementTargets; id: string } | null {
  if (here.roomId) return { kind: 'rooms', id: here.roomId };
  if (here.agentId) return { kind: 'agents', id: here.agentId };
  // A chat with no registered agent, or a room from a connected community, has
  // nothing narrower than its page — and that page is every chat, or every
  // channel. "Hide here" there would hide far more than here, so it is not
  // offered at all.
  if (here.page === 'session' || here.page === 'channels' || here.page === 'home') return null;
  return { kind: 'pages', id: here.page };
}

/** Drop every entry that names here, the everywhere wildcard included. */
function withoutAnyMatch(targets: PlacementTargets, here: PlacementHere): PlacementTargets {
  return {
    pages: targets.pages.filter((id) => id !== PLACEMENT_ANY && id !== here.page),
    rooms: targets.rooms.filter((id) => id !== here.roomId),
    agents: targets.agents.filter((id) => id !== here.agentId),
  };
}

/** Drop only the most specific target for here, so nothing broader changes. */
function withoutTarget(
  targets: PlacementTargets,
  target: { kind: keyof PlacementTargets; id: string }
): PlacementTargets {
  return { ...targets, [target.kind]: targets[target.kind].filter((entry) => entry !== target.id) };
}

function withTarget(
  targets: PlacementTargets,
  target: { kind: keyof PlacementTargets; id: string }
): PlacementTargets {
  const list = targets[target.kind];
  return list.includes(target.id) ? targets : { ...targets, [target.kind]: [...list, target.id] };
}

/**
 * The placement after "Show here" (unchanged where {@link mostSpecificTarget}
 * is null): every `hide` entry that names here goes
 * (showing in more places is the safe direction), and the most specific target
 * for here joins `show` unless `show` already matches.
 *
 * @param placement - The placement in force.
 * @param here - Where the person is.
 */
export function showHere(placement: MiniAppPlacement, here: PlacementHere): MiniAppPlacement {
  const target = mostSpecificTarget(here);
  if (!target) return placement;
  const hide = withoutAnyMatch(placement.hide, here);
  const show = targetsMatch(placement.show, here)
    ? placement.show
    : withTarget(placement.show, target);
  return { show, hide };
}

/**
 * The placement after "Hide here" (unchanged where {@link mostSpecificTarget}
 * is null): the most specific target for here leaves
 * `show`, and if the tab would still show (a wider entry covers here, such as
 * every chat), that target joins `hide`. Nothing wider is removed, so hiding a
 * tab in one channel never hides it in the others.
 *
 * @param placement - The placement in force.
 * @param here - Where the person is.
 */
export function hideHere(placement: MiniAppPlacement, here: PlacementHere): MiniAppPlacement {
  const target = mostSpecificTarget(here);
  if (!target) return placement;
  const show = withoutTarget(placement.show, target);
  const hide = targetsMatch(show, here) ? withTarget(placement.hide, target) : placement.hide;
  return { show, hide };
}
