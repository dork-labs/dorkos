/**
 * session-turn-windows: a background helper that keeps working after its
 * parent's reply ends (DOR-2698). Shared setup lives in
 * `./session-turn-windows.fixtures.ts`, the helper's frames in
 * `./helper-frames.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../../lib/logger.js';
import {
  resultMessage,
  textDeltaMessage,
  harness,
  settled,
  useFakeClock,
  type Harness,
} from './session-turn-windows.fixtures.js';
import {
  capturedHelperLifecycle,
  helperProgress,
  helperText,
  helperTextDelta,
  helperToolCall,
  helperToolResult,
  lateMainToolResult,
  mainToolCallStart,
} from './helper-frames.fixtures.js';

/** Emit frames and wait until the windower has been handed every one of them. */
async function emitAll(h: Harness, frames: SDKMessage[]): Promise<void> {
  const target = h.seen.length + frames.length;
  for (const frame of frames) h.live().emit(frame);
  await vi.waitFor(() => expect(h.seen.length).toBe(target));
}

/** The CLI delivering the helper's report: its settle, a new segment, and the agent speaking. */
function delivery(report: string): SDKMessage[] {
  const captured = capturedHelperLifecycle();
  return [
    captured.updated,
    captured.notification,
    captured.deliveryInit,
    captured.deliveryFirstAssistant,
    textDeltaMessage(report),
    resultMessage(),
  ];
}

describe('a helper working after the reply ends (DOR-2698)', () => {
  it('opens no turn for the helper, and shows its report once, in the turn that delivers it', async () => {
    const h = harness();
    const { started } = capturedHelperLifecycle();
    await h.dispatch([{ content: 'start a helper', messageId: 'm1' }]);
    // Inside the person's turn the helper is shown live, as it always was.
    await emitAll(h, [
      started,
      helperText('looking now'),
      textDeltaMessage('a helper is on it'),
      resultMessage('m1'),
    ]);
    await settled(h, 1);

    await emitAll(h, [
      helperToolCall(1),
      helperTextDelta('sleeping'),
      helperToolResult(1),
      helperProgress(1),
      helperText('Done.'),
    ]);
    // The helper alone started nothing: no turn, so nothing holds the chat.
    expect(h.opened).toHaveLength(1);

    await emitAll(h, delivery('The helper says: Done.'));
    await settled(h, 2);

    expect(h.windowsOnStream().map((w) => w.origin)).toEqual([undefined, 'runtime']);
    const reports = h
      .rawStream()
      .filter((e) => e.type === 'text_delta' && e.text === 'The helper says: Done.');
    expect(reports).toHaveLength(1);
    const types = (i: number) => h.streamEvents[i]!.map((e) => e.type);
    expect(types(0)).toContain('subagent_text_delta');
    expect(types(1).filter((t) => t === 'background_task_done')).toHaveLength(1);
    // The progress line the CLI wrote while no turn was open still arrives.
    expect(types(1)).toContain('background_task_progress');
    // The helper's own words from between the turns are not replayed into this one.
    expect(types(1)).not.toContain('subagent_text_delta');
  });

  it('keeps what the agent said between turns, however long the helper works', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const h = harness();
    await h.dispatch([{ content: 'build it and check', messageId: 'm1' }]);
    await emitAll(h, [
      mainToolCallStart('toolu_build'),
      textDeltaMessage('building, and a helper is checking'),
      resultMessage('m1'),
    ]);
    await settled(h, 1);

    // The build the turn started answers after the turn ended, then the helper
    // works far longer than the hold could keep frame by frame.
    const long: SDKMessage[] = [lateMainToolResult('toolu_build')];
    for (let n = 1; n <= 600; n += 1) {
      long.push(helperToolCall(n), helperToolResult(n), helperProgress(n));
    }
    await emitAll(h, long);
    expect(h.opened).toHaveLength(1);

    await emitAll(h, delivery('All 600 checks passed.'));
    await settled(h, 2);

    const second = h.streamEvents[1]!;
    expect(second).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        data: expect.objectContaining({ toolCallId: 'toolu_build' }),
      })
    );
    // Only the newest progress line: it already counts every call before it.
    const progress = second.filter((e) => e.type === 'background_task_progress');
    expect(progress).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ toolUses: 600 }) }),
    ]);
    expect(second.filter((e) => e.type === 'background_task_done')).toHaveLength(1);
    expect(warn.mock.calls.map(([line]) => line)).not.toContain(
      '[SessionTurnWindows] dropped a held message; no window has opened'
    );
    // What was left out is counted, once, when the next turn opened.
    const accounting = info.mock.calls.filter(([line]) => String(line).includes('helper'));
    expect(accounting).toEqual([
      [
        expect.stringContaining('helper'),
        expect.objectContaining({ dropped: 1200, byType: { assistant: 600, user: 600 } }),
      ],
    ]);
  });

  it("does not hold a finished turn open on a helper's frames", async () => {
    // A steered window waits briefly to see whether the steer gets a turn of
    // its own. The helper talking is not that turn starting.
    useFakeClock();
    const h = harness({ graceMs: 40, capMs: 200 });
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
    h.live().emit(textDeltaMessage('the first answer'));
    h.live().emit(resultMessage('m1'));
    h.live().emit(helperText('still checking'));
    await vi.waitFor(() => expect(h.seen).toHaveLength(4));

    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(h.closedWindows).toHaveLength(1));
    await settled(h, 1);
    expect(h.windowsOnStream()[0]!.types.at(-1)).toBe('turn_end');
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });
});
