/**
 * Everything {@link buildSidebarModel} is allowed to know — the snapshot the
 * whole panel is a pure function of (spec `sidebar-now-today-library` §A2).
 *
 * The type lands here; the hook that fills it (`useSidebarState`) lands with
 * the zones in P2.1, because two of its sources — `entities/attention` and the
 * reshaped `SidebarPrefs` — do not exist yet. Until then this is the contract
 * the fixtures satisfy and the tests build against.
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
import type {
  SidebarDisplayFilter,
  SidebarGroup,
  SidebarItemRef,
} from '@dorkos/shared/config-schema';
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import type { JumpBackInModel } from '@/layers/entities/recents';
import type { AttentionState } from '@/layers/entities/session';
import type { NowKind, SidebarSectionId, SidebarTarget } from './build-sidebar-model';

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
 * `useAttentionSignals` land in P2.2, normalizing today's two sibling-feature
 * sources; the assembly hook maps that entity into this shape in one place.
 * The model taking a narrow view of it is what lets the rules be tested with a
 * literal instead of a normalizer.
 *
 * Dismissed idle nudges (BC-10) never reach here: dismissal lives in P2.2's
 * in-memory store and is applied while this list is assembled, so a rule never
 * has to ask whether something was waved away.
 */
export interface SidebarAttentionSignal {
  /** Stable id of the blockage — a permission request id, an episode id. */
  id: string;
  /** Which of the four blockages this is. Drives Now's priority order (BC-6). */
  kind: NowKind;
  /** Who needs you — the agent's display name, or the room's. */
  primary: string;
  /** What it needs, printed after `›`. Absent when there is nothing to add. */
  secondary?: string;
  /** When it started waiting, ISO-8601. Oldest first within a tier (BC-6). */
  since: string;
  /** Where clicking it goes — the approval, the question, the wedged session. */
  deepLink: string;
  /** Whether the operator may wave it away. Idle nudges only (BC-10, BC-42). */
  dismissible: boolean;
  /** The agent this is about, when there is a face to draw. */
  agentPath?: string;
}

/** One section's stored preferences, as the model reads them. */
export interface SidebarSectionPrefs {
  /** Whether the operator folded it. Only Library sections may fold (BC-2). */
  collapsed: boolean;
  /** How it orders its rows. Absent means the section's own default. */
  sortMode?: 'manual' | 'name' | 'recent';
  /** Which rows it shows at all. Absent means all of them. */
  displayFilter?: SidebarDisplayFilter;
}

/**
 * The slice of `ui.sidebar` the model consumes.
 *
 * **A model-local view type on purpose.** The real `SidebarPrefsSchema` grows
 * `sections`, `gettingStarted` and `digest` in P2.8, which also ships the conf
 * migration; duplicating that Zod schema in the client would put two
 * definitions of one contract in the repo. So the model states what it needs,
 * P2.8 owns the schema, and P2.1 writes the single mapping between them.
 */
export interface SidebarModelPrefs {
  /** What the operator pinned, in their order. Library ▸ Pins. */
  pinned: readonly SidebarItemRef[];
  /** Their manual and smart groups. Sub-headers inside Library ▸ Agents. */
  groups: readonly SidebarGroup[];
  /** What they muted (BC-40). */
  muted: readonly SidebarItemRef[];
  /** Per-section collapse, sort and filter. */
  sections: Readonly<Partial<Record<SidebarSectionId, SidebarSectionPrefs>>>;
  /** Getting started's memory of what is done with (BC-13). */
  gettingStarted: { readonly retired: readonly string[] };
  /** The digest's memory of the last local day it was shown (BC-22). */
  digest: { readonly lastShownDate?: string };
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
}

/**
 * The repo dimension, precomputed (BC-38, R4).
 *
 * `activeCount` gates the chip entirely: an operator running everything in one
 * repo never sees it. The word "workspace" appears nowhere here on purpose —
 * six concepts already share it (design-decisions §16).
 */
export interface ProjectFacts {
  /** How many distinct project directories currently have sessions. */
  activeCount: number;
  /** cwd → the label to print. Falls back to the cwd's basename. */
  byCwd: Readonly<Record<string, string>>;
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
  /** What needs the operator. The only source Now draws from (BC-5). */
  attention: readonly SidebarAttentionSignal[];
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
   * `<kind>:<id>` → when the operator last OPENED it, ISO-8601, from
   * `entities/interactions`. Half of Today's order key (BC-16).
   */
  interactions: Readonly<Record<string, string>>;
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
  /** What the operator has open right now, from the router. `null` off-route. */
  activeTarget: SidebarTarget | null;
  /** How far along this operator is (BC-12). */
  journey: JourneyFacts;
  /** What finished while they were away (BC-22). */
  digest: DigestState;
  /** The repo dimension (BC-38). */
  projects: ProjectFacts;
}
