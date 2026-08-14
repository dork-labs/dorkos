/**
 * The production welcome-back work source — what counts as news, read off
 * session state (spec `team-room-home` D5.2, task 4.4).
 *
 * The greeter's own tests substitute a source, which is what lets them prove
 * the caps without a runtime anywhere near them. This file is the other half:
 * the real reader, over `FakeAgentRuntime` fixtures, proving the four
 * exclusions it makes and the two facts it reports.
 *
 * **Every exclusion here is about honesty, not tidiness.** A session that moved
 * before the person left is not news; a turn an agent ran in a room is already
 * on the screen they are reading this on; an agent that did nothing is ABSENT
 * rather than reported with a zero, because `sessions: 0` would be a line
 * saying nothing happened, which is exactly the noise the feature exists to
 * avoid.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import type { RoomStore } from '../../room-store.js';
import { createSessionWorkSource } from '../welcome-back-work.js';
import type { WelcomeBackWorkSource } from '../welcome-back.js';
import { agentLookupFor, createRoomHarness } from '../../__tests__/room-test-harness.js';

const TANGERINES = '/agents/tangerines';
const ANA = '/agents/ana';

const agents = agentLookupFor({
  [TANGERINES]: { name: 'tangerines', displayName: 'tangerines' },
  [ANA]: { name: 'ana', displayName: 'Ana' },
});

/** The instant the person was last seen. Everything else is placed around it. */
const LEFT_AT = '2026-08-08T05:00:00.000Z';
const BEFORE = '2026-08-08T04:59:59.999Z';
const AT = LEFT_AT;
const AFTER = '2026-08-08T06:00:00.000Z';
const LATER = '2026-08-08T07:30:00.000Z';

/** One session, as a runtime reports it. */
function session(over: Partial<Session> & { id: string; updatedAt: string }): Session {
  return {
    title: `Session ${over.id}`,
    createdAt: '2026-08-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'fake',
    cwd: TANGERINES,
    ...over,
  };
}

/** A runtime that answers `listSessions` from a fixture table, keyed by directory. */
function runtimeReturning(byDir: Record<string, Session[]>): AgentRuntime {
  const runtime = new FakeAgentRuntime('fake');
  runtime.listSessions.mockImplementation((dir: string) => Promise.resolve(byDir[dir] ?? []));
  return runtime;
}

describe('what the welcome-back source counts as news', () => {
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let room: RoomWithRoster;
  let human: string;
  let tangerines: string;
  let ana: string;

  beforeEach(() => {
    ({ service, store, authors, human } = createRoomHarness({ agents }));
    room = service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: [TANGERINES, ANA] },
      human
    );
    tangerines = authors.resolveAgent(TANGERINES, 'tangerines').id;
    ana = authors.resolveAgent(ANA, 'Ana').id;
  });

  /** The source under test, reading through the harness's own room. */
  function sourceOver(byDir: Record<string, Session[]>): WelcomeBackWorkSource {
    return createSessionWorkSource({
      store,
      authors,
      runtimes: () => [runtimeReturning(byDir)],
    });
  }

  it('counts a session that moved after the person left, and not one that moved before', async () => {
    const source = sourceOver({
      [TANGERINES]: [
        session({ id: 'old', updatedAt: BEFORE }),
        session({ id: 'new', updatedAt: AFTER }),
      ],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ authorId: tangerines, sessions: 1, lastActiveAt: AFTER });
  });

  it('is strict at the boundary: a session that moved as they left is not news', async () => {
    const source = sourceOver({ [TANGERINES]: [session({ id: 'exactly-then', updatedAt: AT })] });

    // They were still here at that instant, so the work happened in front of
    // them. One millisecond later is the first thing they missed.
    expect(await source.since({ roomId: room.id, since: LEFT_AT })).toEqual([]);
  });

  it('leaves out a turn the agent ran in a room, because it is already in the room', async () => {
    store.bindRoomSession(room.id, tangerines, 'room-turn', AFTER);
    const source = sourceOver({
      [TANGERINES]: [
        session({ id: 'room-turn', updatedAt: LATER }),
        session({ id: 'real-work', updatedAt: AFTER }),
      ],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work).toHaveLength(1);
    // The room turn is the NEWER of the two, so a source that counted it would
    // report the wrong instant as well as the wrong number.
    expect(work[0]).toMatchObject({ sessions: 1, lastActiveAt: AFTER });
  });

  it('leaves out a session that belongs to no working directory', async () => {
    const source = sourceOver({
      [TANGERINES]: [
        session({ id: 'ghost', updatedAt: LATER, cwd: undefined }),
        session({ id: 'real-work', updatedAt: AFTER }),
      ],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ sessions: 1, lastActiveAt: AFTER });
  });

  it('counts every session one agent moved, and reports the latest of them', async () => {
    const source = sourceOver({
      [TANGERINES]: [
        session({ id: 'first', updatedAt: AFTER, title: 'Fix the flaky watcher test' }),
        session({ id: 'second', updatedAt: LATER, title: 'Open the release PR' }),
      ],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work).toEqual([
      {
        authorId: tangerines,
        agentPath: TANGERINES,
        sessions: 2,
        lastActiveAt: LATER,
        latestTitle: 'Open the release PR',
      },
    ]);
  });

  it('omits an agent that did nothing rather than reporting a zero for it', async () => {
    const source = sourceOver({
      [TANGERINES]: [session({ id: 'real-work', updatedAt: AFTER })],
      [ANA]: [session({ id: 'anas-old-work', updatedAt: BEFORE, cwd: ANA })],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work.map((entry) => entry.authorId)).toEqual([tangerines]);
    expect(work.some((entry) => entry.authorId === ana)).toBe(false);
  });

  it('says a session has no title rather than quoting an empty one', async () => {
    const source = sourceOver({
      [TANGERINES]: [session({ id: 'untitled', updatedAt: AFTER, title: '   ' })],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work[0]?.latestTitle).toBeNull();
  });

  it('reads nothing at all when no runtime can answer', async () => {
    const source = createSessionWorkSource({ store, authors, runtimes: () => [] });

    expect(await source.since({ roomId: room.id, since: LEFT_AT })).toEqual([]);
  });

  it('asks about the agents in the room and nobody else', async () => {
    const outsider = '/agents/somebody-elses-agent';
    const source = sourceOver({
      [TANGERINES]: [session({ id: 'real-work', updatedAt: AFTER })],
      [outsider]: [session({ id: 'not-on-your-team', updatedAt: LATER, cwd: outsider })],
    });

    const work = await source.since({ roomId: room.id, since: LEFT_AT });

    expect(work.map((entry) => entry.agentPath)).toEqual([TANGERINES]);
  });
});
