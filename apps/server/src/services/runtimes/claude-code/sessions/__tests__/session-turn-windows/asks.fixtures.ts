/**
 * A warm session wired the way `PersistentDispatch` wires one, for the cases
 * about a background helper asking a person something after the parent's reply
 * ends (DOR-2698).
 *
 * Not a test file — a test-support module only.
 *
 * The whole hop a real card takes: the helper's tool call reaches the
 * production `canUseTool`, the card goes onto the session's event queue, the
 * between-turns notifier opens a window for it, and the production
 * `streamTurnWindow` and `feedProjector` carry it to a real session-state
 * projector. Answers go through the real `SessionStore.approveTool`.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows/asks
 */
import { expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';
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
import { CWD, resultMessage, textDeltaMessage } from './session-turn-windows.fixtures.js';
import { capturedHelperRun, HELPER_AGENT } from './helper-frames.fixtures.js';

export const SESSION_ID = 'sess-helper-asks';

/** One of the helper's captured Bash calls, as `canUseTool` hears it. */
function captured(call: number): { id: string; input: Record<string, unknown> } {
  const frame = capturedHelperRun().calls[call] as unknown as {
    message: { content: Array<{ id: string; input: Record<string, unknown> }> };
  };
  return frame.message.content[0]!;
}

/**
 * Build the session.
 *
 * @param hooks - `onEvent` sees each window's events as its stream yields them,
 *   with the window's index in opening order
 */
export function warmSession(
  hooks: { onEvent?: (windowIndex: number, event: StreamEvent) => void } = {}
) {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  const store = new SessionStore();
  store.ensureSession(SESSION_ID, { permissionMode: 'default' });
  const session = store.findSession(SESSION_ID)!;
  const projector = new SessionStateProjector(SESSION_ID);
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const streamEvents: StreamEvent[][] = [];
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
      const mine: StreamEvent[] = [];
      const index = streamEvents.push(mine) - 1;
      const events = streamTurnWindow({
        sessionId: SESSION_ID,
        session,
        window,
        opts: { cwd: CWD, onSdkSessionRebind: async () => {} },
        meshAgentId: undefined,
        suppressEmptyTurnError: runtime,
      });
      async function* tee(): AsyncGenerator<StreamEvent> {
        for await (const event of events) {
          mine.push(event);
          hooks.onEvent?.(index, event);
          yield event;
        }
      }
      projected.push(
        feedProjector(
          projector,
          tee(),
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
    streamEvents,
    live,
    projected,
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
    /**
     * One of the helper's captured Bash calls reaching the approval gate, as the CLI asks it.
     *
     * @param call - Which captured call: 0 or 1
     */
    helperAsks: (call = 0) => {
      const block = captured(call);
      return {
        toolUseId: block.id,
        answer: canUseTool('Bash', block.input, {
          signal: new AbortController().signal,
          toolUseID: block.id,
          agentID: HELPER_AGENT,
        }),
      };
    },
    /** Wait until the card for `toolUseId` is on the projected stream. */
    cardShown: async (toolUseId: string): Promise<void> => {
      await vi.waitFor(() =>
        expect(projector.replayFrom(0)).toContainEqual(
          expect.objectContaining({ type: 'approval_required', id: toolUseId })
        )
      );
    },
  };
}
