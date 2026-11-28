/**
 * Several background helpers finishing at the same moment, for the turn-window
 * cases about a burst of helper reports (DOR-2829).
 *
 * Not a test file — a test-support module only.
 *
 * **Captured.** Each `../fixtures/helper-burst-<shape>-sdk-0.3.304.jsonl` is
 * every frame, verbatim and in stream order, of one real CLI 0.3.304 run
 * against a fake model on 127.0.0.1 with a made-up key and throwaway homes, in
 * `bypassPermissions` mode with `forwardSubagentText` and
 * `includePartialMessages` on. The parent started three background helpers in
 * one turn; the fake model held each helper's final answer until all three had
 * asked for it, then sent them together, so the three reports reached the CLI
 * within a few milliseconds of each other. The shapes:
 *
 * - `between`: the parent replied and ended its turn before the helpers
 *   finished. The CLI then opened one segment per report: the first two ended
 *   at once with nothing in them (`num_turns: 0`, no message ids), and the
 *   third carried the parent's answer to all three.
 * - `live`: the parent ran a four-second `sleep` while the helpers finished, so
 *   the reports landed inside its turn, beside that tool's result, and the
 *   parent answered them in the same turn.
 *
 * The changes from the wire: the machine's temporary paths are replaced with
 * made-up `/tmp/made-up-…` placeholders, and the message id the probe wrote is
 * renamed here to `m1`, the id the harness dispatches.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows/helper-burst
 */
import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';
import { feedProjector } from '../../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../../session/session-state-projector.js';
import { streamTurnWindow } from '../../pump-turn-stream.js';
import { SessionPump } from '../../session-pump.js';
import { SessionStore } from '../../session-store.js';
import { SessionTurnWindows, type TurnWindow } from '../../session-turn-windows.js';
import { FakeQuery } from '../fake-pump-query.js';
import { CWD } from './session-turn-windows.fixtures.js';

/** Which captured run. */
export type BurstShape = 'between' | 'live';

/** The id the probe stamped on its message, and the id the harness uses. */
const PROBE_ID = '00000000-0000-4000-8000-000000000001';

/** The text the parent wrote when it answered the three reports. */
export const REPORT_ANSWER = 'PARENT-ANSWERS-3-REPORTS';

/**
 * Every frame of one captured run, parsed fresh so a test may not change
 * another's, with the probe's id renamed.
 *
 * @param shape - Which run
 */
export function capturedBurst(shape: BurstShape): SDKMessage[] {
  const jsonl = readFileSync(
    new URL(`../fixtures/helper-burst-${shape}-sdk-0.3.304.jsonl`, import.meta.url),
    { encoding: 'utf8' }
  );
  return jsonl
    .split(PROBE_ID)
    .join('m1')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SDKMessage);
}

/** The index of the first frame matching `test`, failing loudly when there is none. */
export function indexOf(frames: SDKMessage[], test: (frame: SDKMessage) => boolean): number {
  const index = frames.findIndex(test);
  if (index < 0) throw new Error('the capture has no such frame');
  return index;
}

/** Whether a frame is a `system` frame of this subtype. */
export function isSystem(frame: SDKMessage, subtype: string): boolean {
  return frame.type === 'system' && (frame as { subtype?: unknown }).subtype === subtype;
}

/**
 * A warm session wired the way `PersistentDispatch` wires one: a real pump, the
 * windower, the production `streamTurnWindow` for each window, and a real
 * projector. Windows are projected one after another, as the session's
 * write-lock makes them in production.
 *
 * @param sessionId - The session's id
 */
export function burstSession(sessionId: string) {
  const store = new SessionStore();
  store.ensureSession(sessionId, { permissionMode: 'default' });
  const session = store.findSession(sessionId)!;
  const projector = new SessionStateProjector(sessionId);
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const streamEvents: StreamEvent[][] = [];
  const lifecycles: string[] = [];
  const seen: SDKMessage[] = [];
  const ref: { windows?: SessionTurnWindows } = {};
  let chain: Promise<void> = Promise.resolve();
  const pump = new SessionPump({
    sessionId,
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
    sessionId,
    pump,
    usageTimeoutMs: 50,
    onWindowOpen: (window) => {
      opened.push(window);
      const runtime = window.origin === 'runtime';
      const mine: StreamEvent[] = [];
      streamEvents.push(mine);
      const events = streamTurnWindow({
        sessionId,
        session,
        window,
        opts: { cwd: CWD, onSdkSessionRebind: async () => {} },
        meshAgentId: undefined,
        suppressEmptyTurnError: runtime,
      });
      async function* tee(): AsyncGenerator<StreamEvent> {
        for await (const event of events) {
          mine.push(event);
          yield event;
        }
      }
      chain = chain.then(async () => {
        await feedProjector(
          projector,
          tee(),
          runtime ? { origin: 'runtime' as const } : { userMessage: 'a message' }
        );
        lifecycles.push(projector.getStatus().lifecycle);
      });
    },
  });
  ref.windows = windows;
  const live = (): FakeQuery => queries[queries.length - 1]!;

  return {
    session,
    projector,
    windows,
    opened,
    streamEvents,
    lifecycles,
    live,
    /** Every window projected so far, in order. */
    projected: (): Promise<void> => chain,
    stream: (): SessionEvent[] => projector.replayFrom(0),
    /** Emit frames and wait until the windower has been handed every one. */
    emitAll: async (frames: SDKMessage[]): Promise<void> => {
      const target = seen.length + frames.length;
      for (const frame of frames) live().emit(frame);
      await vi.waitFor(() => expect(seen.length).toBe(target));
    },
    /** Dispatch a message, booting the process on the first one. */
    dispatch: async (messageId: string, content: string): Promise<TurnWindow> => {
      const dispatching = windows.dispatch([{ content, messageId }], CWD);
      if (queries.length === 0) await vi.waitFor(() => expect(queries.length).toBe(1));
      return dispatching;
    },
  };
}
