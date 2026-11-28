/**
 * session-turn-windows: a background helper that keeps working after its
 * parent's reply ends (DOR-2698). Shared setup lives in
 * `./session-turn-windows.fixtures.ts`, the helper's frames in
 * `./helper-frames.fixtures.ts`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../../lib/logger.js';
import { SessionTurnWindows } from '../../session-turn-windows.js';
import {
  bareWindowedPump,
  CWD,
  resultMessage,
  textDeltaMessage,
  harness,
  settled,
  useFakeClock,
  type Harness,
} from './session-turn-windows.fixtures.js';
import {
  capturedHelperRun,
  helperProgress,
  helperToolCall,
  helperToolResult,
  HELPER_TASK,
  lateMainToolResult,
  mainToolCallStart,
} from './helper-frames.fixtures.js';

/** Emit frames and wait until the windower has been handed every one of them. */
async function emitAll(h: Harness, frames: SDKMessage[]): Promise<void> {
  const target = h.seen.length + frames.length;
  for (const frame of frames) h.live().emit(frame);
  await vi.waitFor(() => expect(h.seen.length).toBe(target));
}

/** Run the person's first turn, in which the helper is started. */
async function firstTurn(h: Harness, extra: SDKMessage[] = []): Promise<void> {
  await h.dispatch([{ content: 'start a helper', messageId: 'm1' }]);
  await emitAll(h, [
    capturedHelperRun().started,
    ...extra,
    textDeltaMessage('a helper is on it'),
    resultMessage('m1'),
  ]);
  await settled(h, 1);
}

/** The lines the windower logged about helper frames it left out. */
function accountingLines(info: { mock: { calls: unknown[][] } }): unknown[][] {
  return info.mock.calls.filter((call) => String(call[0]).includes("left a helper's frames out"));
}

describe('a helper working after the reply ends (DOR-2698)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens no turn for the helper, and shows its report once, in the turn that delivers it', async () => {
    const h = harness();
    const run = capturedHelperRun();
    // Inside the person's turn the helper is shown live, as it always was.
    await firstTurn(h, [capturedHelperRun().between[1]!]);

    await emitAll(h, run.between);
    // The helper alone started nothing: no turn, so nothing holds the chat.
    expect(h.opened).toHaveLength(1);

    await emitAll(h, run.delivery);
    await settled(h, 2);

    expect(h.windowsOnStream().map((w) => w.origin)).toEqual([undefined, 'runtime']);
    const reports = h
      .rawStream()
      .filter((e) => e.type === 'text_delta' && e.text === 'PARENT-ANSWERS-REPORT');
    expect(reports).toHaveLength(1);
    const types = (i: number) => h.streamEvents[i]!.map((e) => e.type);
    expect(types(0)).toContain('subagent_text_delta');
    expect(types(1).filter((t) => t === 'background_task_done')).toHaveLength(1);
    // The progress line the CLI wrote while no turn was open still arrives, newest only.
    expect(h.streamEvents[1]!.filter((e) => e.type === 'background_task_progress')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ toolUses: 2 }) }),
    ]);
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

    await emitAll(h, capturedHelperRun().delivery);
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
    expect(accountingLines(info)).toEqual([
      [
        expect.any(String),
        expect.objectContaining({ dropped: 1200, byType: { assistant: 600, user: 600 } }),
      ],
    ]);
  });

  it('keeps the newest progress line of every task run, not just one', async () => {
    const h = harness();
    await firstTurn(h);
    const other = { taskId: 'made-up-task-b', runId: 'run-b-1' };
    const rerun = { taskId: HELPER_TASK.taskId, runId: 'run-a-2' };
    await emitAll(h, [
      helperProgress(1),
      helperProgress(1, other),
      helperProgress(2),
      helperProgress(1, rerun),
      helperProgress(2, other),
    ]);
    await emitAll(h, capturedHelperRun().delivery);
    await settled(h, 2);

    const progress = h.streamEvents[1]!.filter((e) => e.type === 'background_task_progress');
    expect(progress.map((e) => e.data as { taskId: string; toolUses: number })).toEqual([
      expect.objectContaining({ taskId: HELPER_TASK.taskId, toolUses: 2 }),
      expect.objectContaining({ taskId: HELPER_TASK.taskId, toolUses: 1 }),
      expect.objectContaining({ taskId: other.taskId, toolUses: 2 }),
    ]);
  });

  it('counts the helper frames it left out when the process dies before another turn', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = harness();
    await firstTurn(h);
    const { calls, results } = capturedHelperRun();
    await emitAll(h, [calls[0]!, results[0]!, calls[1]!]);
    expect(accountingLines(info)).toEqual([]);

    h.live().failStream(new Error('the process went away'));
    await vi.waitFor(() => expect(accountingLines(info)).toHaveLength(1));
    expect(accountingLines(info)[0]![1]).toMatchObject({
      dropped: 3,
      byType: { assistant: 2, user: 1 },
    });
  });

  it('applies the same two rules when a refused dispatch puts its frames back on hold', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const pump = bareWindowedPump();
    let refuse!: (err: Error) => void;
    pump.dispatch = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        })
    );
    const windows = new SessionTurnWindows({ sessionId: 'sess-rehold', pump, usageTimeoutMs: 50 });
    const refused = windows.dispatch([{ content: 'first try', messageId: 'm1' }], CWD);
    await vi.waitFor(() => expect(pump.dispatch).toHaveBeenCalled());
    // What the process says while that dispatch is in flight lands in its window.
    const { calls, results } = capturedHelperRun();
    for (const frame of [calls[0]!, helperProgress(1), results[0]!, helperProgress(2)]) {
      windows.onMessage(frame);
    }
    refuse(new Error('refused'));
    await expect(refused).rejects.toThrow('refused');

    pump.dispatch = vi.fn(async () => {});
    const window = await windows.dispatch([{ content: 'second try', messageId: 'm2' }], CWD);
    windows.onMessage(textDeltaMessage('ok'));
    windows.onMessage(resultMessage('m2'));
    const carried: SDKMessage[] = [];
    for await (const message of window.messages) carried.push(message);

    expect(
      carried.filter((m) => (m as { parent_tool_use_id?: unknown }).parent_tool_use_id)
    ).toEqual([]);
    const progress = carried.filter(
      (m) => m.type === 'system' && (m as { subtype?: unknown }).subtype === 'task_progress'
    );
    expect(progress.map((m) => (m as { usage: { tool_uses: number } }).usage.tool_uses)).toEqual([
      2,
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
    h.live().emit(capturedHelperRun().between[1]!);
    await vi.waitFor(() => expect(h.seen).toHaveLength(4));

    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(h.closedWindows).toHaveLength(1));
    await settled(h, 1);
    expect(h.windowsOnStream()[0]!.types.at(-1)).toBe('turn_end');
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });
});
