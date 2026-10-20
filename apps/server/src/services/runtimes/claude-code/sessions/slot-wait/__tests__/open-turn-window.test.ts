import { describe, it, expect, vi, afterEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { SLOT_WAIT_STATUS } from '@dorkos/shared/schemas';

import {
  explainRefusedDispatch,
  openWindowWaitingForSlot,
  SLOT_WAIT_BEAT_MS,
  SLOT_WAIT_MESSAGE,
} from '../open-turn-window.js';
import { IllegalPumpTransitionError, PumpRefusedError } from '../../session-pump-contract.js';
import type { TurnWindow } from '../../session-turn-windows.js';
import { TURN_NOT_STARTED_CODE } from '../../../../../session/launch/turn-not-started.js';

const WINDOW = { id: 'w' } as unknown as TurnWindow;
const noop = (): void => undefined;

afterEach(() => {
  vi.useRealTimers();
});

/** Run the generator to the end, keeping what it yielded and what it returned. */
async function drain(
  gen: AsyncGenerator<StreamEvent, TurnWindow>
): Promise<{ events: StreamEvent[]; window: TurnWindow }> {
  const events: StreamEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, window: next.value };
    events.push(next.value);
  }
}

describe('openWindowWaitingForSlot', () => {
  // Purpose: a launch that opens at once says nothing extra.
  it('yields nothing when the window opens without waiting', async () => {
    const { events, window } = await drain(
      openWindowWaitingForSlot('s', noop, () => Promise.resolve(WINDOW))
    );
    expect(events).toEqual([]);
    expect(window).toBe(WINDOW);
  });

  // Purpose: the person must see WHY the turn has not started (DOR-3012). The
  // one status is yielded while the dispatch is still pending, not after.
  it('says it is waiting as soon as the launch starts waiting for a slot', async () => {
    let open!: (window: TurnWindow) => void;
    const gen = openWindowWaitingForSlot(
      's',
      noop,
      (onWaiting) =>
        new Promise<TurnWindow>((resolve) => {
          open = resolve;
          onWaiting();
        })
    );

    const first = await gen.next();
    expect(first.value).toEqual({
      type: 'system_status',
      data: { message: SLOT_WAIT_MESSAGE, status: SLOT_WAIT_STATUS },
    });

    open(WINDOW);
    const last = await gen.next();
    expect(last).toEqual({ done: true, value: WINDOW });
  });

  // Purpose: a long wait must not read as a stalled turn. The stall guard ends
  // a turn that is quiet for two minutes before its first real event, so the
  // wait says so again on every beat until the window opens.
  it('says it again on every beat while the wait lasts', async () => {
    vi.useFakeTimers();
    let open!: (window: TurnWindow) => void;
    const gen = openWindowWaitingForSlot(
      's',
      noop,
      (onWaiting) =>
        new Promise<TurnWindow>((resolve) => {
          open = resolve;
          onWaiting();
        })
    );
    expect((await gen.next()).value).toMatchObject({ type: 'system_status' });

    const second = gen.next();
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_BEAT_MS);
    expect((await second).value).toMatchObject({ type: 'system_status' });

    const last = gen.next();
    open(WINDOW);
    expect(await last).toEqual({ done: true, value: WINDOW });
  });

  // Purpose: a reader that stops listening mid-wait must end the wait, or the
  // launch would later start a turn nobody streams.
  it('ends the wait when the reader stops listening before the window opens', async () => {
    const abandon = vi.fn();
    const gen = openWindowWaitingForSlot('s', abandon, (onWaiting) => {
      onWaiting();
      return new Promise<TurnWindow>(() => undefined);
    });
    await gen.next();
    await gen.return(WINDOW);
    expect(abandon).toHaveBeenCalledTimes(1);
  });

  // Purpose: a window that opened, or a dispatch that failed, ends nothing.
  it('does not abandon a wait that ended on its own', async () => {
    const abandon = vi.fn();
    await drain(openWindowWaitingForSlot('s', abandon, () => Promise.resolve(WINDOW)));
    await expect(
      drain(openWindowWaitingForSlot('s', abandon, () => Promise.reject(new Error('x'))))
    ).rejects.toThrow('x');
    expect(abandon).not.toHaveBeenCalled();
  });

  // Purpose: "SessionPump cannot go from reaped to warming". A pump reaped
  // between acquire and dispatch is replaced and the turn goes ahead, once.
  it('tries once more when the pump was reaped under the dispatch', async () => {
    let calls = 0;
    const { window } = await drain(
      openWindowWaitingForSlot('s', noop, () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new IllegalPumpTransitionError('reaped', 'warming'))
          : Promise.resolve(WINDOW);
      })
    );
    expect(calls).toBe(2);
    expect(window).toBe(WINDOW);
  });

  // Purpose: the retry is one retry, never a loop.
  it('gives up after the second spent pump', async () => {
    let calls = 0;
    await expect(
      drain(
        openWindowWaitingForSlot('s', noop, () => {
          calls += 1;
          return Promise.reject(new IllegalPumpTransitionError('reaped', 'warming'));
        })
      )
    ).rejects.toBeInstanceOf(IllegalPumpTransitionError);
    expect(calls).toBe(2);
  });

  // Purpose: only a spent pump is retried; every other refusal is reported.
  it('does not retry any other refusal', async () => {
    let calls = 0;
    await expect(
      drain(
        openWindowWaitingForSlot('s', noop, () => {
          calls += 1;
          return Promise.reject(new PumpRefusedError('warm-ceiling', 'full'));
        })
      )
    ).rejects.toMatchObject({ reason: 'warm-ceiling' });
    expect(calls).toBe(1);
  });
});

describe('explainRefusedDispatch', () => {
  // Purpose: a slot that never came free is said in plain words, names no
  // number, and still marks the turn as never started.
  it('explains a warm-ceiling refusal in plain words', () => {
    const events = [
      ...explainRefusedDispatch('s', new PumpRefusedError('warm-ceiling', 'raw'), false),
    ];
    expect(events[0]).toMatchObject({
      type: 'error',
      data: {
        code: TURN_NOT_STARTED_CODE,
        reason: 'warm-ceiling',
        message: 'Every agent here stayed busy too long, so this didn’t start. Send it again.',
      },
    });
    expect(events[1]).toEqual({ type: 'done', data: { sessionId: 's' } });
  });

  // Purpose: anything unrecognised is rethrown for the one generic translator.
  it('rethrows what it does not recognise', () => {
    const err = new Error('boom');
    expect(() => [...explainRefusedDispatch('s', err, false)]).toThrow(err);
  });
});
