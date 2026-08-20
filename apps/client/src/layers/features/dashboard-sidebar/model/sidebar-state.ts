/**
 * Everything {@link buildSidebarModel} is allowed to know — the snapshot the
 * whole panel is a pure function of (spec `sidebar-now-today-library` §A2).
 *
 * The type lands here; `useSidebarState` beside it fills it. Three fields —
 * `attention`, `journey` and `digest` — are wired there as placeholders whose
 * sources arrive with P2.2's `entities/attention` and discovery facts, and the
 * four journey fixtures are what everything else is tested against.
 *
 * **Two things are deliberately NOT in here: the clock and the verb.** The
 * clock is `now`, passed in, so every time-dependent rule (the overnight
 * boundary, the once-a-day digest) is a table test rather than a mock. The verb
 * is absent entirely: `SessionActivity` churns every couple of seconds per
 * working session, and a verb in the model would rebuild the whole tree on
 * every tool call. Rows say whether they RESERVE a line for one
 * (`reservesVerbLine`, derived from lifecycle) and the leaf row subscribes to
 * the text itself. Layout comes from lifecycle; text comes from activity.
 *
 * @module features/dashboard-sidebar/model/sidebar-state
 */
import type { SidebarGroup, SidebarItemRef } from '@dorkos/shared/config-schema';
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import type { InteractionTimestamps } from '@/layers/entities/interactions';
import type { JumpBackInModel } from '@/layers/entities/recents';
import type { AttentionState } from '@/layers/entities/session';
import type { SidebarModelPrefs } from '@/layers/entities/config';
import type { NowKind, SidebarTarget } from './build-sidebar-model';

/**
 * The prefs slice the model reads, and one section's stored state.
 *
 * Both are re-exports, not declarations. `entities/config` owns the mapping from
 * the stored `ui.sidebar` to this view (`toSidebarModelPrefs`) and `packages/shared`
 * owns the section shape itself, so declaring either here would put two
 * definitions of one contract in the repo. Re-exported because the rules and
 * fixtures in this directory read them as part of `SidebarState`.
 */
export type { SidebarModelPrefs } from '@/layers/entities/config';
export type { SidebarSectionPrefs } from '@dorkos/shared/config-schema';

/**
 * One agent as the sidebar's rules read it.
 *
 * A narrow view rather than the manifest, because the rules ask four questions
 * of an agent and no more: what is it called on disk, what runtime does it run
 * (BC-32 counts distinct runtimes before offering group affordances), is it a
 * system agent (BC-12 asks whether the roster is "DorkBot only"), and how much
 * attention is it asking for. Everything else a row draws — the face, the
 * description — is resolved by the component from the manifest.
 */
export interface AgentRosterEntry {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  path: string;
  /** Which runtime it runs on, e.g. `'claude-code'`, `'codex'`. */
  runtime: string;
  /** Its mesh namespace, or `null` when it has none recorded. */
  namespace: string | null;
  /** True for DorkBot and any other agent the product created for itself. */
  isSystem: boolean;
  /** Latest known session activity, epoch ms, or `null` if it never ran. */
  lastActivityAt: number | null;
  /** How much of the operator's attention it is asking for. */
  attention: AttentionState;
}

/**
 * One thing that needs the operator, as the model reads it.
 *
 * **A view type, not the entity.** `entities/attention` and its
 * `useAttentionSignals` normalize every source that can raise a blockage; the
 * assembly hook maps that entity into this shape in one place. The model
 * taking a narrow view of it is what lets the rules be tested with a literal
 * instead of a normalizer.
 */
export interface SidebarAttentionSignal {
  /** Stable id of the blockage — a permission request id, an episode id. */
  id: string;
  /** Which of the four blockages this is. Drives Heads up's priority order (BC-6). */
  kind: NowKind;
  /** Who needs you — the agent's display name, or the room's. */
  primary: string;
  /** What it needs, printed after `›`. Absent when there is nothing to add. */
  secondary?: string;
  /** When it started waiting, ISO-8601. Oldest first within a tier (BC-6). */
  since: string;
  /** Where clicking it goes — the approval, the question, the wedged session. */
  deepLink: string;
  /** The agent this is about, when there is a face to draw. */
  agentPath?: string;
}

/**
 * What the product knows about how far along this operator is — the facts
 * Getting started's suggestions are computed from (BC-12).
 *
 * Facts, never a checklist: nothing here records that a suggestion was "done",
 * only what is true. Retirement is the separate, permanent memory in
 * {@link SidebarModelPrefs.gettingStarted}.
 */
export interface JourneyFacts {
  /** Agent directories discovery found that the roster does not hold yet. */
  discoveredUnregisteredPaths: readonly string[];
  /** How many non-system agents the roster holds. DorkBot does not count. */
  nonSystemAgentCount: number;
  /** Whether a session has ever existed, including ones since deleted. */
  hasEverStartedSession: boolean;
  /** Whether the operator has ever posted in #team themselves. */
  hasPostedInTeam: boolean;
  /** Whether a DorkBot session exists. */
  hasDorkBotSession: boolean;
}

/**
 * What finished while the operator was away — the digest's content (BC-22).
 *
 * The digest is shown only when there is real content, never on a schedule.
 * `finishedWhileAwayCount === 0` means no row, whatever the date says.
 */
export interface DigestState {
  /** How many pieces of work finished during the absence. Zero means no row. */
  finishedWhileAwayCount: number;
  /**
   * How many sessions moved during the absence and then went still.
   *
   * **What Heads up's "Went quiet" row became** (DOR-1391), counted and named
   * as stillness rather than as stalling — nothing on a session record marks a
   * clean end, so the row says "idle". It never brings the
   * digest row into existence on its own — that stays
   * {@link DigestState.finishedWhileAwayCount}'s job, so the row still means
   * "something happened while you were out" — but when there IS a digest, this
   * is the half of it worth saying out loud, and the row says it.
   */
  idleWhileAwayCount: number;
}

/**
 * One snapshot of everything the sidebar is a function of.
 *
 * Two fields go beyond the spec's §A2 table, and both exist because a
 * behavioural contract cannot otherwise be expressed — see their own docs.
 * Both follow the same honesty rule as the verb ladder: a source that cannot
 * supply the fact omits it, and never guesses.
 */
export interface SidebarState {
  /**
   * The instant to reason from, epoch ms — the only clock in the model.
   *
   * Coarse by design (`useNowTick(60_000)` upstream): the overnight boundary
   * and the once-a-day digest are the only rules that read it, and neither
   * needs a second's precision. A finer clock would rebuild the tree for
   * nothing.
   */
  now: number;
  /** Every session the cockpit can see, newest first. */
  sessions: readonly Session[];
  /** The sessions streaming a turn right now (BC-9's "N working"). */
  workingSessionIds: readonly string[];
  /**
   * Session id → the directory it is running in, for every session the live
   * stream is currently tracking.
   *
   * **Beyond §A2's table, and unavoidable.** BC-31 promises that folding a
   * section loses no signal, and a section's working count is the sum of its
   * members' — which cannot be summed without knowing whose each running
   * session is. `sessions` is the last-ten REST window and is up to thirty
   * seconds behind, so a turn that started just now has no record there at all:
   * for that window every agent row read `idle`, every folded section rolled up
   * a zero, and Heads up said "1 working" beside them (DOR-1137).
   *
   * Straight from the session-list store's `statusCwds`, which the runtime fills
   * from the same status event that made the session live, and which is pruned
   * the moment it settles. A session the server could not place has no entry —
   * omission, never a guess.
   */
  liveSessionCwds: Readonly<Record<string, string>>;
  /**
   * Session id → coarse lifecycle. **Lifecycle only, never `activity`** — the
   * standing rule this whole design rests on.
   */
  sessionStatuses: Readonly<Record<string, SessionLifecycle>>;
  /** Every room this cockpit can see. */
  rooms: readonly RoomSummary[];
  /** Every thread the operator is in. They render as Today rows (BC-15). */
  threads: readonly ThreadSummary[];
  /** The fleet. */
  agents: readonly AgentRosterEntry[];
  /** Agent path → the disambiguated name to print. */
  displayNames: Readonly<Record<string, string>>;
  /** What needs the operator. The only source Heads up draws from (BC-5). */
  attention: readonly SidebarAttentionSignal[];
  /**
   * Signal ids something ABOVE Heads up's rows is already drawing as a card.
   *
   * **The phone only, and empty everywhere else.** The mobile Home tab puts an
   * answerable card at the top of Heads up for every approval and every prompt
   * (`widgets/mobile-tabs`'s lead slot, P4 AC-5), and until DOR-1391 the same
   * blockage then drew a second time as a row underneath it — one ask, one card
   * and one "Heads up" line, in one viewport. The desktop panel has no lead
   * slot at all, so it passes nothing here and is unchanged.
   *
   * A list of ids rather than a "mobile" flag, because the model must not learn
   * what a viewport is: whoever draws the cards knows exactly which blockages
   * they cover, and that is the only fact this needs.
   *
   * Suppression removes ROWS, never the count: `needsYouCount` and the live
   * region still report every blockage, because a card on screen is still a
   * thing waiting on a person.
   */
  coveredSignalIds?: readonly string[];
  /**
   * The shipped "Jump back in" model.
   *
   * Today derives its OWN membership and order (BC-15, BC-16) rather than
   * inheriting this list's cap and activity ordering. What it takes from here
   * is the one-line summary each row already computes, so the sentence under a
   * row is derived once in the product rather than twice.
   */
  recents: JumpBackInModel;
  /** The operator's stored sidebar preferences. */
  prefs: SidebarModelPrefs;
  /**
   * `<kind>:<id>` → when the operator last OPENED it, ISO-8601, straight from
   * `entities/interactions`. Half of Today's order key (BC-16).
   *
   * Typed as the store's own {@link InteractionTimestamps} rather than as a
   * structurally identical `Record<string, string>` written out here. Both
   * spellings compile; only one of them breaks the build if the store ever
   * changes what it puts in the value. Epoch milliseconds would satisfy
   * `Record<string, string>` and then parse to `NaN`, which this model reads as
   * "never interacted with" — Today would quietly fall back to alphabetical
   * order with nothing thrown.
   */
  interactions: InteractionTimestamps;
  /**
   * `<kind>:<id>` → when the operator last WROTE in it, ISO-8601. The other
   * half of Today's order key.
   *
   * **Beyond §A2's table, and unavoidable.** BC-16 defines the order key as
   * `max(userLastMessageAt, userLastOpenedAt)`, and no field on the wire
   * carries the first half today: `GET /api/sessions/recent` gains it as an
   * additive, optional field (§F) and room read cursors supply it for rooms. A
   * runtime that cannot say simply has no entry here, and the interaction
   * timestamp alone governs — omission, never a guess.
   */
  userLastMessageAt: Readonly<Record<string, string>>;
  /**
   * Room id → how many times the operator is @mentioned above their read
   * cursor.
   *
   * **Beyond §A2's table, and unavoidable.** BC-40's one exception — "@mentions
   * pierce mute" — cannot be evaluated without knowing that a mention exists,
   * and `RoomSummary.unreadCount` counts messages rather than mentions. A room
   * absent from this map has no mentions the client knows about.
   */
  mentions: Readonly<Record<string, number>>;
  /**
   * Whether the operator has unfolded Today's "+ N automated" reveal (BC-19).
   *
   * **Optional, and absent means folded** — the state every session starts in.
   * It is optional rather than required because the four journey fixtures are
   * read by several tasks at once and are never edited, and a fold that begins
   * closed has nothing to say by being absent.
   *
   * A per-tab fact and deliberately not a preference: it is where the operator
   * has scrolled to in a thought, not something they configured, so it does not
   * follow them to another machine.
   */
  todayAutomatedExpanded?: boolean;
  /** What the operator has open right now, from the router. `null` off-route. */
  activeTarget: SidebarTarget | null;
  /** How far along this operator is (BC-12). */
  journey: JourneyFacts;
  /** What finished while they were away (BC-22). */
  digest: DigestState;
}
