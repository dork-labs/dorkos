import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import {
  failedReply,
  isSlotWaitEvent,
  noteTurnFailure,
  noteTurnWait,
  settleTurnFailure,
  type TurnWaits,
} from '../turn-waits.js';
import { TURN_NOT_STARTED_CODE } from '../../../session/launch/turn-not-started.js';

const GRACE = 60_000;

const slotWait = {
  seq: 2,
  type: 'system_status',
  message: 'Waiting',
  status: 'waiting_for_slot',
} as SessionEvent;
const textDelta = { seq: 3, type: 'text_delta', text: 'hi' } as SessionEvent;

afterEach(() => {
  vi.useRealTimers();
});

describe('noteTurnWait', () => {
  // Purpose: a slot wait that outlasts the grace is said once, as `slot`, and
  // the beats that repeat it never stack a second line.
  it('reports a slot wait once it has lasted the grace, however many beats arrive', () => {
    vi.useFakeTimers();
    const waits: TurnWaits = new Map();
    const onWaiting = vi.fn();
    noteTurnWait(slotWait, waits, { graceMs: GRACE, onWaiting });
    vi.advanceTimersByTime(GRACE / 2);
    noteTurnWait({ ...slotWait, seq: 4 } as SessionEvent, waits, { graceMs: GRACE, onWaiting });
    vi.advanceTimersByTime(GRACE / 2);

    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith({ kind: 'slot' });
  });

  // Purpose: a slot that frees inside the grace leaves no line in the room.
  it('says nothing about a slot wait the turn started out of in time', () => {
    vi.useFakeTimers();
    const waits: TurnWaits = new Map();
    const onWaiting = vi.fn();
    noteTurnWait(slotWait, waits, { graceMs: GRACE, onWaiting });
    noteTurnWait(textDelta, waits, { graceMs: GRACE, onWaiting });
    vi.advanceTimersByTime(GRACE * 2);

    expect(onWaiting).not.toHaveBeenCalled();
    expect(waits.size).toBe(0);
  });

  // Purpose: the person-wait path the helper took over still works.
  it('reports an approval that is still open after the grace, and not one answered in time', () => {
    vi.useFakeTimers();
    const waits: TurnWaits = new Map();
    const onWaiting = vi.fn();
    const approval = {
      seq: 5,
      type: 'approval_required',
      id: 'call-1',
      toolName: 'Bash',
    } as unknown as SessionEvent;
    noteTurnWait(approval, waits, { graceMs: GRACE, onWaiting });
    noteTurnWait(
      { seq: 6, type: 'interaction_resolved', id: 'call-1' } as unknown as SessionEvent,
      waits,
      { graceMs: GRACE, onWaiting }
    );
    vi.advanceTimersByTime(GRACE * 2);
    expect(onWaiting).not.toHaveBeenCalled();

    noteTurnWait({ ...approval, id: 'call-2' } as unknown as SessionEvent, waits, {
      graceMs: GRACE,
      onWaiting,
    });
    vi.advanceTimersByTime(GRACE);
    expect(onWaiting).toHaveBeenCalledWith({ kind: 'approval', toolName: 'Bash' });
  });

  it('tells a slot wait from any other status', () => {
    expect(isSlotWaitEvent(slotWait)).toBe(true);
    expect(isSlotWaitEvent({ seq: 1, type: 'system_status', message: 'x' } as SessionEvent)).toBe(
      false
    );
  });
});

describe('turn failures', () => {
  // Purpose: a refused turn carries its refusal for the room's line and its
  // words for the log.
  it('keeps the refusal and the message of a turn that never started', () => {
    const refused = {
      seq: 7,
      type: 'error',
      message: 'Every agent here stayed busy too long, so this didn’t start. Send it again.',
      code: TURN_NOT_STARTED_CODE,
      reason: 'warm-ceiling',
    } as SessionEvent;
    const known = noteTurnFailure({}, refused);
    expect(settleTurnFailure(known, true)).toEqual({
      refusal: 'warm-ceiling',
      detail: 'Every agent here stayed busy too long, so this didn’t start. Send it again.',
    });
  });

  // Purpose: every failure has a reason in the log, even with no error event.
  it('gives a detail to a failure no error event explained', () => {
    expect(settleTurnFailure({}, false)).toEqual({ detail: 'the turn never reached its end' });
    expect(settleTurnFailure({}, true)).toEqual({ detail: 'the turn ended in an error' });
  });

  it('keeps the first error, not a later one', () => {
    const first = { seq: 1, type: 'error', message: 'the CLI died' } as SessionEvent;
    const second = { seq: 2, type: 'error', message: 'later' } as SessionEvent;
    expect(noteTurnFailure(noteTurnFailure({}, first), second)).toEqual({ detail: 'the CLI died' });
  });

  it('marks a failed reply and carries why', () => {
    expect(failedReply({ failure: { detail: 'x' } })).toEqual({
      unanswered: 'failed',
      failure: { detail: 'x' },
    });
    expect(failedReply({})).toEqual({ unanswered: 'failed' });
  });
});
