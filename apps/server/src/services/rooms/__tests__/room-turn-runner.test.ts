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
    get: () => ({
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

/** The projector the stub is handed, as this file drives it. */
interface TestProjector {
  ingest: (event: Record<string, unknown>) => unknown;
}

/** What the stubbed `triggerTurn` does with the projector it is handed. */
let turnBehaviour: (opts: { sessionId: string; projector: TestProjector; content: string }) => {
  accepted: boolean;
  canonicalId?: string;
};

vi.mock('../../session/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/index.js')>()),
  triggerTurn: (opts: never) => Promise.resolve(turnBehaviour(opts)),
}));

const { createSessionRoomTurnRunner, composeRoomPrompt } = await import('../room-turn-runner.js');

let counter = 0;

/** Flush the microtasks a `run` call needs to reach its subscription. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A trigger request for a room nothing else is using.
 *
 * @param overrides - Fields to replace, plus `entryText` for the message body,
 *   which is what makes two requests compose two different prompts.
 */
function request(
  overrides: Partial<RoomTurnRequest> & { entryText?: string } = {}
): RoomTurnRequest {
  counter += 1;
  const { entryText, ...rest } = overrides;
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
    viewerAuthorId: 'human',
  } satisfies RoomWithRoster;
  const entry: RoomEntry = {
    roomId: room.id,
    seq: 1,
    id: `entry-${counter}`,
    authorId: 'human',
    kind: 'post',
    body: { text: entryText ?? 'is the build green?' },
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
    ...rest,
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
    // Named, not merely empty: a `null` on its own is what an agent with
    // nothing to say returns, and the room stayed silent about both (DOR-621).
    expect(result.unanswered).toBe('busy');
  });

  it('reports a turn that ended in an error, rather than an empty answer', async () => {
    turnBehaviour = ({ sessionId, projector }) => {
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'turn_end', terminalReason: 'error' });
      return { accepted: true, canonicalId: sessionId };
    };
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
    expect(result.unanswered).toBe('failed');
  });

  it('does not mistake a quiet turn for a failed one', async () => {
    turnBehaviour = saysAndCloses('   ');
    const result = await createSessionRoomTurnRunner().run(request());
    expect(result.text).toBeNull();
    expect(result.unanswered).toBeUndefined();
  });

  it('hands back an answer that outran the wait instead of dropping it', async () => {
    // The turn is still open when the runner returns, so `run` cannot resolve
    // before the deadline and the assertion below cannot race it.
    let finishTurn = (): void => undefined;
    turnBehaviour = ({ sessionId, projector }) => {
      projector.ingest({ type: 'turn_start' });
      finishTurn = () => {
        projector.ingest({ type: 'text_delta', text: 'green' });
        projector.ingest({ type: 'turn_end' });
      };
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner({ waitMs: () => 5 }).run(request());
    expect(result.text).toBeNull();
    expect(result.unanswered).toBeUndefined();
    expect(result.late).toBeDefined();

    finishTurn();
    const late = await result.late;
    expect(late?.text).toBe('green');
    expect(late?.unanswered).toBeUndefined();
    expect(late?.waitedMs).toBeGreaterThanOrEqual(5);
  });

  it('never posts the half of an answer it had when the wait ran out', async () => {
    // The old timeout aborted the read, so whatever had streamed by then was
    // returned as if it were the whole answer.
    let finishTurn = (): void => undefined;
    turnBehaviour = ({ sessionId, projector }) => {
      projector.ingest({ type: 'turn_start' });
      projector.ingest({ type: 'text_delta', text: 'the build is ' });
      finishTurn = () => {
        projector.ingest({ type: 'text_delta', text: 'green' });
        projector.ingest({ type: 'turn_end' });
      };
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner({ waitMs: () => 5 }).run(request());
    expect(result.text).toBeNull();

    finishTurn();
    expect((await result.late)?.text).toBe('the build is green');
  });

  it('reads its own turn, never the tail of the one already running', async () => {
    // The session write-lock lets the same room re-acquire, so a follow-up
    // message starts a second turn while the first is still streaming. Its
    // cursor sits INSIDE turn one, and anchoring on the cursor alone made it
    // break at turn one's `turn_end` and post the tail it had caught —
    // mid-sentence, and a duplicate of what turn one was already posting.
    let stream: TestProjector | undefined;
    const prompts: string[] = [];
    turnBehaviour = ({ sessionId, projector, content }) => {
      stream = projector;
      prompts.push(content);
      return { accepted: true, canonicalId: sessionId };
    };
    const runner = createSessionRoomTurnRunner();
    const shared = 'session-two-messages';

    const first = runner.run(request({ sessionId: shared }));
    await settle();
    stream?.ingest({ type: 'turn_start', userMessage: prompts[0] });
    stream?.ingest({ type: 'text_delta', text: 'the build is ' });

    // The follow-up lands mid-turn. Its cursor is now inside turn one.
    const second = runner.run(request({ sessionId: shared, entryText: 'and the tests?' }));
    await settle();

    stream?.ingest({ type: 'text_delta', text: 'green and here is why' });
    stream?.ingest({ type: 'turn_end' });
    expect((await first).text).toBe('the build is green and here is why');

    stream?.ingest({ type: 'turn_start', userMessage: prompts[1] });
    stream?.ingest({ type: 'text_delta', text: 'the tests pass' });
    stream?.ingest({ type: 'turn_end' });
    expect((await second).text).toBe('the tests pass');
  });

  it('gives up on a turn that never closes, and says the turn failed', async () => {
    turnBehaviour = ({ sessionId, projector }) => {
      projector.ingest({ type: 'turn_start' });
      return { accepted: true, canonicalId: sessionId };
    };

    const result = await createSessionRoomTurnRunner({ waitMs: () => 5, ceilingMs: () => 30 }).run(request());
    expect(result.late).toBeDefined();

    const late = await result.late;
    expect(late?.text).toBeNull();
    expect(late?.unanswered).toBe('failed');
  });

  it('writes no runtime binding for a turn that never started', async () => {
    // A ghost `session_metadata` row per failed message: `bindRoomSession` is
    // never reached, so the next trigger mints a fresh id and the dead row and
    // its projector stay forever.
    turnBehaviour = () => ({ accepted: false });
    await createSessionRoomTurnRunner().run(request());
    expect(persistSessionRuntime).not.toHaveBeenCalled();

    turnBehaviour = () => {
      throw new Error('runtime is down');
    };
    await expect(createSessionRoomTurnRunner().run(request())).rejects.toThrow('runtime is down');
    expect(persistSessionRuntime).not.toHaveBeenCalled();
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
