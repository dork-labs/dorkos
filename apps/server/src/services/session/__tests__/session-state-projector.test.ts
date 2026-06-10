import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionStateProjector,
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  rekeyProjector,
} from '../session-state-projector.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import { EVENT_LOG_MAX_EVENTS } from '../event-log.js';
import { StaleResumeCursorError } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';

const TIMEOUT_MS = 10 * 60 * 1000;

/** Drain up to `count` events from an async iterable, then return them. */
async function take(iter: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe('SessionStateProjector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: the client cannot resolve gaps/dups unless seq is strictly
  // increasing and owned by the projector, not the adapter.
  it('assigns strictly-increasing per-session seq starting at 1; cursor tracks the latest', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getCursor()).toBe(0);
    const a = p.ingest({ type: 'turn_start' });
    const b = p.ingest({ type: 'text_delta', text: 'hi' } as RawSessionEvent);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(p.getCursor()).toBe(2);
  });

  // Failure mode: lifecycle drift — a turn that started must read as streaming,
  // and finalize back to idle on turn_end so the status badge is correct.
  it('projects lifecycle: idle -> streaming -> idle across a turn', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getStatus().lifecycle).toBe('idle');
    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().lifecycle).toBe('streaming');
    p.ingest({ type: 'turn_end' });
    expect(p.getStatus().lifecycle).toBe('idle');
  });

  // Failure mode: status_change deltas must fold into the held status, not
  // replace it wholesale, so unrelated fields survive a partial update.
  it('folds status_change partials into the held status', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'status_change', status: { model: 'claude-x', cost: 0.5 } });
    p.ingest({ type: 'status_change', status: { cost: 0.9 } });
    const status = p.getStatus();
    expect(status.model).toBe('claude-x');
    expect(status.cost).toBe(0.9);
  });

  // Failure mode: outputTokens clobbered to 0 at turn end — the final
  // status_change carries context/cache totals but NO outputTokens, so a
  // wholesale contextUsage replace would reset the running output-token count.
  // The projector must merge contextUsage field-wise so outputTokens survives
  // and the context/cache fields still update (defeats requirement #4 otherwise).
  it('merges contextUsage field-wise so outputTokens survives the final status', () => {
    const p = new SessionStateProjector('s1');
    // Streaming update: only outputTokens present.
    p.ingest({ type: 'status_change', status: { contextUsage: { outputTokens: 20 } } });
    expect(p.getStatus().contextUsage?.outputTokens).toBe(20);

    // Final update: context/cache totals, NO outputTokens.
    p.ingest({
      type: 'status_change',
      status: { contextUsage: { totalTokens: 100, cacheReadTokens: 80 } },
    });
    const usage = p.getStatus().contextUsage;
    expect(usage?.outputTokens).toBe(20); // survived the final event
    expect(usage?.totalTokens).toBe(100); // updated
    expect(usage?.cacheReadTokens).toBe(80); // updated
  });

  // Failure mode: a null contextUsage delta must clear the held usage outright
  // (e.g. an explicit reset), not be silently field-merged.
  it('clears contextUsage when a status_change carries an explicit null', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'status_change', status: { contextUsage: { outputTokens: 5 } } });
    p.ingest({ type: 'status_change', status: { contextUsage: null } });
    expect(p.getStatus().contextUsage).toBeNull();
  });

  // Failure mode: todo/subagent tallies feed the status badge; a snapshot
  // todo_update must set total/completed/inProgress and running subagents.
  it('projects todoCounts and runningSubagentCount', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'todo_update',
      action: 'snapshot',
      task: { id: 't1', subject: 'a', status: 'completed' },
      tasks: [
        { id: 't1', subject: 'a', status: 'completed' },
        { id: 't2', subject: 'b', status: 'in_progress' },
        { id: 't3', subject: 'c', status: 'pending' },
      ],
    } as RawSessionEvent);
    expect(p.getStatus().todoCounts).toEqual({ total: 3, completed: 1, inProgress: 1 });

    p.ingest({ type: 'subagent_update', taskId: 'x', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'y', status: 'running' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(2);
    p.ingest({ type: 'subagent_update', taskId: 'x', status: 'complete' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);
  });

  // Failure mode: an interaction left pending must surface as a recoverable
  // pending interaction with server-authoritative remainingMs; blocked lifecycle.
  it('projects pending interactions and goes blocked while one is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    expect(p.getStatus().lifecycle).toBe('blocked');
    const pending = p.getPendingInteractions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('tool-1');
    expect(pending[0]?.remainingMs).toBe(TIMEOUT_MS);
  });

  // Failure mode: a stale prompt must never be re-presented; an interaction past
  // the timeout boundary (remainingMs <= 0) is excluded from the snapshot.
  it('excludes expired interactions at the exclusive timeout boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: 0,
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    // Advance to exactly the timeout: remainingMs === 0 -> excluded.
    vi.setSystemTime(TIMEOUT_MS);
    expect(p.getPendingInteractions()).toEqual([]);
  });

  // Failure mode: resolving an interaction (deny/approve) must remove it from
  // the pending map so it does not reappear on reconnect.
  it('clears a pending interaction once resolved', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    expect(p.getPendingInteractions()).toHaveLength(1);
    p.resolveInteraction('tool-1');
    expect(p.getPendingInteractions()).toEqual([]);
  });

  // Failure mode (CLI-C1): resolution must flow through the seq'd stream —
  // a live subscriber (this window, another window) must see the removal, and
  // replay must reproduce it. A silent map delete left ghost Approve/Deny
  // cards everywhere except the resolving window's optimistic UI.
  it("resolveInteraction ingests a seq'd interaction_resolved event (replayable, settles lifecycle)", () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent); // seq 2
    expect(p.getStatus().lifecycle).toBe('blocked');

    p.resolveInteraction('tool-1', 'approved');

    // The resolution is a real seq'd event: present in replay for resuming clients.
    const replayed = p.replayFrom(2);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: 'interaction_resolved', id: 'tool-1', seq: 3 });
    // Pending cleared and lifecycle settled back (turn still in progress → streaming).
    expect(p.getPendingInteractions()).toEqual([]);
    expect(p.getStatus().lifecycle).toBe('streaming');
  });

  it('resolveInteraction is a no-op for an unknown id (stale click emits nothing)', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.resolveInteraction('never-tracked', 'denied');
    expect(p.getCursor()).toBe(1); // no event emitted
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

  // Failure mode: a fresh subscriber with no cursor must still receive live
  // events as they are ingested.
  it('subscribe() with no cursor yields live events', async () => {
    const p = new SessionStateProjector('s1');
    const collected = take(p.subscribe(), 2);
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    const events = (await collected) as Array<{ seq: number }>;
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
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

  // Failure mode (SRV-I1): every park raced an abort listener registered with
  // {once:true}, which only auto-removes when abort FIRES — so the normal
  // delivered-event path accumulated one listener (and one retained closure)
  // per event for the connection's lifetime: MaxListenersExceededWarning at 11,
  // unbounded growth on an hours-long durable stream.
  it('does not accumulate abort listeners across delivered events (one park = one listener, removed)', async () => {
    const p = new SessionStateProjector('s1');
    const ac = new AbortController();
    const collected = take(p.subscribe(0, ac.signal), 25);
    for (let i = 0; i < 25; i++) {
      // Yield to the event loop so the generator re-parks (and re-registers an
      // abort listener) for EVERY event — the exact leak shape.
      await new Promise((r) => setImmediate(r));
      p.ingest({ type: 'text_delta', text: String(i) } as RawSessionEvent);
    }
    await collected;
    expect(getEventListeners(ac.signal, 'abort').length).toBeLessThanOrEqual(1);
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

  // Failure mode: a server restart leaves a turn streaming with no turn_end;
  // markInterrupted must flip lifecycle so the client stops showing a live spinner.
  it('markInterrupted flips a streaming turn to interrupted', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().lifecycle).toBe('streaming');
    p.markInterrupted();
    expect(p.getStatus().lifecycle).toBe('interrupted');
  });

  // Failure mode (C2): an errored turn settles to idle, masking failure on cold
  // hydrate. The detached-error path ingests status_change{error} then a terminal
  // turn_end{terminalReason:'error'}. If turn_end unconditionally derived idle, it
  // would OVERWRITE the error — a hard-refresh snapshot would show a clean idle
  // session and the failure would be invisible. The terminal lifecycle must
  // survive in BOTH the live projection AND the cold snapshot.
  it('settles to error (not idle) when an errored turn ends, in projection and snapshot', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'status_change', status: { lifecycle: 'error' } });
    p.ingest({ type: 'turn_end', terminalReason: 'error' });

    // Live projection reflects the terminal error, not idle.
    expect(p.getStatus().lifecycle).toBe('error');
    // Cold hydrate (the path a hard-refresh takes) also shows error.
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.status.lifecycle).toBe('error');
  });

  // Failure mode (C2): an interrupted/aborted turn must likewise settle terminal
  // so a cold hydrate shows it was cut short, not cleanly idle. Here the turn
  // closes with an abort terminalReason (no prior error status_change).
  it('settles to interrupted (not idle) when a turn ends with an abort terminalReason', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end', terminalReason: 'aborted_streaming' });

    expect(p.getStatus().lifecycle).toBe('interrupted');
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.status.lifecycle).toBe('interrupted');
  });

  // Failure mode (C2 guard): a normal completion must STILL settle idle — the
  // terminal-lifecycle handling is scoped to error/abort reasons only.
  it('still settles to idle when a turn ends cleanly (completed)', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end', terminalReason: 'completed' });
    expect(p.getStatus().lifecycle).toBe('idle');
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

  it('subscribe accepts a fully-caught-up cursor, an in-range cursor, and 0 on a fresh projector', () => {
    const fresh = new SessionStateProjector('s-fresh');
    expect(() => fresh.subscribe(0)).not.toThrow();

    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    expect(() => p.subscribe(2)).not.toThrow(); // caught up (== counter)
    expect(() => p.subscribe(1)).not.toThrow(); // in retained range
    expect(() => p.subscribe(0)).not.toThrow(); // full replay, nothing trimmed
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

  // The eviction path (I1) must finalize-and-drop only live projectors, never
  // allocate a throwaway for an id that was never streamed.
  it('peekProjector returns an existing projector without creating one', () => {
    expect(peekProjector('peek-only')).toBeUndefined();
    const created = getOrCreateProjector('peek-only');
    expect(peekProjector('peek-only')).toBe(created);
    disposeProjector('peek-only');
    expect(peekProjector('peek-only')).toBeUndefined();
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
    original.ingest({ type: 'turn_end', terminalReason: 'completed' });
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

    // The old UUID is freed: a lookup there is now a DIFFERENT, fresh instance
    // (cursor 0), proving the move was not a copy/alias (ADR-0267 — no dual-id).
    const fresh = getOrCreateProjector(UUID);
    expect(fresh).not.toBe(original);
    expect(fresh.getCursor()).toBe(0);

    disposeProjector(UUID);
    disposeProjector(CANONICAL);
  });

  // Failure mode (C1 guards): rekey must be a no-op when the id is unchanged or
  // when nothing is registered under oldId — so an existing session (whose id
  // never changes) and a missing source are both safe.
  it('rekeyProjector is a no-op for an unchanged id or a missing source', () => {
    const SAME = 'same-id';
    const a = getOrCreateProjector(SAME);
    rekeyProjector(SAME, SAME); // same id: instance untouched
    expect(getOrCreateProjector(SAME)).toBe(a);
    disposeProjector(SAME);

    // Missing source: nothing to move, and the target stays unregistered.
    rekeyProjector('never-created', 'still-unregistered');
    expect(peekProjector('still-unregistered')).toBeUndefined();
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
});
