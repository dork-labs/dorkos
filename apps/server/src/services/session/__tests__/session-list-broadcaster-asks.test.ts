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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventFanOut, type FanOutClient } from '../../core/event-fan-out.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';
import { SessionListBroadcaster } from '../session-list-broadcaster.js';
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
    // Nobody is named on a single-identity install, and inventing one would be
    // the denormalization the wire shape exists to avoid.
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
    const client: FanOutClient = {
      send: (broadcast) => events.push(broadcast.event),
      bufferedBytes: 0,
      gone: false,
      drop: () => {},
    };
    registered.push(eventFanOut.addClient(client, principal));
    return { client, events };
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
