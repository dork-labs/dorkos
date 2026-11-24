/**
 * session-turn-windows: late results. Shared setup lives in `./session-turn-windows.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { initMessage } from '../fake-pump-query.js';
import {
  CWD,
  resultMessage,
  textDeltaMessage,
  harness,
  settled,
} from './session-turn-windows.fixtures.js';

describe('SessionTurnWindows — a late result cannot strand the open window (DOR-1294)', () => {
  // The sequence the P5.1 measurement caught live, one arm-B run in three
  // (`research/20260817_persistent-session-flag-measurement.md` §6):
  //
  //   turn 3 dispatched, steered mid-turn, and answered by a `result` naming the
  //   TURN — so the steer stayed in the CLI's queue and its window closed
  //   without it. Turn 4 was then dispatched, and the CLI answered the steer
  //   (coalesced with turn 4) under ONE `result` naming the steer.
  //
  // Correlating only against the OPEN window read that last `result` as a
  // message this session never sent, gave it a runtime window, and left turn 4's
  // window with nothing that could ever close it — after which every dispatch
  // threw `IllegalPumpTransitionError` and the session was dead until restart.
  //
  // Revert the `awaitingResult` ledger and this goes red at the first assertion:
  // turn 4's window is still open, and the dispatch below throws.
  it('closes the open window on a result naming a steer an earlier window sent', async () => {
    const h = harness();

    // Turn 3: dispatched, steered, and answered by the TURN's own id.
    await h.dispatch([{ content: 'do the thing', messageId: 'm-turn3' }]);
    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    h.live().emit(resultMessage('m-turn3'));
    await settled(h, 1);

    // Turn 4: dispatched while the steer is still sitting in the CLI's queue.
    await h.windows.dispatch([{ content: 'and now this', messageId: 'm-turn4' }], CWD);
    expect(h.windows.openWindow?.ids).toEqual(['m-turn4']);

    // The CLI answers the queued steer, coalesced with turn 4, under one result.
    h.live().emit(resultMessage('m-steer'));
    await settled(h, 2);

    // Turn 4's window closed on it rather than waiting forever.
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');

    // And the session still works: turn 5 runs, on the same process.
    await h.windows.dispatch([{ content: 'turn five', messageId: 'm-turn5' }], CWD);
    h.live().emit(resultMessage('m-turn5'));
    await settled(h, 3);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      expect(window.types.filter((t) => t === 'turn_start')).toHaveLength(1);
      expect(window.types.filter((t) => t === 'turn_end')).toHaveLength(1);
      // Every turn ended normally — nothing was abandoned by the backstop.
      expect(window.events.find((e) => e.type === 'turn_end')).not.toMatchObject({
        terminalReason: 'error',
      });
    }
    expect(h.queries).toHaveLength(1);
  });

  // The backstop, on the one path the ledger cannot reach: a window whose result
  // never arrives at all. A session that can never dispatch again is the worst
  // failure this layer has, so the next dispatch settles the stranded turn
  // instead of inheriting its wedge.
  it('recovers when an unattributable result leaves a window with no result of its own', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    // A result for a turn nobody asked for: its own runtime window, and m1's
    // window is deliberately left open (the case above).
    h.live().emit(resultMessage('m-nobody-ever-sent-this'));
    await vi.waitFor(() => expect(h.opened.length).toBe(2));
    expect(h.windows.openWindow?.ids).toEqual(['m1']);

    // m1's own result never comes. The next message must still run.
    await expect(
      h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD)
    ).resolves.toMatchObject({ ids: ['m2'] });
    h.live().emit(resultMessage('m2'));
    await settled(h, 3);

    const types = h.rawStream().map((e) => e.type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(3);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(3);
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // The ledger has to be given up on the same terms the window is. An abandoned
  // turn's ids are DorkOS's declaration that the turn is over, so the late
  // `result` the backstop was compensating for must not then be read as evidence
  // about the successor — which is the `sentEarlier` branch closing the wrong
  // window all over again, one turn further along. Drop the `delete` loop in
  // `abandonStranded` and this goes red.
  it('does not let an abandoned turn’s late result close the successor’s window', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the one that hangs', messageId: 'm1' }]);
    // m1's result never comes; the next dispatch abandons its window.
    await h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);
    expect(h.windows.openWindow?.ids).toEqual(['m2']);

    // The process finally answers m1, long after DorkOS gave up on it.
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    // m2's turn is untouched, and closes on its OWN result.
    expect(h.windows.openWindow?.ids).toEqual(['m2']);
    h.live().emit(resultMessage('m2'));
    await settled(h, 3);
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // A crash empties the ledger: the process that owed those answers is gone, and
  // a `result` from a RELAUNCHED process under an old id is not evidence about
  // the new process's turn. Same reasoning as the held buffer's `onCrash` drop.
  it('forgets sent ids when the process dies', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    h.live().failStream(new Error('the CLI died'));
    await settled(h, 1);
    expect(h.pump.state).toBe('crashed');

    // The relaunch, and a stray result under the dead process's steer id.
    const dispatching = h.windows.dispatch([{ content: 'after the crash', messageId: 'm2' }], CWD);
    await vi.waitFor(() => expect(h.queries.length).toBe(2));
    h.live().emit(initMessage());
    await dispatching;

    h.live().emit(resultMessage('m-steer'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    // Untouched: the new process never read that id, so it says nothing about
    // the turn it is running now.
    expect(h.windows.openWindow?.ids).toEqual(['m2']);
  });
});

describe('a segment nobody dispatched is its own turn, from its first word (spec D6, T8)', () => {
  it('opens a runtime window at the first model frame, before any result', async () => {
    const h = harness();

    // One ordinary turn, closed. From here the process is warm with no window
    // open — the state a helper's wake-up arrives in.
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    h.live().emit(textDeltaMessage('answered'));
    h.live().emit(resultMessage('m1'));
    await settled(h, 1);

    // The CLI starts talking again with nothing dispatched. That first model
    // frame IS the turn starting, so it opens a window of its own at once —
    // today it is merely held, and only the eventual `result` opens one, which
    // is what puts the agent's words outside any turn until then.
    h.live().emit(textDeltaMessage('the helper finished'));
    await vi.waitFor(() => expect(h.opened.length).toBe(2));
    expect(h.opened[1]!.origin).toBe('runtime');
    expect(h.opened[1]!.ids).toEqual([]);

    // And it closes on the next `result`, carrying the words that opened it.
    h.live().emit(resultMessage());
    await settled(h, 2);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(2);
    expect(windows[1]!.origin).toBe('runtime');
    expect(
      windows[1]!.events.find((e) => e.type === 'text_delta') as { text?: string } | undefined
    ).toEqual(expect.objectContaining({ text: 'the helper finished' }));
  });
});
