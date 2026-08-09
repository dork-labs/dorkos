/**
 * The small builders the four journey fixtures are assembled from.
 *
 * @module features/dashboard-sidebar/model/fixtures/factories
 */
import type { RoomSummary, ThreadSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import type { AgentRosterEntry, SidebarModelPrefs, SidebarState } from '../sidebar-state';

/**
 * The instant every fixture reasons from: 09:15 on 9 August 2026, **local**.
 *
 * Local rather than a fixed epoch on purpose. Every time-dependent rule in the
 * model is stated in local terms — the 04:00 overnight boundary, the calendar
 * day the digest is once per — so a fixture pinned to a UTC instant would
 * archive different rows on a machine in Auckland than on one in California,
 * and the same test would pass in one office and fail in the other.
 */
export const FIXTURE_NOW = new Date(2026, 7, 9, 9, 15, 0, 0).getTime();

/** One hour, in milliseconds. Fixture timestamps are all offsets from now. */
export const HOUR = 60 * 60 * 1000;

/** One minute, in milliseconds. */
export const MINUTE = 60 * 1000;

/**
 * An ISO-8601 timestamp `hours` before {@link FIXTURE_NOW}.
 *
 * @param hours - How long ago, in hours. Fractions are fine.
 */
export function hoursAgo(hours: number): string {
  return new Date(FIXTURE_NOW - hours * HOUR).toISOString();
}

/**
 * A session, with everything a fixture does not care about filled in.
 *
 * @param overrides - What this particular session is.
 */
export function session(overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session {
  return {
    createdAt: hoursAgo(24),
    updatedAt: hoursAgo(1),
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/**
 * A room, with everything a fixture does not care about filled in.
 *
 * @param overrides - What this particular room is.
 */
export function room(
  overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind' | 'title'>
): RoomSummary {
  return {
    slug: overrides.kind === 'dm' ? null : overrides.title.replace(/^#/, ''),
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 50,
    wellKnown: null,
    createdAt: hoursAgo(72),
    lastActivityAt: hoursAgo(2),
    unreadCount: 0,
    participants: overrides.kind === 'dm' ? [] : null,
    working: 0,
    ...overrides,
  };
}

/**
 * One person on a direct message's roster.
 *
 * @param id - Their author id.
 * @param displayName - What they are called.
 */
export function person(
  id: string,
  displayName: string
): NonNullable<RoomSummary['participants']>[number] {
  return { id, kind: 'human', displayName, handle: null };
}

/**
 * A thread, with everything a fixture does not care about filled in.
 *
 * @param overrides - What this particular thread is.
 */
export function thread(
  overrides: Partial<ThreadSummary> & Pick<ThreadSummary, 'roomId' | 'roomTitle' | 'rootEntryId'>
): ThreadSummary {
  return {
    roomKind: 'channel',
    roomSlug: overrides.roomTitle.replace(/^#/, ''),
    rootAuthorId: 'person:dorian',
    rootPreview: 'Anything else to change here?',
    replyCount: 3,
    unreadCount: 0,
    lastActivityAt: hoursAgo(3),
    ...overrides,
  };
}

/**
 * A roster entry, with everything a fixture does not care about filled in.
 *
 * @param path - The agent's directory.
 * @param overrides - What is particular about it.
 */
export function agent(
  path: string,
  overrides: Partial<Omit<AgentRosterEntry, 'path'>> = {}
): AgentRosterEntry {
  return {
    path,
    runtime: 'claude-code',
    namespace: null,
    isSystem: false,
    lastActivityAt: FIXTURE_NOW - 2 * HOUR,
    attention: 'active',
    ...overrides,
  };
}

/**
 * Sidebar preferences with nothing set — the shape a first run has.
 *
 * @param overrides - What this operator has changed.
 */
export function prefs(overrides: Partial<SidebarModelPrefs> = {}): SidebarModelPrefs {
  return {
    pinned: [],
    groups: [],
    muted: [],
    sections: {},
    gettingStarted: { retired: [] },
    digest: {},
    ...overrides,
  };
}

/**
 * A complete {@link SidebarState} with every field at its empty value.
 *
 * Fixtures spread over this rather than repeating seventeen fields each, which
 * is also what keeps them honest when the state type grows: a new field lands
 * here once and every fixture stays complete.
 *
 * @param overrides - What this journey looks like.
 */
export function emptyState(overrides: Partial<SidebarState> = {}): SidebarState {
  return {
    now: FIXTURE_NOW,
    sessions: [],
    workingSessionIds: [],
    sessionStatuses: {},
    rooms: [],
    threads: [],
    agents: [],
    displayNames: {},
    attention: [],
    recents: { items: [], automated: [] },
    prefs: prefs(),
    interactions: {},
    userLastMessageAt: {},
    mentions: {},
    activeTarget: null,
    journey: {
      discoveredUnregisteredPaths: [],
      nonSystemAgentCount: 0,
      hasEverStartedSession: false,
      hasPostedInTeam: true,
      hasDorkBotSession: true,
    },
    digest: { finishedWhileAwayCount: 0 },
    projects: { activeCount: 0, byCwd: {} },
    ...overrides,
  };
}
