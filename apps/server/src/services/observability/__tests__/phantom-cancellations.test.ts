/**
 * The DOR-1087 tripwire, at the counter itself (DOR-1288).
 *
 * The point of this module is that the phantom rate stops being anecdotal, so
 * the tests are about the two things a rate needs: it goes up when a phantom
 * happens, and it is separable by the path that produced it — `turn` is the
 * resume-per-message sender (flag off), `pump` is the persistent one (flag on).
 * The paired warning matters just as much: the counter dies with the process and
 * the log line does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../lib/logger.js';
import {
  recordPhantomCancellation,
  phantomCancellationStats,
  resetPhantomCancellations,
  PHANTOM_BUFFER_SIZE,
} from '../phantom-cancellations.js';

const MAIN = { toolUseId: 'toolu_main', mainThread: true, parentToolUseId: null };
const SUB = { toolUseId: 'toolu_sub', mainThread: false, parentToolUseId: 'toolu_task_1' };

/** The one line every phantom writes, as a reader would grep for it. */
function warnCalls(): Array<[string, Record<string, unknown>]> {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter((call) => String(call[0]).startsWith('[phantom-cancellation]')) as Array<
    [string, Record<string, unknown>]
  >;
}

beforeEach(() => {
  resetPhantomCancellations();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPhantomCancellations();
});

describe('recordPhantomCancellation', () => {
  it('starts at zero, so a process that never saw one says so', () => {
    const stats = phantomCancellationStats();
    expect(stats.total).toBe(0);
    expect(stats.byPath).toEqual({ turn: 0, pump: 0 });
    expect(stats.recent).toEqual([]);
  });

  it('counts every cancelled call in a batch, not the batch', () => {
    recordPhantomCancellation({
      sessionId: 's1',
      path: 'turn',
      phantoms: [MAIN, { ...MAIN, toolUseId: 'toolu_main_2' }],
      steered: true,
    });

    const stats = phantomCancellationStats();
    expect(stats.total).toBe(2);
    expect(stats.batches).toBe(1);
    expect(stats.steered).toBe(1);
    // Pinned per-CALL, not per-batch. Every other case in this file records
    // single-phantom batches, where `+= phantoms.length` and `+= 1` are
    // indistinguishable — so without this line the path split could silently
    // start counting batches and the whole file would stay green.
    expect(stats.byPath).toEqual({ turn: 2, pump: 0 });
  });

  it('keeps the turn and pump counts apart — the whole point of the measurement', () => {
    recordPhantomCancellation({ sessionId: 's1', path: 'turn', phantoms: [MAIN], steered: true });
    recordPhantomCancellation({ sessionId: 's2', path: 'pump', phantoms: [MAIN], steered: false });
    recordPhantomCancellation({ sessionId: 's2', path: 'pump', phantoms: [MAIN], steered: false });

    const stats = phantomCancellationStats();
    expect(stats.byPath).toEqual({ turn: 1, pump: 2 });
    expect(stats.total).toBe(3);
    expect(stats.sessions).toBe(2);
  });

  it('separates a subagent phantom from a main-thread one', () => {
    recordPhantomCancellation({ sessionId: 's1', path: 'pump', phantoms: [SUB], steered: false });

    const stats = phantomCancellationStats();
    expect(stats.subagent).toBe(1);
    expect(stats.mainThread).toBe(0);
    expect(stats.recent[0]).toMatchObject({ mainThread: false, parentToolUseId: 'toolu_task_1' });
  });

  it('writes one warning carrying the session, the ids, the path, and the running total', () => {
    recordPhantomCancellation({ sessionId: 's1', path: 'pump', phantoms: [MAIN], steered: false });
    recordPhantomCancellation({ sessionId: 's1', path: 'pump', phantoms: [SUB], steered: false });

    const calls = warnCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      session: 's1',
      path: 'pump',
      toolUseIds: ['toolu_main'],
      count: 1,
      mainThread: true,
      parentToolUseId: null,
      steered: false,
      totalSinceBoot: 1,
      pathTotalSinceBoot: 1,
    });
    // The running total climbs on the line itself, so a log with no live process
    // behind it still answers "how many".
    expect(calls[1][1]).toMatchObject({ totalSinceBoot: 2, parentToolUseId: 'toolu_task_1' });
  });

  it('says nothing at all when the detector found nothing', () => {
    recordPhantomCancellation({ sessionId: 's1', path: 'pump', phantoms: [], steered: false });

    expect(warnCalls()).toHaveLength(0);
    expect(phantomCancellationStats().total).toBe(0);
  });

  it('returns recent batches newest first and keeps counting past the ring', () => {
    for (let i = 0; i < PHANTOM_BUFFER_SIZE + 5; i += 1) {
      recordPhantomCancellation({
        sessionId: 's1',
        path: 'pump',
        phantoms: [{ ...MAIN, toolUseId: `toolu_${i}` }],
        steered: false,
      });
    }

    const stats = phantomCancellationStats();
    // The ring forgets; the counter does not. A rate read after a bad hour must
    // not be capped by how many rows fit in memory.
    expect(stats.total).toBe(PHANTOM_BUFFER_SIZE + 5);
    expect(stats.recent).toHaveLength(PHANTOM_BUFFER_SIZE);
    expect(stats.recent[0].toolUseIds).toEqual([`toolu_${PHANTOM_BUFFER_SIZE + 4}`]);
  });

  it('honours a limit smaller than the ring', () => {
    for (let i = 0; i < 5; i += 1) {
      recordPhantomCancellation({
        sessionId: 's1',
        path: 'turn',
        phantoms: [{ ...MAIN, toolUseId: `toolu_${i}` }],
        steered: false,
      });
    }

    expect(phantomCancellationStats(2).recent.map((r) => r.toolUseIds[0])).toEqual([
      'toolu_4',
      'toolu_3',
    ]);
  });
});
