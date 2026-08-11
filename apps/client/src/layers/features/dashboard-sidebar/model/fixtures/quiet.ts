/**
 * A quiet morning: nothing needs you, the digest has something to say, and one
 * conversation has already slipped past the overnight boundary.
 *
 * What this fixture is for: the absence of Heads up as the calm signal, the digest's
 * two conditions both being true, and overnight archival actually removing
 * something (a fixture where the boundary never fires cannot prove it works).
 *
 * **Read it, never edit it** — see `first-run.ts` for why.
 *
 * @module features/dashboard-sidebar/model/fixtures/quiet
 */
import type { SidebarState } from '../sidebar-state';
import { agent, emptyState, hoursAgo, prefs, room, session } from './factories';

const TANGERINE = '/Users/dev/code/tangerine';

/** The quiet-morning journey. */
export const quietFixture: SidebarState = emptyState({
  agents: [
    agent('/Users/dev/.dork/agents/dorkbot', { isSystem: true, attention: 'idle' }),
    agent(TANGERINE, { attention: 'idle' }),
  ],
  displayNames: { '/Users/dev/.dork/agents/dorkbot': 'DorkBot', [TANGERINE]: 'tangerine' },
  sessions: [
    session({ id: 'ses-morning', title: 'Fix the release script', cwd: TANGERINE }),
    session({ id: 'ses-lastnight', title: 'Rename the room columns', cwd: TANGERINE }),
  ],
  sessionStatuses: { 'ses-morning': 'idle', 'ses-lastnight': 'idle' },
  rooms: [
    room({ id: 'room-team', kind: 'channel', title: 'team', wellKnown: 'team' }),
    room({ id: 'room-releases', kind: 'channel', title: 'releases', unreadCount: 2 }),
  ],
  // 06:40 today is after the 04:00 boundary; 21:00 last night is before it, so
  // that conversation is the one archival is expected to take.
  interactions: {
    'session:ses-morning': hoursAgo(2.6),
    'room:room-releases': hoursAgo(3),
    'session:ses-lastnight': hoursAgo(12.25),
  },
  recents: { items: [], automated: [] },
  prefs: prefs({ digest: { lastShownDate: '2026-08-08' } }),
  journey: {
    discoveredUnregisteredPaths: [],
    nonSystemAgentCount: 1,
    hasEverStartedSession: true,
    hasPostedInTeam: true,
    hasDorkBotSession: true,
  },
  digest: { finishedWhileAwayCount: 3 },
  projects: { activeCount: 1, byCwd: { [TANGERINE]: 'tangerine' } },
});
