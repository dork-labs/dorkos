/**
 * The whole sidebar, as one pure function of one snapshot.
 *
 * **The sidebar lists places, never sessions or threads.** People think about
 * work in terms of who and where, so every row here is a place a conversation
 * lives — a channel, a direct message, a page — or a door to a page that holds
 * the rest: Threads for every thread you are in, and the Directory for every
 * agent and person. A session is reached from its agent's profile and ⌘K; a
 * thread from the Threads page.
 *
 * Every section, row, order and badge is decided here, and every node this
 * emits carries a `reason` saying why it is there. Components render the result
 * and hold no rules — so "why is this row here?" is answerable in devtools, and
 * every rule is a table test instead of a mounted tree.
 *
 * **Three standing rules, and a PR that breaks one is a blocker.**
 *
 * 1. **No verb text, ever.** `SessionActivity` churns every couple of seconds
 *    per working session. A verb in the model rebuilds the whole tree on every
 *    tool call; a verb in the leaf row re-renders one row. Rows carry
 *    `reservesVerbLine` and the row component subscribes to the text itself.
 * 2. **No timestamps and no countdowns.** "3m ago" is the same churn wearing a
 *    different hat.
 * 3. **No clock of its own.** `state.now` is the only reading of time here.
 *
 * **Placement is deliberate.** This lives in the feature that renders it, not
 * a slice of its own: `.claude/rules/fsd-layers.md` forbids model imports
 * between sibling features, so a `features/sidebar-model` slice would be
 * unimportable by the only thing that draws it. Widgets may import features, so
 * the phone's tabs reach it legally.
 *
 * @module features/dashboard-sidebar/model/build-sidebar-model
 */
import type {
  SidebarDisplayFilter,
  SidebarSectionId as PersistedSectionId,
} from '@dorkos/shared/config-schema';
import type { UnreadSignal } from '@/layers/shared/lib/unread-signal';
import { buildSections } from './rules/build-sections';
import type { SidebarState } from './sidebar-state';

/**
 * The fixed sections whose fold is remembered, in the order they render after
 * the operator's own.
 *
 * The tuple IS the order — {@link buildSections} emits them exactly like this.
 * It is deliberately NOT the persisted section vocabulary, which is a longer
 * list living in `packages/shared` (`SidebarSectionIdSchema`): that package
 * cannot import the client, and the stored set still carries ids for sections
 * an older release drew, whose folds are simply never read again.
 *
 * The `satisfies` keeps the two honest: every entry here must still be a
 * persisted section, so retiring an id from the schema turns a render-order
 * entry naming it into a compile error rather than a fold nothing can store.
 */
export const SIDEBAR_SECTION_IDS = [
  'channels',
  'dms',
  // No `addons`: the pages mini apps add moved to the Apps door in the top
  // items (DOR-3970). The id stays in the persisted vocabulary so a stored fold
  // still parses; nothing reads it.
] as const satisfies readonly PersistedSectionId[];

/** One fixed section's id — the two above, and only those. */
export type FixedSectionId = (typeof SIDEBAR_SECTION_IDS)[number];

/**
 * Narrow a section id to one that has a place to store its collapse state.
 *
 * The top items and a hand-made section answer `null`: the top items never
 * fold, and a hand-made section's fold already lives on the section itself.
 *
 * @param id - Any section id the model emits.
 */
export function persistedSectionId(id: SidebarSectionId): PersistedSectionId | null {
  return SIDEBAR_SECTION_IDS.find((entry) => entry === id) ?? null;
}

/**
 * A section's id.
 *
 * `top` is the headerless block of doors at the head of the list — Threads,
 * To-dos (while switched on) and Directory. A hand-made section is `group:<groupId>`, which cannot collide
 * with the fixed ids and needs no schema of its own because its collapse state
 * lives on the group.
 */
export type SidebarSectionId = 'top' | FixedSectionId | `group:${string}`;

/**
 * What a command row does when pressed — a page the list stands at the door of.
 *
 * Each is a meaning rather than an address: the page's route is the router's
 * business, so a row carries what it is for and `SidebarChrome` works out where
 * that is.
 *
 * - `open-threads` — the Threads page, every thread you are in.
 * - `open-todos` — the To-dos page, while to-dos are switched on.
 * - `open-directory` — the Directory, every agent and person.
 * - `message-someone` — the Directory again, from the foot of the list, for
 *   starting a conversation with anyone not on it yet.
 * - `message-agent` — the Directory narrowed to agents, the empty Direct
 *   messages section's one row.
 * - `open-apps` — the Apps page, every app (DOR-3970).
 */
export type SidebarCommandId =
  | 'open-threads'
  | 'open-todos'
  | 'open-directory'
  | 'message-someone'
  | 'message-agent'
  | 'open-apps';

/**
 * The semantic icons a command row draws.
 *
 * Semantic ids rather than component names: the model must not import React,
 * and a row that said `MessagesSquare` would have decided a rendering rather
 * than a meaning.
 */
export type SidebarIconId = 'threads' | 'todos' | 'directory' | 'add' | 'apps';

/** What clicking a row does — and, for `session`, what the router says is open. */
export type SidebarTarget =
  /**
   * A chat. **No row in the panel carries this** — the sidebar lists places,
   * never sessions — but the router reports an open chat this way, and an
   * agent's row lights while one of its chats is open (`isRowActive`). The
   * agent row's own chat list also opens one through it.
   */
  | { kind: 'session'; sessionId: string; agentPath: string; cwd: string | null }
  | { kind: 'room'; roomId: string; roomKind: 'channel' | 'dm' }
  | { kind: 'agent'; path: string }
  | { kind: 'command'; commandId: SidebarCommandId }
  /**
   * A page a mini app added (`api.registerPage`), by the extension that owns it
   * and the path it registered (`''` for its home).
   *
   * What the row MEANS, never its address: `/x/<extensionId>/<path>` is the
   * router's business. Never dragged, pinned or muted — the page is the
   * extension's, not a thing the operator filed.
   */
  | { kind: 'add-on'; extensionId: string; path: string };

/**
 * How much of the operator's attention a row's unread state is asking for. The
 * room's tab reads the same rule, so the shape lives with it in `shared/lib`.
 */
export type SidebarUnread = UnreadSignal;

/** One row, whatever it points at. */
export interface SidebarRowModel {
  /** Stable React key and test handle: `${target.kind}:${id}`. */
  key: string;
  /** What clicking it does. */
  target: SidebarTarget;
  /**
   * Fixed 18px leading slot. The glyph carries the type; row chrome never does.
   *
   * **A room's row says `hash` whatever kind of room it is**, and that is not a
   * claim about what gets drawn: `RoomRow` owns a room's leading slot and builds
   * it from the roster (a `#` for a channel, faces for a direct message).
   */
  glyph:
    | { kind: 'agent-avatar'; agentPath: string }
    | { kind: 'hash' }
    | { kind: 'icon'; icon: SidebarIconId }
    /**
     * The icon a mini app registered for its page, by the page's contribution
     * id (`<extensionId>:<path>`). The renderer looks it up, and draws a puzzle
     * piece when there is none — the model holds no component.
     */
    | { kind: 'page-icon'; pageId: string };
  /** The "who": agent name, room name, person name, page title. */
  primary: string;
  /** True when the row reserves a second line for a live verb. */
  reservesVerbLine: boolean;
  /** The row's unread state. */
  unread: SidebarUnread;
  /**
   * A neutral count a door shows: the To-dos door's open to-dos due today or overdue. Never
   * unread and never orange, because nobody wrote to you; absent at zero.
   */
  count?: number;
  /**
   * "N live" chip on an agent row with concurrent sessions.
   *
   * Present only at or above `LIVE_CHIP_MIN`, so its presence IS the chip's
   * condition and the row has no threshold of its own to disagree with.
   */
  liveCount?: number;
  /** Whether the operator muted this target. */
  muted: boolean;
  /** Whether the row is a drag source. False for every door and every page. */
  draggable: boolean;
  /**
   * Set on a pinned app's row under the Apps door (DOR-3970): what the app is
   * doing, which decides its trailing mark and what pressing it does.
   */
  app?: SidebarRowApp;
  /**
   * The door's dot: a held app waits somewhere the pinned rows do not show
   * (spec §2). Only the Apps door carries it.
   */
  heldDot?: true;
  /** Provenance. Answers "why is this row here?" in devtools, always. */
  reason: string;
}

/** A pinned app, as its row reads it. */
export interface SidebarRowApp {
  /** The extension id. */
  id: string;
  /**
   * `ok` opens it; `held` opens its approval card (never approves); `error`
   * retries. An `off` app is never pinned in the panel.
   */
  state: 'ok' | 'held' | 'error';
  /** The name with its state in words, for screen readers. */
  accessibleName: string;
}

/**
 * What stands under the Apps door instead of its pins while they cannot be
 * shown: the list is still on its first read (skeleton bars, as many as the
 * stored pins), or it failed (one quiet "Couldn't load apps · Try again" row).
 */
export type SidebarAppsNotice = { kind: 'loading'; rows: number } | { kind: 'failed' };

/** What a folded section still shows of what it is hiding. */
export interface SidebarRollup {
  /**
   * The rows a folded section keeps on screen, in section order: every row
   * with unread.
   *
   * **This is why a header never needs an unread count.** Folding hides the
   * quiet rows and leaves the ones asking for something where they were.
   */
  keptRows: SidebarRowModel[];
  /**
   * How many rows the fold hides: the section's rows minus {@link keptRows}.
   *
   * The header says "· 12 more" from this, so a folded section never reads as
   * an open one that lost its rows. Zero means every row stayed on screen, and
   * the header then says nothing.
   */
  hiddenCount: number;
  /**
   * How many of its members are streaming right now. The header draws one dot
   * when this is above zero, never the number.
   */
  workingCount: number;
}

/** One section: a header (or none) and its rows. */
export interface SidebarSectionModel {
  /** Which section this is. */
  id: SidebarSectionId;
  /** `null` = headerless body — the top items, and nothing else. */
  label: string | null;
  /** Whether it can fold at all. */
  collapsible: boolean;
  /** Whether it is folded right now. */
  collapsed: boolean;
  /** Signal that survives folding. */
  rollup?: SidebarRollup;
  /** The sort and filter this section is currently under. */
  options?: { sortMode?: 'manual' | 'name' | 'recent'; displayFilter?: SidebarDisplayFilter };
  /** The rows it holds. */
  rows: SidebarRowModel[];
  /**
   * The top items only: what stands under the Apps door in place of its pins
   * ({@link SidebarAppsNotice}). A failed load never reads as "no apps".
   */
  appsNotice?: SidebarAppsNotice;
  /** Provenance. */
  reason: string;
}

/**
 * The whole panel: one list of sections, top to bottom.
 *
 * The top items first, then the operator's own sections, Channels, Direct
 * messages. A section with nothing in it is absent rather than an
 * empty box — except Direct messages, which always stands, because its empty
 * state is the way to start one.
 */
export interface SidebarModel {
  /** The sections, in render order. */
  sections: SidebarSectionModel[];
}

/**
 * Build the entire sidebar from a snapshot of application state. Pure.
 *
 * @param state - Everything the sidebar is a function of.
 */
export function buildSidebarModel(state: SidebarState): SidebarModel {
  return { sections: buildSections(state) };
}
