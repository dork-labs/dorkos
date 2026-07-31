import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { SessionStateProjector } from '../session-state-projector.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import { SessionEventStore } from '../session-event-store.js';
import { reconstructHistoryFromEvents } from '../event-log-history.js';

/** Drive one complete turn (turn_start → text_delta → turn_end) into a projector. */
function driveTurn(projector: SessionStateProjector, userMessage: string, text: string): void {
  projector.ingest({ type: 'turn_start', userMessage } as RawSessionEvent);
  projector.ingest({ type: 'text_delta', text } as RawSessionEvent);
  projector.ingest({ type: 'turn_end' } as RawSessionEvent);
}

describe('SessionStateProjector durable persistence (DOR-189)', () => {
  it('flushes exactly one turn on turn_end and nothing mid-turn', () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('s1');
    projector.enablePersistence(store);

    projector.ingest({ type: 'turn_start', userMessage: 'hi' } as RawSessionEvent);
    projector.ingest({ type: 'text_delta', text: 'streaming…' } as RawSessionEvent);
    // Mid-turn: nothing durable yet.
    expect(store.readAll('s1')).toEqual([]);

    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    // On turn_end: the whole turn is flushed, once.
    const persisted = store.readAll('s1');
    expect(persisted.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'turn_end']);
    expect(persisted.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('does NOT flush a degenerate turn_end with no open turn', () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('s1');
    projector.enablePersistence(store);

    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    expect(store.readAll('s1')).toEqual([]);
  });

  it('a throwing store does not break ingest — the event still streams', () => {
    const throwingStore = {
      appendTurn: vi.fn(() => {
        throw new Error('disk full');
      }),
      readAll: vi.fn(() => [] as SessionEvent[]),
      maxSeq: vi.fn(() => 0),
      trim: vi.fn(),
    } as unknown as SessionEventStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const projector = new SessionStateProjector('s1');
    projector.enablePersistence(throwingStore);
    projector.ingest({ type: 'turn_start', userMessage: 'hi' } as RawSessionEvent);

    // The flush throws internally; ingest must still return the seq'd event and
    // keep the projection live (the turn already reached subscribers).
    let ended: SessionEvent | undefined;
    expect(() => {
      ended = projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    }).not.toThrow();
    expect(ended?.type).toBe('turn_end');
    expect(throwingStore.appendTurn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('does not persist without enablePersistence (claude-code negative)', () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('s1'); // persistence NOT enabled
    driveTurn(projector, 'hi', 'yo');
    expect(store.readAll('s1')).toEqual([]);
  });

  describe('hydration', () => {
    it('restores the event stream, sets counter = maxSeq, and continues monotonically', () => {
      const store = new SessionEventStore(createTestDb());
      // Pre-seed the store as if two turns ran before a restart.
      const source = new SessionStateProjector('sess');
      source.enablePersistence(store);
      driveTurn(source, 'first', 'one');
      driveTurn(source, 'second', 'two');
      expect(store.maxSeq('sess')).toBe(6);

      // The restart analog: a FRESH projector over the SAME store.
      const revived = new SessionStateProjector('sess');
      revived.enablePersistence(store);

      // Persisted history is replayable immediately, with a coherent cursor.
      const replayed = revived.replayFrom(0);
      expect(replayed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(revived.getCursor()).toBe(6);

      // Reconstructed history has both turns with STABLE ids (seq-derived).
      const history = reconstructHistoryFromEvents(replayed);
      expect(history.map((m) => m.id)).toEqual(['user-1', 'assistant-1', 'user-4', 'assistant-4']);

      // The next ingest continues from the restored counter.
      const next = revived.ingest({ type: 'turn_start', userMessage: 'third' } as RawSessionEvent);
      expect(next.seq).toBe(7);
    });

    it('is a no-op (no double-append) when the projector already ingested live events', () => {
      const store = new SessionEventStore(createTestDb());
      store.appendTurn('sess', [
        { type: 'turn_start', seq: 1, userMessage: 'stored' } as SessionEvent,
        { type: 'turn_end', seq: 2 } as SessionEvent,
      ]);

      const projector = new SessionStateProjector('sess');
      // A live event arrives BEFORE persistence is enabled (counter becomes 1).
      projector.ingest({ type: 'turn_start', userMessage: 'live' } as RawSessionEvent);
      projector.enablePersistence(store);

      // Not re-hydrated: the in-memory log holds only the live event, because
      // this run is authoritative for what it has already streamed.
      expect(projector.replayFrom(0).map((e) => e.seq)).toEqual([1]);
      // The COUNTER is a different question, and it does move (DOR-784). It used
      // to be left alone here, which was a silent data loss: `appendTurn` is
      // INSERT OR IGNORE on `(session_id, seq)`, so the live turn about to close
      // would have flushed under seqs 1 and 2 — both already taken by the stored
      // rows above — and every row of it would have been dropped without a word.
      // Carrying the counter past the durable max costs a gap in the seq space,
      // which the store already documents as sparse, and nothing else.
      expect(projector.getCursor()).toBe(2);
      // So the turn closing now lands on a free seq and is really written.
      //
      // Be clear about what this trades, because it is not a clean win. The
      // event ingested BEFORE persistence was enabled keeps the seq it streamed
      // under — nothing may renumber an event a client has already seen — so
      // seq 1 in the store is still the OLD turn's `turn_start`, and reading
      // this session back now yields a stored turn opening followed by a later
      // turn's body. That is a mixed row set, and it is worse than a clean one.
      // It is better than what it replaced: before, the whole turn collided and
      // every row of it was dropped in silence, so the session's last durable
      // word was the old turn and nothing recorded that a newer one had ever
      // run. A visibly odd record beats a confidently absent one.
      projector.ingest({ type: 'turn_end' } as RawSessionEvent);
      expect(store.readAll('sess').map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('persistence does not perturb the replay→live subscribe sequence (no drift/dupes)', async () => {
      // The SSE contract (snapshot → gap-free replay → live) must be identical
      // with persistence on: the flush is a post-delivery side effect that
      // touches no seq/waiter/replay state. FakeAgentRuntime mocks
      // subscribeSession, so this proves the property at the real projector —
      // the single mechanism every log-backed runtime's /events route delegates to.
      const store = new SessionEventStore(createTestDb());
      const projector = new SessionStateProjector('sess');
      projector.enablePersistence(store);
      driveTurn(projector, 'q1', 'a1'); // seq 1–3, flushed on turn_end

      const received: number[] = [];
      const iter = projector.subscribe(0)[Symbol.asyncIterator]();
      // Replay phase: the completed turn's 3 events.
      for (let i = 0; i < 3; i++) {
        received.push(((await iter.next()).value as SessionEvent).seq);
      }
      // Live phase: park, then ingest each event to wake the subscriber.
      const nextStart = iter.next();
      projector.ingest({ type: 'turn_start', userMessage: 'q2' } as RawSessionEvent); // seq 4
      received.push(((await nextStart).value as SessionEvent).seq);
      const nextDelta = iter.next();
      projector.ingest({ type: 'text_delta', text: 'a2' } as RawSessionEvent); // seq 5
      received.push(((await nextDelta).value as SessionEvent).seq);
      const nextEnd = iter.next();
      projector.ingest({ type: 'turn_end' } as RawSessionEvent); // seq 6, triggers flush
      received.push(((await nextEnd).value as SessionEvent).seq);
      await iter.return?.(undefined);

      // Gap-free, strictly increasing, no duplicates — across the flush boundary.
      expect(received).toEqual([1, 2, 3, 4, 5, 6]);
      // The live turn was also flushed durably.
      expect(store.maxSeq('sess')).toBe(6);
    });

    it('enablePersistence is idempotent', () => {
      const store = new SessionEventStore(createTestDb());
      store.appendTurn('sess', [{ type: 'turn_start', seq: 1, userMessage: 'x' } as SessionEvent]);
      const projector = new SessionStateProjector('sess');
      projector.enablePersistence(store);
      projector.enablePersistence(store); // second call must not double-hydrate
      expect(projector.replayFrom(0).map((e) => e.seq)).toEqual([1]);
      expect(projector.getCursor()).toBe(1);
    });
  });
});

/**
 * `'record'` mode: a durable record of a room turn, never a history (DOR-784).
 *
 * A room is the one surface with no client holding the session stream, so a turn
 * that fails there leaves nothing on anybody's screen — and for claude-code it
 * used to leave nothing in the database either. `'record'` closes that with the
 * smallest thing that answers "did it run, and how did it end": the turn's two
 * boundaries and any error.
 *
 * It is deliberately NOT `'history'` for the same session, and the two tests
 * about hydration are why. claude-code's history is SDK JSONL (ADR 260710-024641,
 * as retired in part by 260731-211050); an
 * EventLog seeded from these sparse rows would serve a resuming client a turn
 * with its middle missing and call it a gap-free replay.
 */
describe("SessionStateProjector 'record' persistence (DOR-784)", () => {
  it('keeps a turn down to its boundaries', () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('room-sess');
    projector.enablePersistence(store, 'record');

    driveTurn(projector, 'is the build green?', 'green');

    expect(store.readAll('room-sess').map((e) => e.type)).toEqual(['turn_start', 'turn_end']);
  });

  it('keeps what the turn was asked and how it ended', () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('room-sess');
    projector.enablePersistence(store, 'record');

    projector.ingest({ type: 'turn_start', userMessage: 'is the build green?' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end', terminalReason: 'error' } as RawSessionEvent);

    expect(store.readAll('room-sess')).toMatchObject([
      { type: 'turn_start', userMessage: 'is the build green?' },
      { type: 'turn_end', terminalReason: 'error' },
    ]);
  });

  it('does not hydrate the replay log from its own sparse rows', () => {
    const store = new SessionEventStore(createTestDb());
    store.appendTurn('room-sess', [
      { type: 'turn_start', seq: 1, userMessage: 'yesterday' } as SessionEvent,
      { type: 'turn_end', seq: 3 } as SessionEvent,
    ]);
    const projector = new SessionStateProjector('room-sess');

    projector.enablePersistence(store, 'record');

    // Nothing to replay: a resume from an old cursor must take the cold snapshot
    // (read from JSONL, and complete) rather than a turn missing its middle.
    expect(projector.replayFrom(0)).toEqual([]);
  });

  it('still restores the seq counter, or the next turn would record nothing', () => {
    // `appendTurn` is INSERT OR IGNORE on (session_id, seq). A projector that
    // restarted at seq 0 would write its next turn under seqs the last process
    // already used, and every row would be silently dropped — a durable record
    // that records nothing. This is the one thing 'record' shares with 'history'.
    const store = new SessionEventStore(createTestDb());
    store.appendTurn('room-sess', [
      { type: 'turn_start', seq: 1, userMessage: 'yesterday' } as SessionEvent,
      { type: 'turn_end', seq: 3 } as SessionEvent,
    ]);
    const projector = new SessionStateProjector('room-sess');
    projector.enablePersistence(store, 'record');

    driveTurn(projector, 'today', 'green');

    expect(projector.getCursor()).toBe(6);
    expect(store.readAll('room-sess').map((e) => e.seq)).toEqual([1, 3, 4, 6]);
  });

  it("leaves 'history' mode exactly as it was", () => {
    const store = new SessionEventStore(createTestDb());
    const projector = new SessionStateProjector('log-sess');
    projector.enablePersistence(store, 'history');

    driveTurn(projector, 'q', 'a');

    expect(store.readAll('log-sess').map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_end',
    ]);
  });
});
