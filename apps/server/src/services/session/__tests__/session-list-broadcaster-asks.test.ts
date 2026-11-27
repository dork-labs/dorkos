/**
 * The Ask on the global stream: two events per parked turn, and the room joined
 * onto the first of them (DOR-1330).
 *
 * This is the seam between the projector — which knows a prompt was raised and
 * nothing about transports — and the fan-out every window reads. What it pins:
 *
 * - one `interaction_pending` per prompt, carrying the DTO verbatim, and the
 *   room only when the ledger says a room owns that session;
 * - the ORDERING the whole feature rests on: the global event goes out before
 *   the per-session event is logged, so a client attaching a moment later
 *   cannot see the prompt in the session stream before the fleet heard about
 *   it;
 * - exactly one `interaction_resolved` per resolution, whatever a second
 *   window clicks afterwards.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Notify before `this.interactions.set` in `trackInteraction` → "before the
 *   per-session event is even logged" still passes but the projector-level
 *   ordering case goes red; drop the notify entirely → every case here goes red.
 * - Drop the `roomBindings` join → "names the room a session answers for" goes
 *   red with `roomId` undefined.
 * - Drop the `resolvedBy` spread from `broadcastInteraction` → "carries the name
 *   of whoever answered onto the wire" goes red and the unnamed case stays
 *   green, which is the pair that tells a relay from an invention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import { eventFanOut, type FanOutClient } from '../../core/event-fan-out.js';
import type { PersonPrincipal } from '../../../lib/caller-principal.js';
import {
  SessionListBroadcaster,
  sendSessionStatusSnapshot,
} from '../catalog/session-list-broadcaster.js';
import { disposeProjector, getOrCreateProjector, type RawSessionEvent } from '../index.js';
import { projectRegistry } from '../../projects/project-registry.js';
import { setSessionListSpaceView } from '../catalog/session-list-space-view.js';
import { wireSessionListSpaceView } from '../../../startup/space-views.js';

const TIMEOUT_MS = 10 * 60 * 1000;
const ROOM_SESSION = 'broadcast-room-session';
const LONE_SESSION = 'broadcast-lone-session';
/** A person's own chat (spec `audit-trail` §3.4): its person reads it, whoever is connecting as them. */
const PRIVATE_SESSION = '44444444-4444-4444-8444-444444444444';

/** Every broadcast this case produced, in order. */
let broadcasts: Array<{ name: string; payload: unknown }>;
let broadcaster: SessionListBroadcaster;

beforeEach(() => {
  broadcasts = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name: string, payload: unknown) => {
    broadcasts.push({ name, payload });
  });
  broadcaster = new SessionListBroadcaster();
  broadcaster.setRoomBindings({
    bindingForSession: (sessionId) =>
      sessionId === ROOM_SESSION ? { roomId: 'room-7', authorId: 'author-ana' } : undefined,
  });
  // No runtimes: the discovery half is not what this file is about, and the
  // projector subscriptions install regardless — which is itself the contract
  // that a failed watcher must not cost a person their prompts.
  broadcaster.start([]);
  // What startup hands the stream: the space side's audience and project lookup.
  wireSessionListSpaceView();
});

afterEach(async () => {
  await broadcaster.stop();
  setSessionListSpaceView(undefined);
  vi.restoreAllMocks();
  disposeProjector(ROOM_SESSION);
  disposeProjector(LONE_SESSION);
});

/**
 * A tool the session has just started, which is what fills `status.activity`.
 *
 * @param toolName - As the runtime spells it.
 * @param input - The tool input the target is derived from.
 */
function runningTool(toolName: string, input: Record<string, unknown>): RawSessionEvent {
  return {
    type: 'tool_call',
    toolCallId: `tc-${toolName}`,
    toolName,
    status: 'running',
    input: JSON.stringify(input),
  } as RawSessionEvent;
}

/** Park a session on a permission prompt, as a runtime does. */
function park(sessionId: string, cwd: string, id: string): void {
  getOrCreateProjector(sessionId, cwd).ingest({
    type: 'approval_required',
    id,
    startedAt: Date.now(),
    remainingMs: TIMEOUT_MS,
    timeoutMs: TIMEOUT_MS,
    toolName: 'Bash',
    input: JSON.stringify({ command: 'pnpm verify' }),
    hasSuggestions: false,
  } as unknown as RawSessionEvent);
}

/** Just the Ask events, so a `session_status` alongside them is not noise. */
function askEvents(): Array<{ name: string; payload: Record<string, unknown> }> {
  return broadcasts.filter(
    (event) => event.name === 'interaction_pending' || event.name === 'interaction_resolved'
  ) as Array<{ name: string; payload: Record<string, unknown> }>;
}

describe('the Ask on the global stream', () => {
  it('names the room a session answers for, and leaves it off one that answers for none', () => {
    park(ROOM_SESSION, '/work/alpha', 'tc-1');
    park(LONE_SESSION, '/work/beta', 'tc-2');

    const [inRoom, alone] = askEvents();
    expect(inRoom).toMatchObject({
      name: 'interaction_pending',
      payload: {
        sessionId: ROOM_SESSION,
        cwd: '/work/alpha',
        roomId: 'room-7',
        roomAuthorId: 'author-ana',
        interaction: { id: 'tc-1', type: 'approval', toolName: 'Bash' },
      },
    });
    expect(alone!.payload).not.toHaveProperty('roomId');
  });

  it('stamps the project the registry already knows, and leaves it off one it does not (§6.2)', () => {
    vi.spyOn(projectRegistry, 'peek').mockImplementation((cwd) =>
      cwd === '/work/alpha'
        ? { root: '/work/alpha', name: 'alpha' }
        : cwd === '/work/plain'
          ? null
          : undefined
    );
    park(ROOM_SESSION, '/work/alpha', 'tc-1');
    park(LONE_SESSION, '/work/plain', 'tc-2');

    const [known, noProject] = askEvents();
    expect(known!.payload.project).toEqual({ root: '/work/alpha', name: 'alpha' });
    expect(noProject!.payload.project).toBeNull();

    disposeProjector(LONE_SESSION);
    park(LONE_SESSION, '/work/unresolved', 'tc-3');
    // Not resolved yet: no guess on the wire; the pending list's read fills it in.
    expect(askEvents().at(-1)!.payload).not.toHaveProperty('project');
  });

  it('goes out before the per-session event is even logged', () => {
    // The ordering the feature rests on. A client that attaches a moment after
    // the prompt is raised replays the session's own stream; if the global
    // event lagged that, the fleet would learn about a prompt the session had
    // already been carrying.
    const projector = getOrCreateProjector(ROOM_SESSION, '/work/alpha');
    let replayableWhenBroadcast: number | undefined;
    vi.mocked(eventFanOut.broadcast).mockImplementation((name: string, payload: unknown) => {
      broadcasts.push({ name, payload });
      if (name === 'interaction_pending') {
        replayableWhenBroadcast = projector
          .replayFrom(0)
          .filter((event) => event.type === 'approval_required').length;
      }
    });

    park(ROOM_SESSION, '/work/alpha', 'tc-1');

    expect(replayableWhenBroadcast).toBe(0);
    expect(projector.replayFrom(0).filter((e) => e.type === 'approval_required')).toHaveLength(1);
  });

  it('says a prompt is over exactly once, however many windows click', () => {
    park(ROOM_SESSION, '/work/alpha', 'tc-1');
    const projector = getOrCreateProjector(ROOM_SESSION, '/work/alpha');

    projector.resolveInteraction('tc-1', 'approved');
    // A second window, a moment late, on a card it has not dropped yet.
    projector.resolveInteraction('tc-1', 'approved');

    const resolved = askEvents().filter((event) => event.name === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toMatchObject({
      sessionId: ROOM_SESSION,
      interactionId: 'tc-1',
      outcome: 'answered',
    });
    expect(typeof resolved[0]!.payload.resolvedAt).toBe('string');
    // Nobody was named on the way in, so nobody is named on the way out. This
    // module never fills the field itself — it has no caller to name.
    expect(resolved[0]!.payload).not.toHaveProperty('resolvedBy');
  });

  it('carries the name of whoever answered onto the wire', () => {
    park(ROOM_SESSION, '/work/alpha', 'tc-1');
    const projector = getOrCreateProjector(ROOM_SESSION, '/work/alpha');

    projector.resolveInteraction('tc-1', 'approved', { answeredBy: 'Ada' });

    const resolved = askEvents().filter((event) => event.name === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toMatchObject({
      sessionId: ROOM_SESSION,
      interactionId: 'tc-1',
      outcome: 'answered',
      resolvedBy: 'Ada',
    });
  });

  it('names nobody when a parked turn is torn down under the prompt', () => {
    // A cancellation is the clock's answer, not a person's. Naming the last
    // person who happened to answer anything here would put "Already answered
    // by Ada" over a card nobody ever saw.
    park(ROOM_SESSION, '/work/alpha', 'tc-1');
    const projector = getOrCreateProjector(ROOM_SESSION, '/work/alpha');
    projector.ingest({ type: 'turn_start' } as unknown as RawSessionEvent);

    projector.markInterrupted();

    const resolved = askEvents().filter((event) => event.name === 'interaction_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.payload).toMatchObject({ interactionId: 'tc-1', outcome: 'cancelled' });
    expect(resolved[0]!.payload).not.toHaveProperty('resolvedBy');
  });

  it('stops carrying the Ask once the broadcaster is stopped', async () => {
    await broadcaster.stop();

    park(ROOM_SESSION, '/work/alpha', 'tc-1');

    expect(askEvents()).toEqual([]);
  });
});

describe('who the Ask actually reaches on the wire', () => {
  /** One recording connection, and what it was written. */
  interface Reader {
    client: FanOutClient;
    events: string[];
    frames: { type: string; payload: Record<string, unknown> }[];
  }

  /** Everything registered here, so the singleton is left as it was found. */
  let registered: Array<() => void>;

  /**
   * Register a recording connection on the real fan-out.
   *
   * These cases deliberately do NOT stub `broadcast` — the audience is applied
   * inside it, so a stub would be asserting the stub. This is the only place
   * the whole path is exercised: a projector parks a turn, the broadcaster
   * addresses the frame, and the fan-out decides who it is written to.
   *
   * @param principal - Who this connection is.
   */
  function reader(principal: PersonPrincipal): Reader {
    const events: string[] = [];
    const frames: { type: string; payload: Record<string, unknown> }[] = [];
    const client: FanOutClient = {
      send: (broadcast) => {
        events.push(broadcast.event);
        frames.push(
          JSON.parse(broadcast.json) as { type: string; payload: Record<string, unknown> }
        );
      },
      bufferedBytes: 0,
      gone: false,
      drop: () => {},
    };
    registered.push(eventFanOut.addClient(client, principal));
    return { client, events, frames };
  }

  /**
   * The `status` of the last `session_status` frame this reader was written.
   *
   * @param who - The recording connection.
   */
  function lastStatus(who: Reader): Record<string, unknown> | undefined {
    const last = who.frames.filter((f) => f.type === 'session_status').at(-1);
    return last?.payload.status as Record<string, unknown> | undefined;
  }

  beforeEach(() => {
    registered = [];
    // The outer suite stubs `broadcast`; these cases need the real one.
    vi.mocked(eventFanOut.broadcast).mockRestore();
  });

  afterEach(() => {
    for (const unregister of registered) unregister();
    disposeProjector(PRIVATE_SESSION);
  });

  /** The two kinds of reader the stream admits: the app, and a program with a key. */
  const PEOPLE: readonly PersonPrincipal[] = [
    { kind: 'operator' },
    { kind: 'program', userId: 'user_owner' },
  ];

  it('tells every person about their own chat: its status, its Ask and its title', async () => {
    const readers = PEOPLE.map(reader);

    const projector = getOrCreateProjector(PRIVATE_SESSION, '/work/me');
    projector.ingest({ type: 'turn_start' });
    park(PRIVATE_SESSION, '/work/me', 'tc-9');
    projector.resolveInteraction('tc-9', 'approved');
    // An upsert carries the title, through a runtime's own list stream.
    const listed = new SessionListBroadcaster();
    const upsert = {
      type: 'session_upserted' as const,
      session: createMockSession({ id: PRIVATE_SESSION, title: 'Thinking aloud' }),
    };
    listed.start([
      {
        type: 'fake',
        getInternalSessionId: () => undefined,
        subscribeSessionList: () => ({
          async *[Symbol.asyncIterator]() {
            yield upsert;
          },
        }),
      } as never,
    ]);
    for (const who of readers) {
      await vi.waitFor(() => expect(who.events).toContain('session_upserted'));
      expect(who.events).toEqual(
        expect.arrayContaining(['session_status', 'interaction_pending', 'interaction_resolved'])
      );
    }
    await listed.stop();
  });

  it('writes what a BLOCKED session is waiting on to every person, live and on connect', () => {
    // Only people read this stream (DOR-4986), and every person may see an Ask,
    // so nothing is withheld from either kind of reader.
    const readers = PEOPLE.map(reader);
    getOrCreateProjector(LONE_SESSION, '/work/beta').ingest(
      runningTool('Bash', { command: 'rm -rf /work/beta/build' })
    );
    park(LONE_SESSION, '/work/beta', 'tc-1');

    const blocked = {
      lifecycle: 'blocked',
      activity: { toolName: 'Bash', target: 'rm -rf /work/beta/build' },
    };
    for (const who of readers) {
      expect(who.events).toContain('interaction_pending');
      expect(lastStatus(who)).toMatchObject(blocked);
    }
    for (const principal of PEOPLE) {
      const fresh = reader(principal);
      sendSessionStatusSnapshot(fresh.client, principal);
      expect(lastStatus(fresh), principal.kind).toMatchObject(blocked);
    }
  });
});
