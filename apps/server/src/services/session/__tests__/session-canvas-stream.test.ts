/**
 * The seam between the canvas and a session's durable stream (spec
 * `canvas-agent-seat` §1.3).
 *
 * Everything here runs against the REAL projector and a real SQLite database.
 * The claim the phase turns on is that a session's canvas needs no whole-set
 * resync of the kind a room's stream requires — and that claim is entirely
 * about how the projector stamps and replays, so a fake projector could only
 * prove that the fake behaves.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Minting the event and never ingesting it reddens "reaches an attached
 *   reader", which is the failure a service that published to nothing would
 *   have: the row is right and no window ever hears about it.
 * - Leaving `'canvas'` out of `EVENTS_OUTSIDE_THE_TURN` reddens both
 *   turn-membership tests, and would make opening a document look like agent
 *   output — or open a phantom turn when nothing was running.
 * - Adding `'canvas'` to `RECORDED_EVENT_TYPES` reddens the event-store test,
 *   and would put two records of one fact in two places with two lifetimes.
 *
 * @module server/services/session/tests/session-canvas-stream
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  CanvasDocumentStore,
  CanvasService,
  publishSessionCanvas,
  sessionCanvasViewers,
  sessionScope,
  SESSION_OWNER_AUTHOR,
} from '../../canvas/index.js';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
} from '../session-state-projector.js';
import { RECORDED_EVENT_TYPES } from '../projector-persistence.js';

const SESSION = 'sess-canvas-stream';
const SCOPE = sessionScope(SESSION);

/** Drain up to `count` events from an async iterable, then return them. */
async function take(iter: AsyncIterable<SessionEvent>, count: number): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe('a session canvas change on the durable stream', () => {
  let db: Db;
  let canvas: CanvasService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    // The REAL channel: frames go through `peekProjector(...).ingest`, exactly
    // as they do in production. Nothing here stands a fake projector up.
    canvas = new CanvasService({
      documents: new CanvasDocumentStore(db),
      channels: {
        publish: (scope, frame) => publishSessionCanvas(scope.slice('session:'.length), frame),
        viewers: (scope) => sessionCanvasViewers(scope.slice('session:'.length)),
      },
    });
  });

  afterEach(() => {
    disposeProjector(SESSION);
  });

  it('reaches an attached reader as a seq’d `canvas` event', async () => {
    const projector = getOrCreateProjector(SESSION, '/work');
    const events = take(projector.subscribe(0), 2);
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' });
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/b.ts' });

    const received = await events;
    expect(received.map((e) => e.type)).toEqual(['canvas', 'canvas']);
    // Monotonic, and stamped by the projector rather than by the service — which
    // is what makes the event replayable at all.
    expect(received[0]!.seq).toBeGreaterThan(0);
    expect(received[1]!.seq).toBe(received[0]!.seq + 1);
    const first = received[0]!;
    expect(first.type === 'canvas' && first.change).toBe('opened');
    expect(first.type === 'canvas' && first.document?.title).toBe('a.ts');
  });

  it('counts live readers, which is what get_ui_state reports as `viewers`', async () => {
    const projector = getOrCreateProjector(SESSION, '/work');
    expect(canvas.viewers(SCOPE)).toBe(0);

    // A generator that has been STARTED, not merely constructed: the count is
    // incremented inside `subscribeFrom`, which does not run until the first
    // `next()`. Two of them, because one person with two tabs counts twice.
    const first = projector.subscribe(0)[Symbol.asyncIterator]();
    const second = projector.subscribe(0)[Symbol.asyncIterator]();
    const pending = [first.next(), second.next()];
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' });
    await Promise.all(pending);
    expect(canvas.viewers(SCOPE)).toBe(2);

    // And zero again once both windows go away.
    await Promise.all([first.return?.(undefined), second.return?.(undefined)]);
    expect(canvas.viewers(SCOPE)).toBe(0);
  });

  it('never appears inside an in-progress turn, and opens no turn of its own', () => {
    const projector = getOrCreateProjector(SESSION, '/work');
    // Nothing running: a person opening a document must not start a turn.
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' });
    expect(projector.peekInProgressTurn()).toBeNull();

    // Mid-turn: the document is still not part of what the agent said.
    projector.ingest({ type: 'turn_start' });
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/b.ts' });
    const turn = projector.peekInProgressTurn();
    expect(turn).not.toBeNull();
    expect(turn?.some((e) => e.type === 'canvas')).toBe(false);
  });

  it('is not a recorded event type — the canvas is state, not transcript', () => {
    // Durable in SQLite and re-read from there. Writing it into the event store
    // as well would be two records of one fact with two lifetimes.
    expect(RECORDED_EVENT_TYPES.has('canvas')).toBe(false);
  });

  it('replays two missed writes in order on a resume, with no snapshot', async () => {
    const projector = getOrCreateProjector(SESSION, '/work');
    // One write while a reader IS attached, so it holds a real cursor.
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' });
    const firstPass = await take(projector.subscribe(0), 1);
    const cursor = firstPass[0]!.seq;

    // Two more land while nobody is reading — the reader has gone away.
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/b.ts' });
    canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/c.ts' });

    // It comes back with the cursor it held, and gets both, in order, from the
    // ring. The gap a ROOM stream needs a whole-set resync to close cannot open
    // here, because every session event carries a seq and is replayed from it.
    const replayed = await take(projector.subscribe(cursor), 2);
    expect(replayed.map((e) => e.type)).toEqual(['canvas', 'canvas']);
    expect(replayed.map((e) => (e.type === 'canvas' ? e.document?.title : null))).toEqual([
      'b.ts',
      'c.ts',
    ]);
    expect(replayed.map((e) => e.seq)).toEqual([cursor + 1, cursor + 2]);
  });

  it('does not throw, and does not lose the row, when no projector is attached', () => {
    // The NORMAL case — nobody attached, session idle — and the one most likely
    // to be coded as an error. The next reader hydrates from the snapshot.
    expect(peekProjector(SESSION)).toBeUndefined();
    expect(() =>
      canvas.open(SCOPE, SESSION_OWNER_AUTHOR, { type: 'file', sourcePath: '/src/a.ts' })
    ).not.toThrow();
    expect(canvas.list(SCOPE)).toHaveLength(1);
    expect(canvas.viewers(SCOPE)).toBe(0);
  });
});
