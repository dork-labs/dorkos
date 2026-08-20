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
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
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
import { rollUpCollapsedSection } from './rules/roll-up-collapsed-section';
import { selectNowItems } from './rules/select-now-items';
import { revealAutomated, selectTodayItems } from './rules/select-today-items';
import { suppressCoveredNowItems } from './rules/suppress-covered-now-items';
import { anchorKey } from './rules/targets';
import type { SidebarState } from './sidebar-state';

/**
 * The four zones, in the fixed order they render (BC-3).
 *
 * `getting-started` is not a fifth zone: it is the day-one life stage of Heads
 * up and shares its slot, which is why they are never both present (BC-4).
 *
 * **`now` is an id, not a label.** The zone a person reads as "Heads up" is
 * `now` everywhere in code, storage and the DOM. The label was renamed in
 * DOR-1155 (2026-08-11) — "Now" read temporally, so an operator went looking
 * for his *running* agent there, when the zone actually holds what he should
 * *know about*. The id stayed put deliberately: renaming it would cost a
 * persisted-config migration and buy the user nothing. {@link ZONE_LABEL} is
 * the single place the two are joined.
 *
 * **The tuple is the enumeration.** Anything that needs to talk about "every
 * zone" — the mobile tabs deciding which zones are Home's and which are
 * Library's, {@link ZONE_LABEL} — reads it rather than repeating four strings,
 * so a fifth zone is one edit here instead of a hunt.
 */
export const SIDEBAR_ZONE_IDS = ['getting-started', 'now', 'today', 'library'] as const;

/** One zone's id — the four above, and only those. */
export type SidebarZoneId = (typeof SIDEBAR_ZONE_IDS)[number];

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
 * Every section whose fold is remembered, Library's four plus the two computed
 * zones.
 *
 * **The computed zones are in here now, and that is the whole of D1's "every
 * header folds".** BC-2 used to say a zone is a landmark and never an
 * accordion; the exception cost more to learn than the fold was worth, so the
 * rule is one rule and Heads up, Today and Getting started carry a persisted
 * key like any other section.
 *
 * The `satisfies` keeps this and the persisted vocabulary honest: retiring an id
 * from the schema turns an entry here into a compile error rather than a fold
 * nothing can store.
 */
export const SIDEBAR_FOLDING_SECTION_IDS = [
  'now',
  'today',
  'getting-started',
  ...SIDEBAR_LIBRARY_SECTION_IDS,
] as const satisfies readonly PersistedSectionId[];

/**
 * Narrow a section id to one that has a place to store its collapse state.
 *
 * A group sub-header answers `null`, because a group's fold already lives on the
 * group. Reading the tuple rather than repeating the ids, so it stays the one
 * place the folding set is edited.
 *
 * @param id - Any section id the model emits.
 */
export function persistedSectionId(id: SidebarSectionId): PersistedSectionId | null {
  return SIDEBAR_FOLDING_SECTION_IDS.find((entry) => entry === id) ?? null;
}

/**
 * A section's id.
 *
 * The persisted Library sections are a closed set; a group sub-header is
 * `group:<groupId>`, which cannot collide with them and needs no schema of its
 * own because a group's own collapse state already lives on the group.
 * `now`, `today` and `getting-started` name the single section each of their
 * zones holds — the one that wears the zone's name now that the zone `<h2>` is
 * gone (D1).
 */
export type SidebarSectionId =
  | LibrarySectionId
  | 'now'
  | 'today'
  | 'getting-started'
  | `group:${string}`;

/** What kind of blockage put an item in Heads up. The only four that may (BC-5). */
export type NowKind = 'permission-prompt' | 'question' | 'error' | 'schedule-approval';

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
 *
 * **One id per mark.** `discovery` used to sit beside `digest` and draw the same
 * icon — two words for one meaning, which is how a vocabulary starts drifting
 * from its pictures.
 */
export type SidebarIconId =
  | 'permission'
  | 'question'
  | 'error'
  /** A schedule an agent proposed and parked, waiting for a yes or a no. */
  | 'schedule'
  | 'overflow'
  | 'working'
  | 'automated'
  | 'digest'
  | 'add-agent'
  | 'first-session'
  | 'team'
  | 'dorkbot'
  /** A session that belongs to no agent — no `cwd`, so no face to draw (DOR-203). */
  | 'session';

/** What clicking a row does. The only discriminated union in the model. */
export type SidebarTarget =
  | { kind: 'session'; sessionId: string; agentPath: string; cwd: string | null }
  | {
      kind: 'room';
      roomId: string;
      roomKind: 'channel' | 'dm' | 'thread';
      /**
       * The entry a thread hangs off (`ThreadSummary.rootEntryId`) — a thread
       * row's address inside its room, present only when `roomKind` is
       * `'thread'`.
       *
       * Without it a thread row could only open the room it lives in, which is
       * a different place: a thread is a relation between entries in one room's
       * log (ADR 260728-022013), and `/channels` addresses it as `?thread=`.
       * Deliberately not part of the row's key or its interaction key — the
       * thread reads the ROOM's cursor, and one place has one record.
       */
      rootEntryId?: string;
    }
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
  /**
   * Fixed 18px leading slot. The glyph carries the type; row chrome never does.
   *
   * **A room's row says `hash` whatever kind of room it is**, and that is not a
   * claim about what gets drawn: `RoomRow` owns a room's leading slot and builds
   * it from the roster (a `#` for a channel, faces for a direct message), so the
   * only reader of this field is the generic row, which draws the rooms `RoomRow`
   * declines — threads. Two glyph kinds that named a person and a stack of them
   * used to be emitted here for direct messages and rendered by nothing.
   */
  glyph:
    | { kind: 'agent-avatar'; agentPath: string }
    | { kind: 'hash' }
    | { kind: 'icon'; icon: SidebarIconId };
  /** The "who": agent name, room name, person name. Never a title. */
  primary: string;
  /** The "what", rendered after `›`. Present iff this row is a session. */
  secondary?: string;
  /** True when the row reserves a second line for a live verb (BC-24). */
  reservesVerbLine: boolean;
  /**
   * The session's coarse phase, on a session row — what the leaf verb line
   * needs to know, and nothing more.
   *
   * **This is not the verb, and the distinction is the whole design.** A
   * lifecycle changes when a turn starts and stops; the verb changes every
   * couple of seconds while one runs. The model already reads this to derive
   * {@link SidebarRowModel.status} and
   * {@link SidebarRowModel.reservesVerbLine}, so carrying it costs nothing and
   * spares `SessionVerbLine` a second subscription to churn the model exists to
   * absorb (spec R1, BC-37).
   *
   * Absent on every row that is not a session, and on a session whose runtime
   * has reported no status — omission, never a guess.
   */
  lifecycle?: SessionLifecycle;
  /** One-line preview when there is one worth showing and no verb line. */
  preview?: string;
  /** The row's unread state (design-decisions §18, BC-40). */
  unread: SidebarUnread;
  /**
   * "N live" chip on an agent row with concurrent sessions.
   *
   * Present only at or above {@link LIVE_CHIP_MIN}, so its presence IS the
   * chip's condition and the row has no threshold of its own to disagree with.
   */
  liveCount?: number;
  /**
   * Heads up-only. Drives priority (BC-6).
   *
   * **Nothing in Heads up can be waved away, so there is no dismissible bit
   * here** (BC-42). One thing ever could — the idle nudge — and DOR-1391
   * retired the nudge itself; a flag that is false on every row is a flag whose
   * only remaining job is to invite a fifth kind that reads it.
   */
  attention?: { kind: NowKind; since: string };
  /** Whether the operator muted this target (BC-40). */
  muted: boolean;
  /** False for every row outside Library (R3). */
  draggable: boolean;
  /** Provenance. Answers "why is this row here?" in devtools, always. */
  reason: string;
}

/** What a folded section still says about what it is hiding (BC-31). */
export interface SidebarRollup {
  /**
   * How many rows are behind the fold — the "12" in "12 · 3 unread".
   *
   * Always present, so a folded section is never a bare word: the operator can
   * see the size of what they put away without unfolding it.
   */
  count: number;
  /** Its rolled-up unread state, by the same two-tier rule a row follows. */
  unread: SidebarUnread;
  /** How many of its members are streaming right now. */
  workingCount: number;
  /**
   * How many things inside NEED the operator — Heads up only.
   *
   * **This is why folding Heads up is safe.** Every other section's roll-up
   * counts rows; Heads up's rows include the "N working" report, which needs
   * nobody. Folding it must never be a way to make a permission prompt
   * disappear quietly, so the number the header keeps is the one that means
   * "answer something" (D1, BC-11). Absent on every other section.
   */
  needsYouCount?: number;
}

/** One section: a header (or none) and its rows. */
export interface SidebarSectionModel {
  /** Which section this is. */
  id: SidebarSectionId;
  /**
   * `null` = headerless body.
   *
   * Rare now: with the zone `<h2>` gone, Heads up, Today and Getting started
   * carry their zone's name on their own section header (D1). Only a section
   * whose zone draws it some other way leaves this null.
   */
  label: string | null;
  /**
   * Whether it can fold at all.
   *
   * Every header folds (D1) except Getting started's, which has no persisted
   * key to fold into — see {@link SIDEBAR_FOLDING_SECTION_IDS}.
   */
  collapsible: boolean;
  /** Whether it is folded right now. */
  collapsed: boolean;
  /** Signal that survives folding (BC-31). */
  rollup?: SidebarRollup;
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
  /**
   * How many things in this zone NEED the operator (BC-11). Heads up only.
   *
   * **Not a row count, and the difference is the whole point.** Heads up also
   * holds the "N working" rollup, which is a report on what is busy rather
   * than a thing anyone has to answer; counting rows would badge a quiet
   * morning with a 1. This is the number
   * {@link SidebarZoneModel.liveRegionText} is built from, so the sentence a
   * screen reader hears and the badge a phone draws are the same fact rather
   * than two recomputations of it (P4 AC-2).
   *
   * Absent on every zone that is not Heads up — omission, never a zero.
   */
  needsYouCount?: number;
  /** Visually-hidden text for the zone's polite live region. Heads up only (BC-11). */
  liveRegionText?: string;
  /** Provenance. */
  reason: string;
}

/** A zone with nothing to say is absent from `zones` — never an empty box (BC-1). */
export interface SidebarModel {
  /** The zones, in the fixed order `getting-started|now`, `today`, `library`. */
  zones: SidebarZoneModel[];
}

/**
 * The words each zone's heading uses.
 *
 * The one place a zone id becomes a word a person reads — `now` says "Heads
 * up" here and nowhere else (DOR-1155; see {@link SidebarZoneId}).
 *
 * Exported because two callers synthesize a zone the builder never emits — the
 * all-clear beat's placeholder and the Dev Playground's states panel — and a
 * second copy of the words is how a rename half-lands.
 */
export const ZONE_LABEL: Record<SidebarZoneId, string> = {
  'getting-started': 'Getting started',
  now: 'Heads up',
  today: 'Today',
  library: 'Library',
};

/**
 * What Heads up's live region says — the COUNT of things needing you, and nothing
 * else (BC-11).
 *
 * A verb change or an unread change must never reach a screen reader from here;
 * a fleet of thirty agents would turn one into a siren.
 *
 * **Exported for the one caller that has to say it without a zone to read it
 * off.** On the phone, every blockage can be drawn as a card by the lead slot,
 * which leaves Heads up with no rows and therefore no zone — and the sentence is
 * still true, because the cards are what the person is being told about
 * (DOR-1391). A second spelling of these words in the widget is how a rename
 * half-lands, so the widget calls this instead.
 *
 * @param count - How many things need the operator.
 */
export function needsYouLiveRegionText(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? '1 agent needs you' : `${count} agents need you`;
}

/**
 * A zone holding one section, or `undefined` when that section is empty.
 *
 * The `undefined` is BC-1 in one place: a caller cannot accidentally push an
 * empty box into `zones`, because there is nothing to push. Folded still counts
 * as present — a fold is a thing the operator did, and a zone that vanished when
 * you folded it would take its own unfold control with it.
 *
 * **The section wears the zone's name.** The zone `<h2>` above it is gone (D1),
 * so Heads up, Today and Getting started say what they are on the one header
 * style the whole panel uses.
 *
 * @param id - Which zone.
 * @param rows - Its rows.
 * @param reason - The zone's provenance.
 * @param state - The snapshot, for the stored fold.
 */
function bodyZone(
  id: Exclude<SidebarZoneId, 'library'>,
  rows: SidebarRowModel[],
  reason: string,
  state: SidebarState
): SidebarZoneModel | undefined {
  if (rows.length === 0) return undefined;
  const stored = persistedSectionId(id);
  const collapsible = stored !== null;
  const collapsed = collapsible && (state.prefs.sections[stored]?.collapsed ?? false);
  return {
    id,
    label: ZONE_LABEL[id],
    sections: [
      {
        id,
        label: ZONE_LABEL[id],
        collapsible,
        collapsed,
        // Computed rows: nothing in Heads up, Today or Getting started is a
        // session this panel is streaming, so there is no "N working" to count
        // here — Heads up's own rollup ROW is where that lives.
        ...(collapsed ? { rollup: rollUpCollapsedSection(rows, () => false) } : {}),
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

  // Heads up and Getting started share one slot: real signals always win, and the
  // day-one zone is what fills the space until there are any (BC-4).
  //
  // **"Any" includes the working rollup, and getting that wrong lost it.** The
  // rollup is a Heads up row — BC-8 counts it in Heads up's five-row ceiling and BC-9
  //
  // **Five and `NOW_ATTENTION_CAP = 3` are not two answers to one question.**
  // The ceiling is what the zone may DRAW; the cap bounds only the rows that
  // name something needing you. Five decomposes as three attention rows, plus
  // the "+ N more" fold `capNowItems` adds when there were more than three,
  // plus the one "N working" rollup below. Public docs quoting "three" are
  // quoting the cap, correctly.
  // makes it unconditional ("when ≥1 session is streaming, one row reads N
  // working") — but BC-4 phrases the slot rule as "if `selectNowItems` returns
  // any row", and `selectNowItems` never returns the rollup. Read literally
  // that put Getting started in the slot and dropped the rollup on the floor:
  // an operator who had not retired all five suggestions could never be told
  // anything was working. Design-decisions §2 settles it — "real signals always
  // win" — so Heads up takes the slot whenever it has a row of any kind.
  //
  // The accepted cost is that Getting started steps aside while a turn streams
  // and comes back when it ends. That is the same behaviour a permission
  // prompt already produces, and it is the direction the design record points.
  const attentionRows = rankNowItems(selectNowItems(state));
  const workingRollup = buildWorkingRollup(state);
  // Whatever a lead slot above the zone is already drawing as a card leaves the
  // rows — the phone only, and before the cap so a fold can never summarize
  // things the reader can already see. `attentionRows` above stays the count.
  const drawnRows = suppressCoveredNowItems(attentionRows, state.coveredSignalIds);
  const nowRows = [...capNowItems(drawnRows), ...(workingRollup ? [workingRollup] : [])];

  if (nowRows.length > 0) {
    const zone = bodyZone('now', nowRows, 'zone:now', state);
    if (zone) {
      // Counts what NEEDS the operator, never what is merely busy (BC-11): a
      // rollup appearing must not announce "1 agent needs you". Published as a
      // number as well as a sentence, so the mobile Home badge and this live
      // region are one fact rather than two (P4 AC-2).
      zone.needsYouCount = attentionRows.length;
      zone.liveRegionText = needsYouLiveRegionText(zone.needsYouCount);
      // …and the same number rides the fold. Heads up's roll-up counts what
      // needs answering rather than what is in the list, so folding it can
      // never be a quiet way to put a permission prompt out of sight (D1).
      const body = zone.sections[0];
      if (body?.rollup) body.rollup.needsYouCount = zone.needsYouCount;
      zones.push(zone);
    }
  } else if (attentionRows.length === 0) {
    // **`attentionRows`, not `nowRows` — and the difference is the phone.** The
    // lead slot can cover every blockage there, which empties `nowRows` while
    // things genuinely are waiting (DOR-1391). Handing Getting started the slot
    // in that state would put day-one suggestions above an agent that is
    // stopped, and BC-4's rule is the opposite: real signals always win. So a
    // covered queue yields NEITHER zone, and the cards the renderer draws in
    // Heads up's place are the whole of what that zone says.
    const suggestions = buildGettingStarted(state);
    const zone = bodyZone('getting-started', suggestions, 'zone:getting-started', state);
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
  // Last of all, because the reveal's contents hang off the bottom of the
  // finished list and must not be sorted, capped or archived with it (BC-19).
  const todayZone = bodyZone('today', revealAutomated(today, state), 'zone:today', state);
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
