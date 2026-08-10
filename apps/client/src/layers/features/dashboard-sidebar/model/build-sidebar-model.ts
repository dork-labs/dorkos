/**
 * The whole sidebar, as one pure function of one snapshot (spec
 * `sidebar-now-today-library` §A1).
 *
 * Every zone, section, row, order, cap, rollup and badge is decided here, and
 * every node this emits carries a `reason` saying why it is there. Components
 * render the result and hold no rules — so "why is this row here?" is
 * answerable in devtools, and every rule is a table test instead of a mounted
 * tree.
 *
 * **Three standing rules, and a PR that breaks one is a blocker.**
 *
 * 1. **No verb text, ever.** `SessionActivity` churns every couple of seconds
 *    per working session. A verb in the model rebuilds the whole tree on every
 *    tool call; a verb in the leaf row re-renders one row. Rows carry
 *    `reservesVerbLine` (from lifecycle) and the row component subscribes to
 *    the text itself.
 * 2. **No timestamps and no countdowns.** "3m ago" is the same churn wearing a
 *    different hat. Rows carry the instants they are ordered by and nothing
 *    that has to be re-rendered as the clock moves.
 * 3. **No clock of its own.** `state.now` is the only reading of time in this
 *    module and every rule beside it. `Date.now()` here is what makes the
 *    overnight boundary untestable.
 *
 * **Placement is deliberate.** This lives in the feature that renders it, not
 * a slice of its own: `.claude/rules/fsd-layers.md` forbids model imports
 * between sibling features, so a `features/sidebar-model` slice would be
 * unimportable by the only thing that draws it. Widgets may import features, so
 * P4's mobile tabs reach it legally.
 *
 * @module features/dashboard-sidebar/model/build-sidebar-model
 */
import type {
  SidebarDisplayFilter,
  SidebarSectionId as PersistedSectionId,
} from '@dorkos/shared/config-schema';
import type { IdentityStatus } from '@/layers/shared/ui';
import { applyMuteRules, muteIndex } from './rules/apply-mute-rules';
import { archiveOvernight } from './rules/archive-overnight';
import { buildDigestRow } from './rules/build-digest-row';
import { buildGettingStarted } from './rules/build-getting-started';
import { buildLibrarySections } from './rules/build-library-sections';
import { buildWorkingRollup } from './rules/build-working-rollup';
import { capNowItems } from './rules/cap-now-items';
import { orderToday } from './rules/order-today';
import { pinActiveAnchor } from './rules/pin-active-anchor';
import { rankNowItems } from './rules/rank-now-items';
import { selectNowItems } from './rules/select-now-items';
import { selectTodayItems } from './rules/select-today-items';
import { anchorKey } from './rules/targets';
import type { SidebarState } from './sidebar-state';

/**
 * The four zones, and the only ids one can have.
 *
 * `getting-started` is not a fifth zone: it is Now's day-one life stage and
 * shares Now's slot, which is why they are never both present (BC-4).
 */
export type SidebarZoneId = 'getting-started' | 'now' | 'today' | 'library';

/**
 * Library's sections, in the order they render.
 *
 * The tuple IS the order — {@link buildLibrarySections} emits them exactly like
 * this, so changing Library's shape is an edit here rather than a hunt through
 * a function.
 *
 * It is deliberately NOT the persisted section vocabulary, which is a longer
 * list living in `packages/shared` (`SidebarSectionIdSchema`): that package
 * cannot import the client, and the stored set carries ids this render order has
 * no use for — `threads` and `recents` still hold collapse flags in existing
 * config while their pre-redesign sections render, and P2 removes them.
 *
 * The `satisfies` is what keeps the two honest without collapsing them into one
 * list: every entry here must still be a persisted section, so retiring an id
 * from the schema turns a render-order entry naming it into a compile error
 * rather than a section whose fold nothing can store.
 */
export const SIDEBAR_LIBRARY_SECTION_IDS = [
  'pins',
  'channels',
  'dms',
  'agents',
] as const satisfies readonly PersistedSectionId[];

/** One Library section's id — the four above, and only those. */
export type LibrarySectionId = (typeof SIDEBAR_LIBRARY_SECTION_IDS)[number];

/**
 * A section's id.
 *
 * The persisted Library sections are a closed set; a group sub-header is
 * `group:<groupId>`, which cannot collide with them and needs no schema of its
 * own because a group's own collapse state already lives on the group.
 * `now`, `today` and `getting-started` name the headerless bodies of their
 * zones.
 */
export type SidebarSectionId =
  | LibrarySectionId
  | 'now'
  | 'today'
  | 'getting-started'
  | `group:${string}`;

/** What kind of blockage put an item in Now. The only four that may (BC-5). */
export type NowKind = 'permission-prompt' | 'question' | 'error' | 'idle-timeout';

/**
 * A Getting-started suggestion's id.
 *
 * The `suggestion:` prefix is part of the value because the same string is the
 * row's `reason` and the token written into `prefs.gettingStarted.retired[]` —
 * one spelling, so a retired suggestion can never be un-retired by a rename.
 */
export type SuggestionId =
  | 'suggestion:agents-found'
  | 'suggestion:add-agent'
  | 'suggestion:first-session'
  | 'suggestion:say-hi-team'
  | 'suggestion:ask-dorkbot';

/** The create actions the New menu offers (BC-45), as click targets. */
export type SidebarCommandId =
  | 'new-session'
  | 'new-channel'
  | 'new-dm'
  | 'new-agent'
  | 'new-group'
  | 'ask-dorkbot';

/**
 * The semantic icons a row's glyph slot can draw.
 *
 * Semantic ids rather than component names: the model must not import React,
 * and a row that said `Bot` would have decided a rendering rather than a
 * meaning.
 */
export type SidebarIconId =
  | 'permission'
  | 'question'
  | 'error'
  | 'idle'
  | 'overflow'
  | 'working'
  | 'automated'
  | 'digest'
  | 'discovery'
  | 'add-agent'
  | 'first-session'
  | 'team'
  | 'dorkbot'
  /** A session that belongs to no agent — no `cwd`, so no face to draw (DOR-203). */
  | 'session';

/**
 * The trailing mark that says where a conversation came from (BC-26).
 *
 * Absent means the ordinary case — a human talking to an agent — which is why
 * there is no `'chat'` member: the commonest thing draws nothing.
 *
 * **Named `Sidebar…`, not `SessionOrigin…`.** `entities/session` already
 * exports a React component called `SessionOriginMark`, and a P2 row component
 * needs both it and this type in one file — where two identical names cannot
 * both be bound.
 *
 * **Integration note.** P1.2 lands the `ORIGIN_GLYPH` registry in
 * `shared/ui/identity-glyphs.ts`, and `shared/` may not import a feature. When
 * the two meet, this union moves down beside that registry and this becomes a
 * re-export, so the glyph table and the model cannot disagree about what marks
 * exist.
 */
export type SidebarOriginMark = 'timer' | 'bridged' | 'room' | 'agent' | 'thread';

/** The menu actions a row can offer, dual-rendered into kebab and context menu. */
export type SidebarActionId =
  | 'open'
  | 'new-session'
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'mark-read'
  | 'move'
  | 'rename'
  | 'dismiss'
  | 'archive';

/** What clicking a row does. The only discriminated union in the model. */
export type SidebarTarget =
  | { kind: 'session'; sessionId: string; agentPath: string; cwd: string | null }
  | { kind: 'room'; roomId: string; roomKind: 'channel' | 'dm' | 'thread' }
  | { kind: 'agent'; path: string }
  | { kind: 'attention'; signalId: string; deepLink: string }
  | { kind: 'rollup'; rollup: 'now-overflow' | 'working' | 'automated' | 'section-count' }
  | { kind: 'suggestion'; suggestionId: SuggestionId }
  | { kind: 'digest' }
  | { kind: 'command'; commandId: SidebarCommandId };

/** How much of the operator's attention a row's unread state is asking for. */
export interface SidebarUnread {
  /**
   * `'activity'` = bold label and nothing else; `'directed'` = a numbered amber
   * badge; `'none'` = nothing. Two tiers and no more (design-decisions §18).
   *
   * **`'activity'` draws no dot.** §18 reads "Bold label only. No badge, no
   * dot." The spec's table restated it with a dot while claiming to quote §18
   * verbatim, and this comment followed the spec. The decision record wins: a
   * dot would be a third weight in a system that deliberately has two, and the
   * avatar corner already owns dots for agent lifecycle.
   */
  tier: 'none' | 'activity' | 'directed';
  /** How many. Carried by `'directed'` only — the only tier that renders a mark. */
  count?: number;
}

/** One row, whatever it points at. */
export interface SidebarRowModel {
  /** Stable React key and test handle: `${target.kind}:${id}`. */
  key: string;
  /** What clicking it does. */
  target: SidebarTarget;
  /** Fixed 18px leading slot. The glyph carries the type; row chrome never does. */
  glyph:
    | { kind: 'agent-avatar'; agentPath: string }
    | { kind: 'person-avatar'; memberId: string }
    | { kind: 'face-stack'; memberIds: string[] }
    | { kind: 'hash' }
    | { kind: 'icon'; icon: SidebarIconId };
  /** The "who": agent name, room name, person name. Never a title. */
  primary: string;
  /** The "what", rendered after `›`. Present iff this row is a session. */
  secondary?: string;
  /** Avatar corner dot. Derived from lifecycle, never from a verb. */
  status: IdentityStatus;
  /** True when the row reserves a second line for a live verb (BC-24). */
  reservesVerbLine: boolean;
  /** One-line preview when there is one worth showing and no verb line. */
  preview?: string;
  /** Trailing origin mark; absent = human↔agent chat. */
  origin?: SidebarOriginMark;
  /** The row's unread state (design-decisions §18, BC-40). */
  unread: SidebarUnread;
  /** "N live" chip on an agent row with concurrent sessions. */
  liveCount?: number;
  /** Repo/project chip. Present only under BC-38. */
  projectLabel?: string;
  /** Now-only. Drives priority and the dismiss affordance. */
  attention?: { kind: NowKind; since: string; dismissible: boolean };
  /** Whether the operator muted this target (BC-40). */
  muted: boolean;
  /** False for every row outside Library (R3). */
  draggable: boolean;
  /** Menu node ids, dual-rendered into context menu and kebab. */
  actions: SidebarActionId[];
  /** Provenance. Answers "why is this row here?" in devtools, always. */
  reason: string;
}

/** One section: a header (or none) and its rows. */
export interface SidebarSectionModel {
  /** Which section this is. */
  id: SidebarSectionId;
  /** `null` = headerless body (Now and Today each have exactly one). */
  label: string | null;
  /** Whether it can fold at all. Only Library sections can (BC-2). */
  collapsible: boolean;
  /** Whether it is folded right now. */
  collapsed: boolean;
  /** Signal that survives folding (BC-31). */
  rollup?: { unread: SidebarUnread; workingCount: number };
  /** The sort and filter this section is currently under. */
  options?: { sortMode?: 'manual' | 'name' | 'recent'; displayFilter?: SidebarDisplayFilter };
  /** The rows it holds. */
  rows: SidebarRowModel[];
  /** One indent level, max — a subsection never has subsections of its own. */
  subsections?: SidebarSectionModel[];
  /** Provenance. */
  reason: string;
}

/** One zone: a landmark heading and the sections under it. Never collapses. */
export interface SidebarZoneModel {
  /** Which zone this is. */
  id: SidebarZoneId;
  /** The heading a person reads. */
  label: string;
  /** Its sections, in render order. */
  sections: SidebarSectionModel[];
  /** Visually-hidden text for the zone's polite live region. Now only (BC-11). */
  liveRegionText?: string;
  /** Provenance. */
  reason: string;
}

/** A zone with nothing to say is absent from `zones` — never an empty box (BC-1). */
export interface SidebarModel {
  /** The zones, in the fixed order `getting-started|now`, `today`, `library`. */
  zones: SidebarZoneModel[];
}

/** The words each zone's heading uses. */
const ZONE_LABEL: Record<SidebarZoneId, string> = {
  'getting-started': 'Getting started',
  now: 'Now',
  today: 'Today',
  library: 'Library',
};

/**
 * What Now's live region says — the COUNT of things needing you, and nothing
 * else (BC-11).
 *
 * A verb change or an unread change must never reach a screen reader from here;
 * a fleet of thirty agents would turn one into a siren.
 *
 * @param count - How many things need the operator.
 */
function liveRegionText(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? '1 agent needs you' : `${count} agents need you`;
}

/**
 * A zone holding one headerless body, or `undefined` when the body is empty.
 *
 * The `undefined` is BC-1 in one place: a caller cannot accidentally push an
 * empty box into `zones`, because there is nothing to push.
 *
 * @param id - Which zone.
 * @param rows - Its rows.
 * @param reason - The zone's provenance.
 */
function bodyZone(
  id: Exclude<SidebarZoneId, 'library'>,
  rows: SidebarRowModel[],
  reason: string
): SidebarZoneModel | undefined {
  if (rows.length === 0) return undefined;
  return {
    id,
    label: ZONE_LABEL[id],
    sections: [
      {
        id,
        label: null,
        collapsible: false,
        collapsed: false,
        rows,
        reason: `${id}:body`,
      },
    ],
    reason,
  };
}

/**
 * Build the entire sidebar from a snapshot of application state. Pure.
 *
 * The composition is the whole function: each named rule decides one thing, and
 * this reads as the order those decisions happen in. A rule that needs to know
 * what another rule decided takes it as an argument rather than reaching for it.
 *
 * @param state - Everything the sidebar is a function of.
 */
export function buildSidebarModel(state: SidebarState): SidebarModel {
  const zones: SidebarZoneModel[] = [];

  // Now and Getting started share one slot: real signals always win, and the
  // day-one zone is what fills the space until there are any (BC-4).
  const attentionRows = rankNowItems(selectNowItems(state));
  const workingRollup = buildWorkingRollup(state);

  if (attentionRows.length > 0) {
    const rows = [...capNowItems(attentionRows), ...(workingRollup ? [workingRollup] : [])];
    const zone = bodyZone('now', rows, 'zone:now');
    if (zone) {
      zone.liveRegionText = liveRegionText(attentionRows.length);
      zones.push(zone);
    }
  } else {
    const suggestions = buildGettingStarted(state);
    const zone = suggestions.length
      ? bodyZone('getting-started', suggestions, 'zone:getting-started')
      : bodyZone('now', workingRollup ? [workingRollup] : [], 'zone:now');
    if (zone) zones.push(zone);
  }

  // Today, in the order the rules are allowed to run: who is eligible, what
  // mute removes, what the overnight boundary removes, what order the rest come
  // in, and only then which one is the anchor — so nothing can sort, cap or
  // archive the conversation the operator has open out of first place.
  const anchor = anchorKey(state);
  const eligible = applyMuteRules(selectTodayItems(state), muteIndex(state.prefs), {
    dropMuted: true,
    ...(anchor === null ? {} : { exemptKey: anchor }),
  });
  const today = pinActiveAnchor(
    orderToday(
      archiveOvernight(eligible, state, { ...(anchor === null ? {} : { anchorKey: anchor }) }),
      state
    ),
    state
  );
  const digestRow = buildDigestRow(state);
  // The digest sits below the anchor, never above it: it is a door into
  // yesterday, and where the operator is standing comes first.
  if (digestRow) today.splice(today[0]?.reason === 'anchor:active-session' ? 1 : 0, 0, digestRow);
  const todayZone = bodyZone('today', today, 'zone:today');
  if (todayZone) zones.push(todayZone);

  const librarySections = buildLibrarySections(state);
  if (librarySections.length > 0) {
    zones.push({
      id: 'library',
      label: ZONE_LABEL.library,
      sections: librarySections,
      reason: 'zone:library',
    });
  }

  return { zones };
}
