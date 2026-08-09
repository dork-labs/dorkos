/**
 * A working morning: three things need you, three agents are running, and
 * fourteen conversations want the eight rows Today has.
 *
 * What this fixture is for: Now's priority order, the working rollup, the
 * anchor, the soft cap and its exemptions, mute and its @mention exception, the
 * automated reveal, the project chip — and above all BC-16, the promise that
 * none of the activity in here moves a single row.
 *
 * **Read it, never edit it** — see `first-run.ts` for why.
 *
 * @module features/dashboard-sidebar/model/fixtures/busy
 */
import type { SidebarState } from '../sidebar-state';
import { agent, emptyState, hoursAgo, person, prefs, room, session, thread } from './factories';

const TANGERINE = '/Users/dev/code/tangerine';
const CARDAMOM = '/Users/dev/code/cardamom';
const SAFFRON = '/Users/dev/code/saffron';
const JUNIPER = '/Users/dev/code/juniper';
const DORKBOT = '/Users/dev/.dork/agents/dorkbot';

/** The busy-morning journey. */
export const busyFixture: SidebarState = emptyState({
  agents: [
    agent(DORKBOT, { isSystem: true, attention: 'idle' }),
    agent(TANGERINE),
    agent(CARDAMOM, { attention: 'needs-attention' }),
    agent(SAFFRON, { runtime: 'codex' }),
    agent(JUNIPER, { attention: 'inactive', lastActivityAt: null }),
  ],
  displayNames: {
    [DORKBOT]: 'DorkBot',
    [TANGERINE]: 'tangerine',
    [CARDAMOM]: 'cardamom',
    [SAFFRON]: 'saffron',
    [JUNIPER]: 'juniper',
  },
  sessions: [
    session({ id: 'ses-1', title: 'Wire the sidebar model', cwd: TANGERINE }),
    session({ id: 'ses-2', title: 'Rename the room columns', cwd: TANGERINE }),
    session({ id: 'ses-3', title: 'Port the codex adapter', cwd: SAFFRON }),
    session({ id: 'ses-4', title: 'Trim the marketplace payload', cwd: CARDAMOM }),
    session({ id: 'ses-5', title: 'Chase the flaky room test', cwd: CARDAMOM }),
    session({ id: 'ses-6', title: 'Draft the release note', cwd: TANGERINE }),
    session({ id: 'ses-7', title: 'Audit the config migration', cwd: JUNIPER }),
    session({ id: 'ses-8', title: 'Ask about the tunnel', cwd: DORKBOT }),
    session({ id: 'ses-auto-1', title: 'Nightly digest', cwd: TANGERINE, origin: 'task' }),
    session({ id: 'ses-auto-2', title: '#releases turn', cwd: CARDAMOM, origin: 'room' }),
  ],
  workingSessionIds: ['ses-1', 'ses-3', 'ses-5'],
  sessionStatuses: {
    'ses-1': 'streaming',
    'ses-2': 'idle',
    'ses-3': 'streaming',
    'ses-4': 'idle',
    'ses-5': 'streaming',
    'ses-6': 'idle',
    'ses-7': 'error',
    'ses-8': 'idle',
  },
  rooms: [
    room({ id: 'room-team', kind: 'channel', title: 'team', wellKnown: 'team', unreadCount: 4 }),
    room({ id: 'room-releases', kind: 'channel', title: 'releases', unreadCount: 1 }),
    room({ id: 'room-design', kind: 'channel', title: 'design' }),
    room({ id: 'room-noise', kind: 'channel', title: 'noise', unreadCount: 31 }),
    room({
      id: 'dm-priya',
      kind: 'dm',
      title: 'Priya',
      unreadCount: 2,
      participants: [person('person:priya', 'Priya')],
    }),
    room({
      id: 'dm-kai',
      kind: 'dm',
      title: 'Kai',
      participants: [person('person:kai', 'Kai')],
    }),
  ],
  threads: [
    thread({ roomId: 'room-design', roomTitle: 'design', rootEntryId: 'entry-77', unreadCount: 1 }),
  ],
  attention: [
    {
      id: 'sig-error',
      kind: 'error',
      primary: 'juniper',
      secondary: 'Audit the config migration',
      since: hoursAgo(0.75),
      deepLink: '/session?sessionId=ses-7',
      dismissible: false,
      agentPath: JUNIPER,
    },
    {
      id: 'sig-question',
      kind: 'question',
      primary: 'saffron',
      secondary: 'Which account should I use?',
      since: hoursAgo(0.5),
      deepLink: '/session?sessionId=ses-3',
      dismissible: false,
      agentPath: SAFFRON,
    },
    {
      id: 'sig-permission',
      kind: 'permission-prompt',
      primary: 'cardamom',
      secondary: 'Run pnpm test',
      since: hoursAgo(0.2),
      deepLink: '/session?sessionId=ses-5',
      dismissible: false,
      agentPath: CARDAMOM,
    },
  ],
  // Every one of these is the operator's own action. Nothing an agent does
  // appears here, which is exactly why BC-16 holds.
  interactions: {
    'session:ses-1': hoursAgo(0.1),
    'session:ses-2': hoursAgo(1.2),
    'session:ses-3': hoursAgo(0.6),
    'session:ses-4': hoursAgo(2.1),
    'session:ses-5': hoursAgo(0.9),
    'session:ses-6': hoursAgo(3.4),
    'session:ses-7': hoursAgo(4.2),
    'session:ses-8': hoursAgo(4.9),
    'room:room-team': hoursAgo(0.4),
    'room:room-releases': hoursAgo(2.8),
    'room:room-design': hoursAgo(3.9),
    'room:room-noise': hoursAgo(1.5),
    'room:dm-priya': hoursAgo(4.6),
    'room:dm-kai': hoursAgo(5.0),
  },
  // The server can say when the operator last WROTE in #releases, and it is
  // more recent than when they last opened it — the max is what orders the row.
  userLastMessageAt: { 'room:room-releases': hoursAgo(0.3) },
  mentions: { 'room-noise': 1 },
  recents: { items: [], automated: [] },
  prefs: prefs({
    muted: [{ kind: 'room', roomId: 'room-noise' }],
    pinned: [{ kind: 'agent', path: TANGERINE }],
    digest: { lastShownDate: '2026-08-09' },
  }),
  activeTarget: { kind: 'session', sessionId: 'ses-1', agentPath: TANGERINE, cwd: TANGERINE },
  journey: {
    discoveredUnregisteredPaths: [],
    nonSystemAgentCount: 4,
    hasEverStartedSession: true,
    hasPostedInTeam: true,
    hasDorkBotSession: true,
  },
  digest: { finishedWhileAwayCount: 0 },
  projects: {
    activeCount: 4,
    byCwd: {
      [TANGERINE]: 'tangerine',
      [CARDAMOM]: 'cardamom',
      [SAFFRON]: 'saffron',
      [JUNIPER]: 'juniper',
    },
  },
});
