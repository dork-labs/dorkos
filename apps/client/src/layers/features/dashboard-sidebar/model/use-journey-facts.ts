/**
 * How far along this operator is — the facts Getting started computes its
 * suggestions from (BC-12).
 *
 * **Facts, never a checklist.** Nothing here records that a suggestion was
 * "done": it records what is true, and `buildGettingStarted` decides what is
 * worth saying about it. Permanence lives somewhere else entirely, in
 * `prefs.gettingStarted.retired[]`.
 *
 * @module features/dashboard-sidebar/model/use-journey-facts
 */
import { useMemo } from 'react';
import { TEAM_ROOM_WELL_KNOWN, type RoomSummary } from '@dorkos/shared/room-schemas';
import { useDiscoveryStore } from '@/layers/entities/discovery';
import type { AgentRosterEntry, JourneyFacts } from './sidebar-state';

/**
 * The facts that mean "there is nothing to suggest".
 *
 * Returned whenever the queries behind them have not answered yet, and the
 * choice of values is load-bearing rather than tidy. `suggestion:add-agent`
 * fires on `nonSystemAgentCount === 0`, which is exactly what an unanswered
 * roster query looks like — so a hook that derived the count from a pending
 * query would flash first-run onboarding at every existing user on every cold
 * load. Being wrong in the quiet direction is the only safe way to be wrong
 * here.
 */
const NOTHING_TO_SUGGEST: JourneyFacts = {
  discoveredUnregisteredPaths: [],
  nonSystemAgentCount: 1,
  hasEverStartedSession: true,
  hasPostedInTeam: true,
  hasDorkBotSession: true,
};

/** What {@link useJourneyFacts} answers. */
export interface JourneyFactsState {
  /** The facts, or {@link NOTHING_TO_SUGGEST} while they are still unknown. */
  facts: JourneyFacts;
  /**
   * Whether {@link JourneyFactsState.facts} are real.
   *
   * The one thing a caller cannot work out for itself: a resolved
   * `hasEverStartedSession: true` and the loading placeholder are the same
   * value. Retirement is permanent (BC-13), so the writer must be able to tell
   * them apart — retiring on the placeholder would erase the whole of Getting
   * started on a cold load and never give it back.
   */
  isResolved: boolean;
}

/** What {@link useJourneyFacts} reads, gathered by the assembly hook. */
export interface JourneyFactsInput {
  /** The fleet, as the sidebar's snapshot already holds it. */
  agents: readonly AgentRosterEntry[];
  /** Agent directory → when it last had session activity, from the recents read. */
  agentActivity: Readonly<Record<string, string>>;
  /** How many sessions the cockpit can currently see. */
  sessionCount: number;
  /**
   * Every room the sidebar holds — read for #team, and for nothing else.
   *
   * The whole list rather than the one room, because #team is found by
   * `wellKnown` and the owner may rename it (`useTeamRoom`); a caller that
   * pre-selected it by slug would hand over the wrong room after a rename.
   */
  rooms: readonly RoomSummary[];
  /**
   * Whether the roster and the recent-sessions read have both answered.
   *
   * Passed in rather than re-queried, because the assembly hook already holds
   * both queries and asking a second time would put the freshness of these
   * facts at the mercy of which hook ran first.
   */
  rosterResolved: boolean;
}

/**
 * The journey facts, and whether they are real yet.
 *
 * Takes the roster and the session facts as arguments — the assembly hook holds
 * both already — and reads exactly one source of its own: the discovery store.
 *
 * **It never starts a scan.** Discovery is consent-first (`transport.scan()`
 * runs only when somebody presses "look around"), so this reads whatever a scan
 * left behind in this window and finds nothing otherwise. That is the honest
 * reading: "we have not looked" is not "there is nothing there", and
 * `suggestion:add-agent` is the fallback BC-12 already defines for it.
 *
 * @param input - The roster and session facts the assembly hook holds.
 */
export function useJourneyFacts(input: JourneyFactsInput): JourneyFactsState {
  const { agents, agentActivity, sessionCount, rooms, rosterResolved } = input;
  const candidates = useDiscoveryStore((state) => state.candidates);

  return useMemo(() => {
    if (!rosterResolved) return { facts: NOTHING_TO_SUGGEST, isResolved: false };

    const registered = new Set(agents.map((entry) => entry.path));
    const discoveredUnregisteredPaths = candidates
      .map((candidate) => candidate.path)
      .filter((path) => !registered.has(path));

    // DorkBot is the system agent every install has (`ensureDorkBot`), and
    // `isSystem` is the only flag on the wire that names it — there is no
    // client-side path constant, and there should not be one: an install is
    // free to put it anywhere.
    const dorkBot = agents.find((entry) => entry.isSystem) ?? null;

    // Found by `wellKnown` rather than by `#team`, for the reason `useTeamRoom`
    // gives: the key survives a rename and the slug does not.
    const team = rooms.find((room) => room.wellKnown === TEAM_ROOM_WELL_KNOWN);

    return {
      facts: {
        discoveredUnregisteredPaths,
        nonSystemAgentCount: agents.filter((entry) => !entry.isSystem).length,
        // `agentActivity` is computed server-side across ALL of an agent's
        // sessions before the recent list is trimmed, so it answers "ever",
        // which the trimmed list on its own cannot.
        hasEverStartedSession: sessionCount > 0 || Object.keys(agentActivity).length > 0,
        // The server's own read of the room's log (`RoomSummary.viewerHasPosted`,
        // DOR-1112), which is the only place this is cheaply knowable: the client
        // would have to fetch every message in #team to work it out.
        //
        // **Absent stays quiet, and only `false` speaks.** No #team in the list
        // (still loading, archived, or an install that predates the field) is
        // "we cannot say", and a suggestion built on a guess would tell an
        // operator who has been talking in #team for months to go say hello —
        // the same omission-never-a-guess rule the rest of these facts follow.
        hasPostedInTeam: team?.viewerHasPosted ?? true,
        hasDorkBotSession: dorkBot !== null && agentActivity[dorkBot.path] !== undefined,
      },
      isResolved: true,
    };
  }, [agents, agentActivity, sessionCount, rooms, rosterResolved, candidates]);
}
