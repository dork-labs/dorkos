/**
 * `ProcessQuiet` on its own, for the two answers no pump-level test can reach
 * apart: what the queue holds on (`isSegmentOnItsWay`), and `dispose()`
 * dropping the segment hold (DOR-5490). A pump's teardown also ends its
 * stream, whose crash path drops the hold too, so only a direct call shows
 * `dispose()` does its own part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessQuiet } from '../process-quiet.js';
import { createTurnLiveness } from '../turn-liveness.js';
import {
  initMessage,
  resultMessage,
  taskNotificationMessage,
} from '../../sessions/__tests__/fake-pump-query.js';

/** A tracker for one idle warm process, with no turn open and nobody waited on. */
function idleProcess(): ProcessQuiet {
  const liveness = createTurnLiveness();
  return new ProcessQuiet({
    sessionId: 'sess-quiet',
    liveness: () => liveness,
    isTurnOpen: () => false,
    hasRuntimeTurnOpen: () => false,
    hasPendingInteraction: () => false,
    onGateChange: () => {},
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProcessQuiet and a segment on its way (DOR-5490)', () => {
  it('says a delivery is on its way while it is owed, and while its segment has not spoken', () => {
    const quiet = idleProcess();
    quiet.observe(resultMessage());
    expect(quiet.isSegmentOnItsWay()).toBe(false);

    quiet.observe(taskNotificationMessage('task-1'));
    expect(quiet.isSegmentOnItsWay()).toBe(true);

    // The init clears the debt; the segment is still on its way.
    quiet.observe(initMessage());
    expect(quiet.quietness()).toMatchObject({ quiet: false, because: 'segment-starting' });
    expect(quiet.isSegmentOnItsWay()).toBe(true);

    quiet.observe(resultMessage());
    expect(quiet.isSegmentOnItsWay()).toBe(false);
  });

  it('drops the hold on dispose', () => {
    const quiet = idleProcess();
    quiet.observe(resultMessage());
    quiet.observe(initMessage());
    expect(quiet.isSegmentOnItsWay()).toBe(true);

    quiet.dispose();
    expect(quiet.isSegmentOnItsWay()).toBe(false);
    expect(quiet.quietness()).toMatchObject({ quiet: true });
  });
});
