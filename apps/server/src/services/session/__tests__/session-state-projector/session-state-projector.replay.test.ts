import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionStateProjector,
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  rekeyProjector,
} from '../../session-state-projector.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { EVENT_LOG_MAX_EVENTS } from '../../replay/event-log.js';
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import { uiTurnFacts } from '../../browser-seat/ui-turn-facts.js';

describe('SessionStateProjector — replay, snapshot and subscribe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: replay over live overlap must not duplicate or skip; cursor is
  // strictly exclusive against the buffered events.
  it('replayFrom returns only events with seq greater than the cursor', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent);
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent);
    expect(p.replayFrom(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(p.replayFrom(3)).toEqual([]);
  });

  // Failure mode: multi-turn replay must not drop the prior turn's tail across
  // the ring-clear boundary — the ring holds only the new turn after
  // markTurnStarted, so a cursor predating it must fall back to the EventLog for
  // the missed seqs without losing the new turn's events (gap-free, spec §B.3).
  it('replayFrom merges ring + log so the prior turn is not dropped across a new turn', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent); // seq 2
    p.ingest({ type: 'turn_end' }); // seq 3
    p.ingest({ type: 'turn_start' }); // seq 4 (clears the ring)
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent); // seq 5

    // A client resuming at seq 1 must receive the full range, including the prior
    // turn's tail (seq 2) and its turn_end (seq 3), not just the current turn.
    expect(p.replayFrom(1).map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    // Resuming at seq 2 still includes the prior turn's turn_end (seq 3).
    expect(p.replayFrom(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    // No duplicates where the ring and log overlap on the current turn.
    expect(p.replayFrom(3).map((e) => e.seq)).toEqual([4, 5]);
  });

  // Failure mode: the snapshot must combine injected history with the live
  // projection and report the current cursor as the resume point.
  it('buildSnapshot assembles messages from the injected loader plus projection', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'live' } as RawSessionEvent);
    const history: HistoryMessage[] = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
    ];
    const snap = await p.buildSnapshot(async () => history);
    expect(snap.messages).toEqual(history);
    expect(snap.cursor).toBe(2);
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual(['turn_start', 'text_delta']);
    expect(snap.status.lifecycle).toBe('streaming');
  });

  // Failure mode: an idle session must report a null in-progress turn, not an
  // empty array, so the client distinguishes "no turn" from "empty turn".
  it('buildSnapshot reports null inProgressTurn when idle', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end' });
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn).toBeNull();
  });

  // Failure mode: snapshot-then-subscribe race — a subscriber resuming at a
  // cursor must receive the missed events (replay) then live ones, with no gaps
  // and no duplicates across the boundary.
  it('subscribe(sinceCursor) yields replay-then-live with no dup or gap', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent); // seq 2 (missed by client)

    const iter = p.subscribe(1)[Symbol.asyncIterator]();
    // First yield is the replayed seq-2 event.
    const first = await iter.next();
    expect((first.value as { seq: number }).seq).toBe(2);

    // A live event ingested after subscription must arrive next, contiguous.
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent); // seq 3
    const second = await iter.next();
    expect((second.value as { seq: number }).seq).toBe(3);
  });

  // Failure mode (I2): a parked subscriber whose AbortSignal fires (the route's
  // client-disconnect path) must remove its waiter, or the projector leaks a
  // dangling resolver per disconnect. A bare iterator.return() cannot do this —
  // it is queued behind the un-settleable parked wait — so the signal is the
  // deterministic teardown that lets the generator's finally run.
  it('subscribe(signal) removes its parked waiter when the signal aborts', async () => {
    const p = new SessionStateProjector('s1');
    const ac = new AbortController();
    const iter = p.subscribe(0, ac.signal)[Symbol.asyncIterator]();
    // First next() parks a waiter (no buffered events yet).
    const pending = iter.next();
    await Promise.resolve(); // let the generator register its waiter
    expect(p.getWaiterCount()).toBe(1);

    // Abort (what the route does on client disconnect): the parked wait resolves
    // to the ABORTED sentinel, the generator returns, and its finally splices
    // the resolver out of the waiters list.
    ac.abort();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(p.getWaiterCount()).toBe(0);

    // A subsequent ingest must not error or grow the waiter set — proving no
    // dangling resolver was left to fire against a dead generator.
    expect(() => p.ingest({ type: 'turn_start' })).not.toThrow();
    expect(p.getWaiterCount()).toBe(0);
  });

  // Failure mode (SRV-I3): the no-404 policy creates a projector for ANY
  // well-formed id a client opens `/events` for. Without self-dispose, every
  // casually-browsed session id pins an empty projector in the registry for the
  // server's lifetime (unbounded growth, hostile or not).
  it('an empty projector self-disposes from the registry when its last subscriber detaches', async () => {
    const id = 'i3-empty-self-dispose';
    const p = getOrCreateProjector(id);
    const ac = new AbortController();
    const pending = p.subscribe(0, ac.signal)[Symbol.asyncIterator]().next();
    await Promise.resolve(); // let the generator park
    ac.abort();
    await pending;
    expect(peekProjector(id)).toBeUndefined();
  });

  it('a projector with ingested events survives subscriber detach (replay state must remain)', async () => {
    const id = 'i3-live-survives';
    const p = getOrCreateProjector(id);
    p.ingest({ type: 'turn_start' });
    const ac = new AbortController();
    const pending = p.subscribe(1, ac.signal)[Symbol.asyncIterator]().next();
    await Promise.resolve();
    ac.abort();
    await pending;
    expect(peekProjector(id)).toBe(p);
    disposeProjector(id);
  });

  // Failure mode (SRV-C1): a cursor ahead of the counter means the seq space
  // was reset (server restart re-created the projector). Subscribing anyway
  // leaves the live filter dropping EVERY future event — a permanently deaf
  // client. subscribe() must reject EAGERLY (at call time) so the route can
  // fall back to the cold snapshot path.
  it('subscribe throws StaleResumeCursorError at call time for a cursor ahead of the counter', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    expect(() => p.subscribe(4523)).toThrowError(StaleResumeCursorError);
  });

  // Failure mode (SRV-C1): the EventLog trims past EVENT_LOG_MAX_EVENTS, so a
  // resume below the replay floor has a gap the buffers cannot serve — silently
  // skipping it would violate the gap-free guarantee.
  it('subscribe throws StaleResumeCursorError for a cursor below the trimmed replay floor', () => {
    const p = new SessionStateProjector('s1');
    for (let i = 0; i < EVENT_LOG_MAX_EVENTS + 10; i++) {
      p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    }
    // Oldest retained seq is 11; a cursor of 5 misses events 6..10 forever.
    expect(() => p.subscribe(5)).toThrowError(StaleResumeCursorError);
    // The exact floor (oldest - 1 = 10) is servable: every event > 10 is retained.
    expect(() => p.subscribe(10)).not.toThrow();
  });
});

describe('in-conversation MCP sign-in card (DOR-1004)', () => {
  const CARD = {
    type: 'mcp_signin_required',
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize',
    disclosure: 'DorkOS stores the token on this machine.',
  } as RawSessionEvent;

  /** Push a turn that asks for a sign-in and then ends, as the real flow does. */
  function signinTurn(p: SessionStateProjector): void {
    p.ingest({ type: 'turn_start' });
    p.ingest(CARD);
    p.ingest({ type: 'text_delta', text: 'Connecting your meeting notes.' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' });
  }

  it('keeps the card in a cold snapshot after the turn that asked for it ended', async () => {
    // The whole point of not holding the tool call: the turn ends immediately and
    // the person walks off to a browser. A tab opened while they are away — the
    // most likely moment for one to be opened — must still draw the card, and
    // `inProgressTurn` is null by then.
    const p = new SessionStateProjector('s1');
    signinTurn(p);

    const snap = await p.buildSnapshot(async () => []);

    expect(snap.inProgressTurn).toEqual([expect.objectContaining({ type: 'mcp_signin_required' })]);
    // …and nothing else from the finished turn came back with it.
    expect(snap.inProgressTurn).toHaveLength(1);
  });

  it('carries the RECEIPT through the resume turn the sign-in caused', async () => {
    // The one-turn grace, and the whole reason it exists: signing in triggers a
    // turn within about a second, and retiring the card on that turn's
    // `turn_start` erased the payoff before the person had walked back from their
    // browser. A cold hydrate mid-resume-turn must still show what was connected.
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({
      type: 'mcp_signin_resolved',
      flowId: 'flow-1',
      outcome: 'connected',
      toolCount: 7,
    } as RawSessionEvent);
    p.ingest({ type: 'turn_start' });

    const snap = await p.buildSnapshot(async () => []);

    // The PAIR travels: the card names the server, the resolution says how it
    // ended. Either alone renders the wrong thing.
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual([
      'turn_start',
      'mcp_signin_required',
      'mcp_signin_resolved',
    ]);
    expect(snap.inProgressTurn?.find((e) => e.type === 'mcp_signin_resolved')).toMatchObject({
      outcome: 'connected',
      toolCount: 7,
    });
  });
});

describe('SessionStateProjector — the registry and rekey', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: task #4/#5 must share one projector per session; the registry
  // must return the same instance and dispose must drop it.
  it('getOrCreateProjector returns one instance per session id', () => {
    const a = getOrCreateProjector('shared-session');
    const b = getOrCreateProjector('shared-session');
    expect(a).toBe(b);
    disposeProjector('shared-session');
    const c = getOrCreateProjector('shared-session');
    expect(c).not.toBe(a);
    disposeProjector('shared-session');
  });

  // Failure mode (C1): a brand-new session's turn is fed under the request UUID,
  // but the client re-keys its /events subscription to the canonical id the 202
  // returns. Without a rekey, getOrCreateProjector(canonical) mints a FRESH EMPTY
  // projector and the already-ingested turn (held under the UUID) is invisible —
  // cursor 0, empty snapshot. rekeyProjector must move the SAME instance to the
  // canonical id, preserving its cursor/snapshot, so the in-flight feed and any
  // open subscription survive (they hold the instance, not the key).
  it('rekeyProjector moves the SAME instance to the canonical id, preserving cursor/snapshot', async () => {
    const UUID = 'request-uuid';
    const CANONICAL = 'canonical-id';
    disposeProjector(UUID);
    disposeProjector(CANONICAL);

    // Drive the real flow: create under the UUID, ingest a turn (cursor 3).
    const original = getOrCreateProjector(UUID);
    original.ingest({ type: 'turn_start' });
    original.ingest({ type: 'text_delta', text: 'hi' } as RawSessionEvent);
    original.ingest({ type: 'turn_end', terminalReason: 'completed' } as RawSessionEvent);
    expect(original.getCursor()).toBe(3);

    // Re-key to the canonical id (what triggerTurn does once the id is resolved).
    rekeyProjector(UUID, CANONICAL);

    // getOrCreateProjector(canonical) now resolves to the SAME instance with the
    // full cursor and a populated snapshot — not a fresh empty one.
    const afterRekey = getOrCreateProjector(CANONICAL);
    expect(afterRekey).toBe(original);
    expect(afterRekey.getCursor()).toBe(3);
    const snap = await afterRekey.buildSnapshot(async () => []);
    expect(snap.cursor).toBe(3);

    // Still exactly ONE projector: the retired UUID redirects onto the same
    // instance rather than minting a second, empty one beside it (DOR-1262).
    // The move is a move, not a copy — both ids reach the one live projector.
    expect(getOrCreateProjector(UUID)).toBe(original);

    disposeProjector(UUID);
    disposeProjector(CANONICAL);
  });

  // Failure mode (DOR-1262, widget-round-trip eval FAIL 2026-08-16): the 202 for
  // a brand-new session carries the REQUEST UUID whenever the runtime names the
  // session after the response has gone out, so a client can hold only the
  // retired id. Under it, a second trigger minted a fresh empty projector; the
  // runtime's next re-announce of the canonical id then hit the collision branch
  // and TERMINATED the real projector — killing the live /events subscriber and
  // sending turn 2 to a projector nobody was watching.
  it('a retired id resolves to the live projector and never mints a second one', async () => {
    const UUID = 'redirect-uuid';
    const CANONICAL = 'redirect-canonical';
    const original = getOrCreateProjector(UUID);
    original.ingest({ type: 'turn_start' });
    rekeyProjector(UUID, CANONICAL);

    // Every registry lookup under the retired id lands on the live projector.
    expect(getOrCreateProjector(UUID)).toBe(original);
    expect(peekProjector(UUID)).toBe(original);
    expect(peekProjector(UUID)).toBe(peekProjector(CANONICAL));

    // A live subscriber on that projector (the /events connection the eval held
    // open under the retired id).
    let ended = false;
    const received: unknown[] = [];
    const consuming = (async () => {
      for await (const event of original.subscribe(1)) received.push(event);
      ended = true;
    })();
    await Promise.resolve();
    await Promise.resolve();

    // The runtime re-announces the SAME move — as it does on every event of the
    // next turn triggered under the retired id. It must be a no-op, not a
    // collision: nothing is displaced and nobody is terminated.
    rekeyProjector(UUID, CANONICAL);
    expect(peekProjector(CANONICAL)).toBe(original);
    expect(ended).toBe(false);

    // …and turn 2 reaches the subscriber that stayed on the retired id.
    getOrCreateProjector(UUID).ingest({ type: 'turn_start' });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    original.terminate();
    await consuming;
    disposeProjector(CANONICAL);
  });

  // Failure mode: the SDK renames a session more than once (it re-mints its
  // internal id on a resume). A chain must collapse, or the FIRST id would point
  // at an id that no longer exists and mint a fresh projector there.
  it('chains redirects: A and B both resolve to C, and disposing C forgets both', () => {
    const A = 'chain-a';
    const B = 'chain-b';
    const C = 'chain-c';
    const projector = getOrCreateProjector(A);
    projector.ingest({ type: 'turn_start' });

    rekeyProjector(A, B);
    rekeyProjector(B, C);
    expect(peekProjector(A)).toBe(projector);
    expect(peekProjector(B)).toBe(projector);
    expect(peekProjector(C)).toBe(projector);

    // A rekey announced under an already-retired id moves what that id actually
    // resolves to — it does not silently do nothing.
    const D = 'chain-d';
    rekeyProjector(A, D);
    expect(peekProjector(A)).toBe(projector);
    expect(peekProjector(C)).toBe(projector);
    expect(peekProjector(D)).toBe(projector);

    // Disposing the session clears every id that pointed at it: the redirects
    // are bounded by the live fleet, and a retired id outliving its session
    // would hand the next lookup a projector that is gone.
    disposeProjector(D);
    expect(peekProjector(A)).toBeUndefined();
    expect(peekProjector(C)).toBeUndefined();
    expect(peekProjector(D)).toBeUndefined();

    // Freed for real: a lookup under the retired id now mints a fresh instance.
    const fresh = getOrCreateProjector(A);
    expect(fresh).not.toBe(projector);
    expect(fresh.getCursor()).toBe(0);
    disposeProjector(A);
  });

  // Failure mode (DOR-1262 review): the collision branch replaces the projector
  // under `newId`, and the DISPLACED projector's own retired ids still pointed
  // there. Left behind, session 1's ids would resolve to session 2's projector —
  // one person's turn readable, and ingestible, under another's id.
  it('a displaced projector takes its retired ids with it', () => {
    const S1_UUID = 'displaced-redirect-uuid';
    const SHARED = 'displaced-redirect-target';
    const S2_UUID = 'displaced-redirect-other';

    // Session 1 is renamed onto SHARED, leaving S1_UUID → SHARED behind.
    const first = getOrCreateProjector(S1_UUID);
    first.ingest({ type: 'turn_start' });
    rekeyProjector(S1_UUID, SHARED);
    expect(peekProjector(S1_UUID)).toBe(first);

    // Session 2 collides onto the same id and wins (it holds the active turn).
    const second = getOrCreateProjector(S2_UUID);
    second.ingest({ type: 'turn_start' });
    rekeyProjector(S2_UUID, SHARED);
    expect(peekProjector(SHARED)).toBe(second);

    // Session 1's retired id must NOT now answer with session 2's projector.
    expect(peekProjector(S1_UUID)).not.toBe(second);
    expect(peekProjector(S1_UUID)).toBeUndefined();
    // Session 2 keeps its own, and its retired id follows it.
    expect(peekProjector(S2_UUID)).toBe(second);

    disposeProjector(SHARED);
  });

  it('forgets a session’s turn facts when its projector is disposed', () => {
    // The other half of the same ownership: the window those facts describe is
    // gone, so the marker must not outlive it and be read by whatever id the
    // store hands out next.
    uiTurnFacts.clear();
    getOrCreateProjector('ui-facts-dispose');
    uiTurnFacts.bindTurn('ui-facts-dispose', {
      roomTurn: { roomId: 'room-2', authorId: 'ben', turnId: 'turn-2' },
    });
    expect(uiTurnFacts.read('ui-facts-dispose').roomTurn).toBeDefined();

    disposeProjector('ui-facts-dispose');

    expect(uiTurnFacts.read('ui-facts-dispose')).toEqual({});
  });

  // Failure mode (C1 edge): a projector already under newId. The ACTIVE turn's
  // instance (oldId) must win — dropping it would orphan the in-flight feed —
  // and the stale target is replaced.
  it('rekeyProjector prefers the active turn instance when the target already exists', () => {
    const OLD = 'old-active';
    const NEW = 'new-stale';
    const active = getOrCreateProjector(OLD);
    active.ingest({ type: 'turn_start' }); // active turn under OLD
    const stale = getOrCreateProjector(NEW); // pre-existing (no active turn)
    expect(active).not.toBe(stale);

    rekeyProjector(OLD, NEW);

    // NEW now resolves to the ACTIVE turn's instance, not the stale one.
    expect(getOrCreateProjector(NEW)).toBe(active);
    disposeProjector(OLD);
    disposeProjector(NEW);
  });

  /**
   * The `ui` verbs' turn facts move with the session (spec `canvas-agent-seat`
   * §5).
   *
   * `triggerTurn` binds the room marker and the window snapshot under the id the
   * turn was DISPATCHED under — for a brand-new claude-code session, the request
   * UUID. The SDK renames the session mid-first-turn, and a `control_ui` later in
   * that same turn arrives carrying the CANONICAL id, because that is what the
   * capability context resolves. Without this line the handler finds no room
   * marker and writes the agent's PRIVATE session canvas instead of the room's
   * shared table — on the first room turn of every new session, silently, with
   * the model told it succeeded.
   *
   * Replacing the call with `void [fromId, newId];` leaves 3225 tests green, so
   * this is the test that stands between that line and a no-op.
   */
  it('carries the `ui` verbs’ turn facts across the rename', () => {
    const UUID = 'ui-facts-uuid';
    const CANONICAL = 'ui-facts-canonical';
    disposeProjector(UUID);
    disposeProjector(CANONICAL);
    uiTurnFacts.clear();

    // What the trigger binds, under the id the turn started on.
    getOrCreateProjector(UUID);
    uiTurnFacts.bindTurn(UUID, {
      roomTurn: { roomId: 'room-1', authorId: 'ana', turnId: 'turn-1' },
      uiState: {
        panels: { settings: false, tasks: true, relay: false, picker: false },
        sidebar: { open: true },
        agent: { id: null, cwd: null },
      },
    });

    rekeyProjector(UUID, CANONICAL);

    // What a `control_ui` later in the same turn asks for, by the canonical id.
    expect(uiTurnFacts.read(CANONICAL).roomTurn).toEqual({
      roomId: 'room-1',
      authorId: 'ana',
      turnId: 'turn-1',
    });
    expect(uiTurnFacts.read(CANONICAL).uiState?.panels.tasks).toBe(true);
    // …and nothing is left behind at the retired id, which would be a second
    // session's worth of marker for the store to hand out later.
    expect(uiTurnFacts.read(UUID)).toEqual({});

    disposeProjector(CANONICAL);
    uiTurnFacts.clear();
  });

  // Failure mode (DOR-782): the displaced instance is evicted from the registry
  // but its live `/events` subscribers are still parked inside it, awaiting an
  // ingest that can never come — the session is off the registry, so nothing
  // will ever feed it again. Those connections received only keepalives, forever.
  it('ENDS the displaced instance subscribers so their clients reconnect and re-snapshot', async () => {
    const OLD = 'displace-active';
    const NEW = 'displace-target';
    const active = getOrCreateProjector(OLD);
    active.ingest({ type: 'turn_start' });

    const stale = getOrCreateProjector(NEW);
    stale.ingest({ type: 'turn_start' });
    // A live subscriber, caught up and parked on the next ingest.
    const received: unknown[] = [];
    let ended = false;
    const consuming = (async () => {
      for await (const event of stale.subscribe(0)) received.push(event);
      ended = true;
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(stale.getWaiterCount()).toBe(1);
    expect(ended).toBe(false);

    rekeyProjector(OLD, NEW);
    await consuming;

    // The stream ENDED (the route then closes the SSE response and the client
    // reconnects), rather than hanging on a projector nothing can feed.
    expect(ended).toBe(true);
    expect(stale.getWaiterCount()).toBe(0);
    // Everything it had already been sent still arrived — termination ends the
    // stream, it does not rewrite history.
    expect(received).toHaveLength(1);

    // A subscriber that attaches to the retired instance afterwards likewise
    // ends immediately instead of parking forever.
    const late: unknown[] = [];
    for await (const event of stale.subscribe(1)) late.push(event);
    expect(late).toEqual([]);

    disposeProjector(OLD);
    disposeProjector(NEW);
  });
});
