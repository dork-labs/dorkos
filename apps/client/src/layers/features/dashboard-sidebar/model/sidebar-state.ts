/**
 * Everything {@link buildSidebarModel} is allowed to know — the snapshot the
 * whole panel is a pure function of.
 *
 * The type lands here; `useSidebarState` beside it fills it, and the journey
 * fixtures are what everything else is tested against.
 *
 * **Two things are deliberately NOT in here: the clock and the verb.** The
 * clock is `now`, passed in, so the one time-dependent rule (a smart section's
 * "active in the last N days") is a table test rather than a mock. The verb is
 * absent entirely: `SessionActivity` churns every couple of seconds per working
 * session, and a verb in the model would rebuild the whole tree on every tool
 * call. Rows say whether they RESERVE a line for one (`reservesVerbLine`) and
 * the leaf row subscribes to the text itself.
 *
 * @module features/dashboard-sidebar/model/sidebar-state
 */
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import type { AttentionState } from '@/layers/entities/session';
import type { SidebarModelPrefs } from '@/layers/entities/config';
import type { SidebarTarget } from './build-sidebar-model';

/**
 * The prefs slice the model reads, and one section's stored state.
 *
 * Both are re-exports, not declarations. `entities/config` owns the mapping from
 * the stored `ui.sidebar` to this view (`toSidebarModelPrefs`) and `packages/shared`
 * owns the section shape itself, so declaring either here would put two
 * definitions of one contract in the repo.
 */
export type { SidebarModelPrefs } from '@/layers/entities/config';
export type { SidebarSectionPrefs } from '@dorkos/shared/config-schema';

/**
 * One agent as the sidebar's rules read it.
 *
 * A narrow view rather than the manifest, because the rules ask few questions
 * of an agent: what is it called on disk, what runtime and namespace does it
 * have (a smart section matches on both), when did it last run, and how much
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
 * One page a mini app added, as the Add-ons section reads it.
 *
 * **A view type, not the registry entry.** `shared/model`'s extension registry
 * holds the page's component and icon; the model must not hold React, so the
 * assembly hook maps each listed page into this shape and the row component
 * looks the icon up again by {@link SidebarAddOnPage.id}.
 */
export interface SidebarAddOnPage {
  /** The page's contribution id, `<extensionId>:<path>`. */
  id: string;
  /** The extension that registered it. */
  extensionId: string;
  /** The path it registered: `''` for the extension's home. Never a `:param` path. */
  path: string;
  /** The title it registered — what the row says. */
  title: string;
}

/** One snapshot of everything the sidebar is a function of. */
export interface SidebarState {
  /**
   * The instant to reason from, epoch ms — the only clock in the model.
   *
   * Coarse by design (`useNow(60_000)` upstream): a smart section's "active in
   * the last N days" is the only rule that reads it.
   */
  now: number;
  /** The recent sessions window, newest first — where a live session's directory falls back to. */
  sessions: readonly Session[];
  /** The sessions streaming a turn right now. */
  workingSessionIds: readonly string[];
  /**
   * The sessions waiting on a person right now: an approval or a question
   * (`blocked`). A folded section keeps an agent row on screen for one
   * (DOR-3224), the same fact the row's needs-you dot is drawn from.
   */
  blockedSessionIds: readonly string[];
  /**
   * Session id → the directory it is running in, for every session the live
   * stream is currently tracking.
   *
   * A folded section's working count is the sum of its members', which cannot
   * be summed without knowing whose each running session is. `sessions` is the
   * last-ten REST window and is up to thirty seconds behind, so this is what
   * makes a turn that started just now count (DOR-1137).
   */
  liveSessionCwds: Readonly<Record<string, string>>;
  /** Every room this cockpit can see. */
  rooms: readonly RoomSummary[];
  /** The fleet. */
  agents: readonly AgentRosterEntry[];
  /** Agent path → the disambiguated name to print. */
  displayNames: Readonly<Record<string, string>>;
  /** The operator's stored sidebar preferences. */
  prefs: SidebarModelPrefs;
  /**
   * Room id → how many unread entries @mention the operator, from
   * `RoomSummary.mentionCount`.
   *
   * What turns a channel's bold name into a number — a channel only counts
   * what was aimed at you — and the one thing that pierces mute. A room absent
   * from this map has no unread mentions, or a source that cannot say.
   */
  mentions: Readonly<Record<string, number>>;
  /**
   * The pages mini apps added that a menu may list, by title — what the
   * Add-ons section draws (spec `mini-app-placement` Part 2). Empty when no
   * extension added one, and then the section is absent.
   */
  addOns: readonly SidebarAddOnPage[];
  /** What the operator has open right now, from the router. `null` off-route. */
  activeTarget: SidebarTarget | null;
}
