/**
 * session-turn-windows: steers. Shared setup lives in `./session-turn-windows.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { initMessage } from '../fake-pump-query.js';
import {
  resultMessage,
  thinkingTokensMessage,
  errorResultMessage,
  textDeltaMessage,
  apiRetryMessage,
  type Harness,
  harness,
  settled,
} from './session-turn-windows.fixtures.js';

describe('a steered window waits for the continuation, and only for that (DOR-1314)', () => {
  /**
   * Open a window, steer into it, and let the CLI end the turn naming the
   * DISPATCHED message — the state every case below starts from. The steer is
   * still in the CLI's queue, so this window may not close yet.
   *
   * Nothing is awaited between the emits: the pump delivers them to the
   * windower in order, so a case that needs a message to land INSIDE the grace
   * passes it here rather than racing the clock with a poll.
   *
   * @param h - The harness driving it
   * @param inBurst - Messages to emit immediately behind the closing `result`,
   *   i.e. inside the grace it opens
   */
  async function steeredAndAnswered(h: Harness, inBurst: SDKMessage[] = []): Promise<void> {
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
    h.live().emit(textDeltaMessage('the first answer'));
    h.live().emit(resultMessage('m1'));
    for (const message of inBurst) h.live().emit(message);
  }

  /** Wait until the windower has been handed the `result` that opens the grace. */
  async function graceIsOpen(h: Harness): Promise<void> {
    await vi.waitFor(() => expect(h.seen.some((m) => m.type === 'result')).toBe(true));
  }

  it('is not closed by bookkeeping, and still has a real terminal after it', async () => {
    // The `system/init` an explicit warm produces, arriving inside the grace,
    // and then silence. Routine traffic, not a turn — so the clock must not
    // stop, and even if it did the window must still hold a real terminal.
    // Clearing the deferred `result` alongside the timer left it holding
    // nothing, and the window never closed at all: this hangs on that.
    const h = harness({ graceMs: 60, capMs: 150 });
    await steeredAndAnswered(h, [initMessage()]);

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.at(-1)).toBe('turn_end');
    // Closed on the CLI's own successful `result`, never on the synthetic
    // "the agent never finished this turn".
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });

  it('closes at the cap when the process chatters and never speaks', async () => {
    // A process that emits bookkeeping forever must not hold a finished turn
    // open forever. The frames keep re-arming a 40ms grace, and the 200ms cap
    // is what ends it — on the CLI's own `result`, never on a synthetic error,
    // because the terminal is held throughout.
    const h = harness({ graceMs: 40, capMs: 200 });
    await steeredAndAnswered(h);

    const chatter = setInterval(() => h.live().emit(apiRetryMessage(20)), 20);
    try {
      await settled(h, 1);
    } finally {
      clearInterval(chatter);
    }

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.at(-1)).toBe('turn_end');
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });

  it('restarts the wait when a person steers into the grace', async () => {
    // 400ms of grace, spent in two 200ms halves with a steer between them. The
    // second half ends 200ms past the ORIGINAL deadline, so only a restarted
    // clock still has this window open when the answer arrives.
    const h = harness({ graceMs: 400 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // The agent has just gone quiet, which is exactly when a person types.
    expect(h.windows.steerOpenWindow('steer-2')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.live().emit(textDeltaMessage('answering the second steer'));
    h.live().emit(resultMessage('steer-2'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'answering the second steer'
      )
    ).toBe(true);
  });

  /**
   * `queued_turn_count` may only ever ADD to the wait, never shorten it. Every
   * case below is about that asymmetry.
   */
  describe("the CLI's own count of what is still queued (SDK 0.3.243)", () => {
    // A positive count is the CLI stating, about its own queue, that another
    // turn runs without anybody sending anything else. That is evidence, so the
    // window waits toward the CAP rather than the short grace — a 40ms grace
    // against a 400ms cap, with the continuation arriving at 150ms, is red
    // unless the count was read.
    it('waits toward the cap when the CLI says a turn is still queued', async () => {
      const h = harness({ graceMs: 40, capMs: 400 });

      await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
      expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
      h.live().emit(textDeltaMessage('the first answer'));
      h.live().emit(resultMessage('m1', { queued_turn_count: 1 }));

      await new Promise((resolve) => setTimeout(resolve, 150));
      h.live().emit(textDeltaMessage('and the steer, in its own turn'));
      h.live().emit(resultMessage('steer-1'));
      await settled(h, 1);

      const windows = h.windowsOnStream();
      expect(windows).toHaveLength(1);
      expect(
        windows[0]!.events.some(
          (e) => e.type === 'text_delta' && e.text === 'and the steer, in its own turn'
        )
      ).toBe(true);
    });

    // Deliberately NOT tested here: that a negative count is normalized away.
    // `readQueuedTurnCount` does normalize it, but the only reader asks
    // `> 0` — so a negative and an absent field take the same branch, and any
    // test written against a window could not tell them apart. It would pass
    // whether the guard existed or not, which is the one thing a test may never
    // do. The guard is there so the function's own contract ("a count of zero or
    // more, or nothing") holds for the next reader; see its TSDoc.

    // A FAILED turn gets the same treatment, and that is a decision rather than
    // an oversight. The module used to call an error result terminal whatever
    // was outstanding — which it got for free, because before SDK 0.3.268 an
    // `SDKResultError` carried no id and could not reach this wait at all. It
    // names its dispatch now, and the snapshot race above applies to a steer at
    // the tail of a FAILING turn exactly as it does to a healthy one. DorkOS
    // cannot tell whether the CLI ran or discarded that steer, so it waits the
    // short grace and shows the answer if one comes.
    it('gives a failed turn the same short grace, and shows the answer if it comes', async () => {
      const h = harness({ graceMs: 200, capMs: 400 });

      await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
      expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
      h.live().emit({
        ...(errorResultMessage() as unknown as Record<string, unknown>),
        user_message_uuid: 'm1',
        queued_turn_count: 0,
      } as unknown as SDKMessage);
      h.live().emit(textDeltaMessage('answering the steer after the failure'));
      h.live().emit(resultMessage('steer-1'));

      await settled(h, 1);
      const windows = h.windowsOnStream();
      expect(windows).toHaveLength(1);
      expect(
        windows[0]!.events.some(
          (e) => e.type === 'text_delta' && e.text === 'answering the steer after the failure'
        )
      ).toBe(true);
    });
  });

  // A steer answered by a THINKING turn. The CLI has started the continuation
  // but says nothing while thinking is redacted — only `thinking_tokens` frames,
  // which since SDK 0.3.260 name the message whose turn they belong to. Read as
  // mere proof of life they merely postpone the close to the cap, and extended
  // thinking outruns any cap: a 120ms cap against 250ms of thinking drops the
  // whole continuation into a runtime window nothing projects, which is the
  // DOR-1314 loss reached by a different road.
  it('lets a thinking continuation outlast the cap when the frame names the steer', async () => {
    const h = harness({ graceMs: 40, capMs: 120 });
    await steeredAndAnswered(h, [thinkingTokensMessage('steer-1')]);

    await new Promise((resolve) => setTimeout(resolve, 250));
    h.live().emit(textDeltaMessage('here is what I thought about'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'here is what I thought about'
      )
    ).toBe(true);
  });

  it('hands a dispatch the real result, not an abandonment', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    // The person gives up waiting and sends the next message. The window in
    // hand finished its turn — it was only waiting to see whether more was
    // coming — so it settles on the CLI's own `result`.
    await h.dispatch([{ content: 'next thing', messageId: 'm2' }]);
    // The successor says something: an EMPTY turn waits for its answer
    // (DOR-2064), and this case's hour-long grace would hang on that wait.
    h.live().emit(textDeltaMessage('on it'));
    h.live().emit(resultMessage('m2'));
    await settled(h, 2);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(2);
    // No synthetic error anywhere: this is what separates settling on the real
    // result from abandoning the window, and it is the whole assertion.
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
    // The predecessor kept its own answer rather than losing it to the successor.
    expect(
      windows[0]!.events.some((e) => e.type === 'text_delta' && e.text === 'the first answer')
    ).toBe(true);
  });

  it('lets a crash mid-grace close the window once, as a crash', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    h.live().failStream(new Error('the CLI died'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(true);
  });
});
