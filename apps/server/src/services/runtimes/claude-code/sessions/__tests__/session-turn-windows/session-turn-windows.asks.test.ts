/**
 * session-turn-windows: a background helper asks a person something after the
 * parent's reply ends (DOR-2698).
 *
 * The whole hop a real card takes on a warm process: the helper's tool call
 * reaches the production `canUseTool`, the card goes onto the session's event
 * queue, the between-turns notifier opens a window for it, and the production
 * `streamTurnWindow` and `feedProjector` carry it to a real session-state
 * projector. The answer goes through the real `SessionStore.approveTool`.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { logger } from '../../../../../../lib/logger.js';
import { feedProjector } from '../../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../../session/session-state-projector.js';
import { createCanUseTool } from '../../../messaging/interactive-handlers.js';
import { openTurnsForAsks } from '../../dispatch/asks-between-turns.js';
import { streamTurnWindow } from '../../pump-turn-stream.js';
import { SessionPump } from '../../session-pump.js';
import { isWaitingOnPerson, SessionStore } from '../../session-store.js';
import { SessionTurnWindows, type TurnWindow } from '../../session-turn-windows.js';
import { FakeQuery, initMessage } from '../fake-pump-query.js';
import {
  CWD,
  groupWindows,
  resultMessage,
  settledOrPending,
  textDeltaMessage,
} from './session-turn-windows.fixtures.js';
import { capturedHelperRun, HELPER_AGENT } from './helper-frames.fixtures.js';

const SESSION_ID = 'sess-helper-asks';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A warm session wired the way `PersistentDispatch` wires one, with a real projector behind it. */
function warmSession() {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;
  const projector = new SessionStateProjector(SESSION_ID);
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const projected: Promise<void>[] = [];
  const seen: SDKMessage[] = [];
  const ref: { windows?: SessionTurnWindows } = {};
  const pump = new SessionPump({
    sessionId: SESSION_ID,
    launch: () => {
      const query = new FakeQuery();
      queries.push(query);
      return query;
    },
    onMessage: (message) => {
      seen.push(message);
      ref.windows?.onMessage(message);
    },
    onCrash: (crash) => ref.windows?.onCrash(crash),
    drainGraceMs: 20,
  });
  const windows = new SessionTurnWindows({
    sessionId: SESSION_ID,
    pump,
    usageTimeoutMs: 200,
    waitingOnPerson: () => isWaitingOnPerson(session, Date.now()),
    onWindowOpen: (window) => {
      opened.push(window);
      const runtime = window.origin === 'runtime';
      const events = streamTurnWindow({
        sessionId: SESSION_ID,
        session,
        window,
        opts: { cwd: CWD, onSdkSessionRebind: async () => {} },
        meshAgentId: undefined,
        suppressEmptyTurnError: runtime,
      });
      projected.push(
        feedProjector(
          projector,
          events,
          runtime ? { origin: 'runtime' as const } : { userMessage: 'start a helper' }
        )
      );
    },
  });
  ref.windows = windows;
  openTurnsForAsks(session, () => windows.openForAsk());
  const canUseTool = createCanUseTool(session, { debug: () => {}, info: () => {} });
  const live = (): FakeQuery => queries[queries.length - 1]!;

  return {
    store,
    session,
    projector,
    windows,
    opened,
    live,
    stream: (): SessionEvent[] => projector.replayFrom(0),
    /** Emit frames and wait until the windower has been handed every one. */
    emitAll: async (frames: SDKMessage[]): Promise<void> => {
      const target = seen.length + frames.length;
      for (const frame of frames) live().emit(frame);
      await vi.waitFor(() => expect(seen.length).toBe(target));
    },
    /** The person's first turn, then the parent's reply ends. */
    firstTurn: async (): Promise<void> => {
      const dispatching = windows.dispatch([{ content: 'start a helper', messageId: 'm1' }], CWD);
      await vi.waitFor(() => expect(queries.length).toBe(1));
      live().emit(initMessage());
      await dispatching;
      live().emit(capturedHelperRun().started);
      live().emit(textDeltaMessage('a helper is on it'));
      live().emit(resultMessage('m1'));
      await vi.waitFor(() => expect(windows.openWindow).toBeUndefined());
      await Promise.all(projected);
    },
    /** The helper's first Bash call reaching the approval gate, as the CLI asks it. */
    helperAsks: () => {
      const call = capturedHelperRun().calls[0] as unknown as {
        message: { content: Array<{ id: string; input: Record<string, unknown> }> };
      };
      const block = call.message.content[0]!;
      return {
        toolUseId: block.id,
        answer: canUseTool('Bash', block.input, {
          signal: new AbortController().signal,
          toolUseID: block.id,
          agentID: HELPER_AGENT,
        }),
      };
    },
    projected,
  };
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
    await vi.waitFor(() =>
      expect(w.stream()).toContainEqual(
        expect.objectContaining({ type: 'approval_required', id: toolUseId })
      )
    );
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

  // The queue keeps a person's message waiting while a card waits on them, as
  // it does for a card in any turn (DOR-3113). A dispatch that does reach the
  // windower must still not wait on the card for hours, nor lose it.
  it('lets a dispatch past a window that only holds a card, and keeps the card', async () => {
    const w = warmSession();
    await w.firstTurn();
    const { toolUseId, answer } = w.helperAsks();
    await vi.waitFor(() => expect(w.opened).toHaveLength(2));

    const next = w.windows.dispatch([{ content: 'something else', messageId: 'm2' }], CWD);
    expect(await settledOrPending(next)).toBe('settled');
    expect((await next).origin).toBe('user');
    // The card is still open, and still answerable.
    expect(w.session.pendingInteractions.has(toolUseId)).toBe(true);
    await vi.waitFor(() => expect(w.projector.hasPendingInteractions()).toBe(true));
    expect(w.store.approveTool(SESSION_ID, toolUseId, false)).toBe(true);
    await expect(answer).resolves.toMatchObject({ behavior: 'deny' });
  });
});
