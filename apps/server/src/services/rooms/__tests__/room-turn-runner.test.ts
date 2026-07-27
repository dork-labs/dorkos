/**
 * The production runner: a room trigger becomes a real session turn.
 *
 * `triggerTurn` is the only thing stubbed, and only because a real one needs a
 * model. The projector is the REAL projector — which is the point, because the
 * claim this file checks is that a room reads the agent's answer off the same
 * stream a client renders from, gap-free from a cursor taken before the turn.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomTurnRequest } from '../room-trigger.js';

const persistSessionRuntime = vi.fn().mockResolvedValue(true);
const getCapabilities = vi.fn().mockReturnValue({ logBackedHistory: false, nativeContext: [] });

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    persistSessionRuntime: (...args: unknown[]) => persistSessionRuntime(...args),
    resolveForSession: () =>
      Promise.resolve({
        getCapabilities: () => getCapabilities(),
        acquireLock: () => true,
        releaseLock: () => undefined,
        sendMessage: () => undefined,
        interruptQuery: () => Promise.resolve(false),
        getInternalSessionId: () => undefined,
      }),
    has: () => true,
    getDefaultType: () => 'claude-code',
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: () => Promise.resolve(null) }));

/** What the stubbed `triggerTurn` does with the projector it is handed. */
let turnBehaviour: (opts: {
  sessionId: string;
  projector: { ingest: (event: Record<string, unknown>) => unknown };
}) => { accepted: boolean; canonicalId?: string };

vi.mock('../../session/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/index.js')>()),
  triggerTurn: (opts: never) => Promise.resolve(turnBehaviour(opts)),
}));

const { createSessionRoomTurnRunner, composeRoomPrompt } = await import('../room-turn-runner.js');

let counter = 0;

/** A trigger request for a room nothing else is using. */
function request(overrides: Partial<RoomTurnRequest> = {}): RoomTurnRequest {
  counter += 1;
  const room = {
    id: `room-${counter}`,
    kind: 'channel',
    parentId: null,
    slug: 'backend',
    title: 'Backend',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-26T10:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: [],
  } satisfies RoomWithRoster;
  const entry: RoomEntry = {
    roomId: room.id,
    seq: 1,
    id: `entry-${counter}`,
    authorId: 'human',
    kind: 'post',
    body: { text: 'is the build green?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${counter}`,
    cascadeDepth: 0,
    signature: null,
    createdAt: room.createdAt,
  };
  return {
    room,
    authorId: 'author-ana',
    agentPath: '/repo/ana',
    displayName: 'Ana',
    sessionId: null,
    entry,
    authorName: 'Dorian',
    ...overrides,
  };
}

/** A turn that streams `parts` and closes cleanly. */
function saysAndCloses(...parts: string[]): typeof turnBehaviour {
  return ({ sessionId, projector }) => {
    projector.ingest({ type: 'turn_start' });
    for (const text of parts) projector.ingest({ type: 'text_delta', text });
    projector.ingest({ type: 'turn_end' });
    return { accepted: true, canonicalId: sessionId };
  };
}

describe('createSessionRoomTurnRunner', () => {
  beforeEach(() => {
    persistSessionRuntime.mockClear();
    turnBehaviour = saysAndCloses('green');
  });

  it('returns what the agent said, read off the session stream', async () => {
    turnBehaviour = saysAndCloses('Green', ' — ', 'nothing failed.');
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBe('Green — nothing failed.');
  });

  it('mints a session on the first answer and reuses the bound one after', async () => {
    const runner = createSessionRoomTurnRunner();

    const first = await runner.run(request());
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const second = await runner.run(request({ sessionId: 'session-already-bound' }));
    expect(second.sessionId).toBe('session-already-bound');
    // The runtime binding is written on every turn; it is INSERT-OR-IGNORE at
    // the registry, so the first write wins and a second one changes nothing.
    expect(persistSessionRuntime).toHaveBeenLastCalledWith(
      'session-already-bound',
      'claude-code',
      '/repo/ana'
    );
  });

  it('says nothing rather than queueing behind an operator who is mid-turn', async () => {
    turnBehaviour = () => ({ accepted: false });
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
  });

  it('treats an empty turn as nothing to post', async () => {
    turnBehaviour = saysAndCloses('   ');
    expect((await createSessionRoomTurnRunner().run(request())).text).toBeNull();
  });

  it('stops at the turn boundary rather than swallowing the next turn', async () => {
    turnBehaviour = ({ sessionId, projector }) => {
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'text_delta', text: 'first' });
      projector.ingest({ type: 'turn_end' });
      // Whatever happens on this session afterwards is not this room's answer.
      projector.ingest({ type: 'text_delta', text: 'second' });
      return { accepted: true, canonicalId: sessionId };
    };
    expect((await createSessionRoomTurnRunner().run(request())).text).toBe('first');
  });
});

describe('composeRoomPrompt', () => {
  it('names the room, the speaker, and where the answer goes', () => {
    const prompt = composeRoomPrompt(request());
    expect(prompt).toContain('#backend');
    expect(prompt).toContain('Dorian');
    expect(prompt).toContain('is the build green?');
    // The behavior-changing part: this is not a private answer.
    expect(prompt).toContain('everyone in the room reads it');
  });

  it('falls back to the title for a room with no slug', () => {
    const dm = request();
    const prompt = composeRoomPrompt({
      ...dm,
      room: { ...dm.room, kind: 'dm', slug: null, title: 'Ana' },
    });
    expect(prompt).toContain('Ana');
    expect(prompt).not.toContain('#');
  });
});
