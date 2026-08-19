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
import { eventFanOut, type FanOutClient } from '../../core/event-fan-out.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import { SessionListBroadcaster, sendSessionStatusSnapshot } from '../session-list-broadcaster.js';
import { disposeProjector, getOrCreateProjector, type RawSessionEvent } from '../index.js';

const TIMEOUT_MS = 10 * 60 * 1000;
const ROOM_SESSION = 'broadcast-room-session';
const LONE_SESSION = 'broadcast-lone-session';

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
});

afterEach(async () => {
  await broadcaster.stop();
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
    frames: { event: string; data: Record<string, unknown> }[];
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
  function reader(principal: CallerPrincipal): Reader {
    const events: string[] = [];
    const frames: { event: string; data: Record<string, unknown> }[] = [];
    const client: FanOutClient = {
      send: (broadcast) => {
        events.push(broadcast.event);
        frames.push(JSON.parse(broadcast.json) as { event: string; data: Record<string, unknown> });
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
    const last = who.frames.filter((f) => f.event === 'session_status').at(-1);
    return last?.data.status as Record<string, unknown> | undefined;
  }

  beforeEach(() => {
    registered = [];
    // The outer suite stubs `broadcast`; these cases need the real one.
    vi.mocked(eventFanOut.broadcast).mockRestore();
  });

  afterEach(() => {
    for (const unregister of registered) unregister();
  });

  it('writes an Ask to the cockpit’s connection and not to an agent’s', () => {
    const cockpit = reader({ kind: 'operator' });
    const agent = reader({ kind: 'agent' });

    park(LONE_SESSION, '/work/beta', 'tc-1');

    expect(cockpit.events).toContain('interaction_pending');
    expect(agent.events, 'an agent reads no other agent’s pending command').not.toContain(
      'interaction_pending'
    );
  });

  it('withholds a room-bound Ask from an agent too', () => {
    const cockpit = reader({ kind: 'operator' });
    const agent = reader({ kind: 'agent' });

    park(ROOM_SESSION, '/work/alpha', 'tc-1');

    expect(cockpit.events).toContain('interaction_pending');
    expect(agent.events).not.toContain('interaction_pending');
  });

  it('withholds what a BLOCKED session is waiting on, while still saying it is blocked', () => {
    // `SessionStatus.activity` carries the tool and the command's first line,
    // and the projector keeps it current into `blocked` — so this frame said
    // everything `interaction_pending` was addressed to withhold. The lifecycle
    // itself is not detail and is still sent, or an unentitled reader's view of
    // the session would silently stick on its previous state.
    const cockpit = reader({ kind: 'operator' });
    const agent = reader({ kind: 'agent' });

    getOrCreateProjector(LONE_SESSION, '/work/beta').ingest(
      runningTool('Bash', { command: 'rm -rf /work/beta/build' })
    );
    park(LONE_SESSION, '/work/beta', 'tc-1');

    expect(lastStatus(cockpit)).toMatchObject({
      lifecycle: 'blocked',
      activity: { toolName: 'Bash', target: 'rm -rf /work/beta/build' },
    });
    expect(lastStatus(agent)).toMatchObject({ lifecycle: 'blocked' });
    expect(lastStatus(agent), 'no tool and no command reaches an agent').not.toHaveProperty(
      'activity'
    );
  });

  it('leaves a WORKING session’s activity alone for both, which is a different fact', () => {
    // A tool that is RUNNING is not a person being asked for anything, and
    // narrowing that is not this spec's to do — stated so the asymmetry is a
    // decision rather than an oversight.
    const cockpit = reader({ kind: 'operator' });
    const agent = reader({ kind: 'agent' });

    const projector = getOrCreateProjector(LONE_SESSION, '/work/beta');
    projector.ingest({ type: 'turn_start' });
    projector.ingest(runningTool('Bash', { command: 'pnpm verify' }));

    expect(lastStatus(cockpit)).toMatchObject({ activity: { toolName: 'Bash' } });
    expect(lastStatus(agent)).toMatchObject({ activity: { toolName: 'Bash' } });
  });

  describe('the connect preamble applies the same rule', () => {
    // The live path addresses these frames; a snapshot that did not would be
    // the hole, because a window that connects a second after a turn parks
    // learns the state from HERE and not from a transition.
    /**
     * Run the preamble against a fresh recording client.
     *
     * @param principal - Who is connecting.
     */
    function preamble(principal: CallerPrincipal): Record<string, unknown> | undefined {
      const who = reader(principal);
      sendSessionStatusSnapshot(who.client, principal);
      return lastStatus(who);
    }

    it('omits a blocked session’s activity for an agent, and keeps it for the operator', () => {
      getOrCreateProjector(LONE_SESSION, '/work/beta').ingest(
        runningTool('Bash', { command: 'rm -rf /work/beta/build' })
      );
      park(LONE_SESSION, '/work/beta', 'tc-1');

      expect(preamble({ kind: 'operator' })).toMatchObject({
        lifecycle: 'blocked',
        activity: { toolName: 'Bash', target: 'rm -rf /work/beta/build' },
      });
      const forAgent = preamble({ kind: 'agent' });
      expect(forAgent).toMatchObject({ lifecycle: 'blocked' });
      expect(forAgent).not.toHaveProperty('activity');
    });

    it('keeps a STREAMING session’s activity for an agent, which is not an Ask', () => {
      const projector = getOrCreateProjector(LONE_SESSION, '/work/beta');
      projector.ingest({ type: 'turn_start' });
      projector.ingest(runningTool('Bash', { command: 'pnpm verify' }));

      expect(preamble({ kind: 'agent' })).toMatchObject({
        lifecycle: 'streaming',
        activity: { toolName: 'Bash', target: 'pnpm verify' },
      });
    });
  });

  it('sends the receipt to BOTH, because it names no tool, no path and no command', () => {
    // Decision 9, pinned rather than left as prose: address
    // `interaction_resolved` too and this goes red. A client that never got the
    // `pending` simply has nothing to close.
    const cockpit = reader({ kind: 'operator' });
    const agent = reader({ kind: 'agent' });
    park(LONE_SESSION, '/work/beta', 'tc-1');

    getOrCreateProjector(LONE_SESSION, '/work/beta').resolveInteraction('tc-1', 'approved');

    expect(cockpit.events).toContain('interaction_resolved');
    expect(agent.events).toContain('interaction_resolved');
  });
});
