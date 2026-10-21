/**
 * A working morning: three agents running, people and agents to answer, a
 * muted channel with a mention in it, and one agent kept in reach by a pin.
 *
 * What this fixture is for: an agent's direct message drawn as the agent, a
 * conversation with people drawn as a room, the pinned agent with no direct
 * message yet, the agents left in the Directory, live marks, and mute with the
 * one exception a mention makes to it.
 *
 * **Read it, never edit it** — see `first-run.ts` for why.
 *
 * @module features/dashboard-sidebar/model/fixtures/busy
 */
import type { SidebarState } from '../sidebar-state';
import { agent, agentDm, emptyState, person, prefs, room, session } from './factories';

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
    session({ id: 'ses-3', title: 'Port the codex adapter', cwd: SAFFRON }),
    session({ id: 'ses-5', title: 'Chase the flaky room test', cwd: CARDAMOM }),
    session({ id: 'ses-auto-1', title: 'Nightly digest', cwd: TANGERINE, origin: 'task' }),
  ],
  workingSessionIds: ['ses-1', 'ses-3', 'ses-5', 'ses-auto-1'],
  rooms: [
    room({ id: 'room-team', kind: 'channel', title: 'team', wellKnown: 'team', unreadCount: 4 }),
    room({ id: 'room-releases', kind: 'channel', title: 'releases', unreadCount: 1 }),
    room({ id: 'room-design', kind: 'channel', title: 'design' }),
    room({ id: 'room-noise', kind: 'channel', title: 'noise', unreadCount: 31 }),
    agentDm('dm-cardamom', CARDAMOM, 'cardamom', { unreadCount: 2 }),
    agentDm('dm-saffron', SAFFRON, 'saffron'),
    room({
      id: 'dm-priya',
      kind: 'dm',
      title: 'Priya',
      unreadCount: 2,
      participants: [person('person:dorian', 'Dorian'), person('person:priya', 'Priya')],
    }),
    room({
      id: 'dm-kai',
      kind: 'dm',
      title: 'Kai',
      participants: [person('person:dorian', 'Dorian'), person('person:kai', 'Kai')],
    }),
  ],
  mentions: { 'room-noise': 1 },
  prefs: prefs({
    muted: [{ kind: 'room', roomId: 'room-noise' }],
    pinned: [{ kind: 'agent', path: TANGERINE }],
  }),
  activeTarget: { kind: 'session', sessionId: 'ses-1', agentPath: TANGERINE, cwd: TANGERINE },
});
