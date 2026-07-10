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

      // Not re-hydrated: the in-memory log holds only the live event, and the
      // counter is untouched (its in-memory run is authoritative).
      expect(projector.replayFrom(0).map((e) => e.seq)).toEqual([1]);
      expect(projector.getCursor()).toBe(1);
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
