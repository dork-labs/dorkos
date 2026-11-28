/**
 * session-turn-windows: a background helper asks a person something after the
 * parent's reply ends (DOR-2698). The warm session these cases drive is in
 * `./asks.fixtures.ts`, the helper's captured frames in `./helper-frames.fixtures.ts`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import { turnCostReader } from '../../../../../observability/ai-metadata.js';
import { CWD, groupWindows, settlesWithin } from './session-turn-windows.fixtures.js';
import { capturedHelperRun, helperProgress } from './helper-frames.fixtures.js';
import { SESSION_ID, warmSession } from './asks.fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** What a turn meter reads as this turn's own cost, for a runtime whose cost is a running total. */
function meteredCost(events: StreamEvent[]): number | undefined {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => ({ costUsdIsRunningTotal: true }),
  } as unknown as Pick<AgentRuntime, 'type' | 'getCapabilities'>;
  const reader = turnCostReader(runtime);
  for (const event of events) reader.see(event);
  return reader.costUsd();
}

describe("a helper's ask after the reply ends (DOR-2698)", () => {
  it('reaches the chat in a turn of its own, which ends once the helper moves on', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { calls, results, delivery } = capturedHelperRun();
    await w.emitAll([calls[0]!]);
    expect(w.opened).toHaveLength(1);

    const { toolUseId, answer } = w.helperAsks();
    // The card opens a window, and its turn carries the card to the session's state.
    await w.cardShown(toolUseId);
    expect(w.opened.map((window) => window.origin)).toEqual(['user', 'runtime']);
    expect(w.projector.getStatus().lifecycle).toBe('blocked');

    expect(w.store.approveTool(SESSION_ID, toolUseId, true)).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'allow' });
    // The helper carries on: its tool result is the first frame after the answer.
    await w.emitAll([results[0]!]);
    expect(w.windows.openWindow).toBeUndefined();
    await Promise.all(w.projected);

    const turns = groupWindows(w.stream());
    expect(turns.map((t) => t.origin)).toEqual([undefined, 'runtime']);
    expect(turns[1]!.types).toContain('approval_required');
    expect(turns[1]!.types.at(-1)).toBe('turn_end');
    expect(turns[1]!.types).not.toContain('error');

    // The rest of the helper's run opens nothing until its report is delivered.
    await w.emitAll([calls[1]!]);
    expect(w.opened).toHaveLength(2);
    await w.emitAll(delivery);
    await vi.waitFor(() => expect(w.opened).toHaveLength(3));
    await vi.waitFor(() => expect(w.windows.openWindow).toBeUndefined());
    await Promise.all(w.projected);
    expect(groupWindows(w.stream()).map((t) => t.origin)).toEqual([
      undefined,
      'runtime',
      'runtime',
    ]);
  });

  it('counts the turn that only showed a card as costing nothing', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { toolUseId } = w.helperAsks();
    await w.cardShown(toolUseId);
    w.store.approveTool(SESSION_ID, toolUseId, true);
    await w.emitAll([capturedHelperRun().results[0]!]);
    await Promise.all(w.projected);

    const askTurn = w.streamEvents[1]!;
    expect(askTurn).toContainEqual(
      expect.objectContaining({
        type: 'session_status',
        data: expect.objectContaining({ turnCostUsd: 0 }),
      })
    );
    // Not the estimate a turn that reported no cost is counted at.
    expect(meteredCost(askTurn)).toBe(0);
  });

  it('stays open while the card still waits, whatever else the process writes', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { toolUseId } = w.helperAsks();
    await w.cardShown(toolUseId);

    // Another helper's progress and words arrive while the person decides.
    await w.emitAll([helperProgress(3), capturedHelperRun().between[1]!]);
    expect(w.windows.openWindow?.origin).toBe('runtime');
    expect(w.opened).toHaveLength(2);
    expect(w.session.pendingInteractions.has(toolUseId)).toBe(true);
  });

  it('becomes one turn when the report starts under a waiting card, ending on its own result', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { toolUseId } = w.helperAsks();
    await w.cardShown(toolUseId);
    const usageCallsBefore = w.live().contextUsageCalls;

    // The report's segment starts while the card waits; the person answers mid-report.
    const { delivery } = capturedHelperRun();
    const firstWord = delivery.findIndex(
      (f) =>
        f.type === 'stream_event' &&
        (f as { event?: { delta?: { type?: string } } }).event?.delta?.type === 'text_delta'
    );
    await w.emitAll(delivery.slice(0, firstWord + 1));
    w.store.approveTool(SESSION_ID, toolUseId, true);
    await w.emitAll(delivery.slice(firstWord + 1));
    await vi.waitFor(() => expect(w.windows.openWindow).toBeUndefined());
    await Promise.all(w.projected);

    expect(w.opened.map((window) => window.origin)).toEqual(['user', 'runtime']);
    const turns = groupWindows(w.stream());
    expect(turns).toHaveLength(2);
    expect(
      turns[1]!.events.filter((e) => e.type === 'text_delta' && e.text === 'PARENT-ANSWERS-REPORT')
    ).toHaveLength(1);
    // Closed on the CLI's own result, with the turn's accounting fetched.
    expect(w.live().contextUsageCalls).toBeGreaterThan(usageCallsBefore);
    expect(w.streamEvents[1]!.some((e) => e.type === 'context_usage')).toBe(true);
  });

  it('shows an ask raised as the card turn ends in a turn of its own, never after its end', async () => {
    let second: ReturnType<ReturnType<typeof warmSession>['helperAsks']> | undefined;
    const w = warmSession({
      onEvent: (windowIndex, event) => {
        // The helper's next call asks the moment the first card's turn says `done`.
        if (windowIndex === 1 && event.type === 'done') second = w.helperAsks(1);
      },
    });
    await w.firstTurn();
    const first = w.helperAsks();
    await w.cardShown(first.toolUseId);
    w.store.approveTool(SESSION_ID, first.toolUseId, true);
    await w.emitAll([capturedHelperRun().results[0]!]);

    await vi.waitFor(() => expect(second).toBeDefined());
    await w.cardShown(second!.toolUseId);
    const turns = groupWindows(w.stream());
    expect(turns.map((t) => t.origin)).toEqual([undefined, 'runtime', 'runtime']);
    expect(turns[2]!.events).toContainEqual(
      expect.objectContaining({ type: 'approval_required', id: second!.toolUseId })
    );
  });

  it('opens nothing for a heavy-job wait, so a message sent meanwhile goes straight through', async () => {
    const w = warmSession();
    await w.firstTurn();
    // The notice the load gate writes while the helper's job waits for a slot.
    w.session.eventQueue.push({
      type: 'system_status',
      data: { message: 'Waiting for a free slot', status: LOAD_WAIT_STATUS },
    } as StreamEvent);
    w.session.eventQueueNotify?.();
    expect(w.windows.openWindow).toBeUndefined();
    expect(w.opened).toHaveLength(1);

    const next = w.windows.dispatch([{ content: 'something else', messageId: 'm2' }], CWD);
    expect(await settlesWithin(next)).toBe('settled');
    expect((await next).origin).toBe('user');
  });

  // The queue keeps a person's message waiting while a card waits on them, as
  // it does for a card in any turn (DOR-3113). A dispatch that does reach the
  // windower must still not wait on the card for hours, nor lose it.
  it('lets a dispatch past a window that only holds a card, and keeps the card', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { toolUseId, answer } = w.helperAsks();
    await vi.waitFor(() => expect(w.opened).toHaveLength(2));

    const next = w.windows.dispatch([{ content: 'something else', messageId: 'm2' }], CWD);
    expect(await settlesWithin(next)).toBe('settled');
    expect((await next).origin).toBe('user');
    // The card is still open, and still answerable.
    expect(w.session.pendingInteractions.has(toolUseId)).toBe(true);
    await vi.waitFor(() => expect(w.projector.hasPendingInteractions()).toBe(true));
    expect(w.store.approveTool(SESSION_ID, toolUseId, false)).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  });
});
