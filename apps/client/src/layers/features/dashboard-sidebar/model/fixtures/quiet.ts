/**
 * A quiet morning: one agent you talk to, two channels, one of them unread.
 *
 * What this fixture is for: the ordinary shape — an agent appears once, as its
 * direct message, and the rest of the fleet waits in the Directory.
 *
 * **Read it, never edit it** — see `first-run.ts` for why.
 *
 * @module features/dashboard-sidebar/model/fixtures/quiet
 */
import type { SidebarState } from '../sidebar-state';
import { agent, agentDm, emptyState, prefs, room, session } from './factories';

const DORKBOT = '/Users/dev/.dork/agents/dorkbot';
const TANGERINE = '/Users/dev/code/tangerine';

/** The quiet-morning journey. */
export const quietFixture: SidebarState = emptyState({
  agents: [
    agent(DORKBOT, { isSystem: true, attention: 'idle' }),
    agent(TANGERINE, { attention: 'idle' }),
  ],
  displayNames: { [DORKBOT]: 'DorkBot', [TANGERINE]: 'tangerine' },
  sessions: [session({ id: 'ses-morning', title: 'Fix the release script', cwd: TANGERINE })],
  rooms: [
    room({ id: 'room-team', kind: 'channel', title: 'team', wellKnown: 'team' }),
    room({ id: 'room-releases', kind: 'channel', title: 'releases', unreadCount: 2 }),
    agentDm('dm-tangerine', TANGERINE, 'tangerine'),
  ],
  prefs: prefs(),
});
