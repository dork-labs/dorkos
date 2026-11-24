/**
 * session-turn-windows: empty turns. Shared setup lives in `./session-turn-windows.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../../../../../lib/logger.js';
import { SessionTurnWindows, type TurnWindow } from '../../session-turn-windows.js';
import { initMessage } from '../fake-pump-query.js';
import {
  SESSION_ID,
  CWD,
  resultMessage,
  textDeltaMessage,
  apiRetryMessage,
  harness,
  settled,
} from './session-turn-windows.fixtures.js';

// Spec `warm-process-lifecycle` D5, tests T1–T2 (DOR-2064). A relaunched CLI
// drains its own queued notification before it answers the person, so the
// dispatched window's first `result` can arrive with nothing in the turn.
describe('an empty dispatched window waits for its answer (DOR-2064)', () => {
  it('T1: carries the answer that runs after an early zero-content result the dispatch named', async () => {
    const h = harness({ graceMs: 40, emptyCloseCapMs: 5_000 });
    await h.dispatch([{ content: 'what did the helper find?', messageId: 'm1' }]);
    h.live().emit(resultMessage('m1'));
    // The next segment's first frame: not content, but proof of life.
    h.live().emit(initMessage());

    // Well past the 40ms grace: only the extension to the empty-close cap keeps
    // the window open across it. The sleep IS the gap under test.
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.live().emit(textDeltaMessage('three tests fail'));
    h.live().emit(resultMessage('m1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.origin).toBeUndefined();
    expect(
      windows[0]!.events.some((e) => e.type === 'text_delta' && e.text === 'three tests fail')
    ).toBe(true);
    expect(windows[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });

  it('T2: a genuinely empty turn still closes at the cap, on its own result, and says why', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const h = harness({ graceMs: 40, emptyCloseCapMs: 250 });
      await h.dispatch([{ content: 'are you there?', messageId: 'm1' }]);
      h.live().emit(resultMessage('m1', { result_index: 1 }));

      // Chatter that never becomes content re-arms within the cap, never past it.
      const startedAt = Date.now();
      const chatter = setInterval(() => h.live().emit(apiRetryMessage(20)), 20);
      try {
        await settled(h, 1);
        await vi.waitFor(() => expect(h.closedWindows).toHaveLength(1));
      } finally {
        clearInterval(chatter);
      }
      // A duration floor, deliberately: closing before the cap is the defect.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);

      const windows = h.windowsOnStream();
      expect(windows).toHaveLength(1);
      expect(windows[0]!.types.at(-1)).toBe('turn_end');
      const line = warn.mock.calls.find((call) =>
        String(call[0]).includes('closed a turn with nothing in it')
      );
      expect(line?.[1]).toMatchObject({ sessionId: SESSION_ID, answered: ['m1'], resultIndex: 1 });
    } finally {
      warn.mockRestore();
    }
  });

  it('never files an id answered earlier in the same launch, even behind a later result', async () => {
    const closed: TurnWindow[] = [];
    const ref: { windows?: SessionTurnWindows } = {};
    const windows = new SessionTurnWindows({
      sessionId: SESSION_ID,
      continuationGraceMs: 20,
      emptyCloseCapMs: 20,
      pump: {
        // Two `result`s land during the dispatch await: the one that answers the
        // dispatch, then one naming nothing. The window holds the LATER one.
        dispatch: (batch) => {
          if (batch[0]!.messageId === 'm-fast') {
            ref.windows!.onMessage(resultMessage('m-fast'));
            ref.windows!.onMessage(resultMessage());
          }
          return Promise.resolve();
        },
        endTurn: () => {},
        controlQuery: undefined,
      },
      onWindowOpen: (w) =>
        void (async () => {
          for await (const _m of w.messages) void _m;
        })(),
      onWindowClose: (w) => closed.push(w),
    });
    ref.windows = windows;

    await windows.dispatch([{ content: 'answered instantly', messageId: 'm-fast' }], CWD);
    await vi.waitFor(() => expect(closed).toHaveLength(1));

    await windows.dispatch([{ content: 'the real next turn', messageId: 'm2' }], CWD);
    windows.onMessage(resultMessage('m-fast'));

    expect(windows.openWindow?.ids).toEqual(['m2']);
  });
});
