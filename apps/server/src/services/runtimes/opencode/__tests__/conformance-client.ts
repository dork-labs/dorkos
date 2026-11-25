/**
 * The mocked OpenCode sidecar client the conformance suites run against: the
 * host OpenCode suite and the computer-local one (DOR-4902), so both prove the
 * same contract over the same script.
 */
import { vi } from 'vitest';
import type { GlobalEvent, Message, Part } from '@opencode-ai/sdk';
import { TurnEventQueue } from '../events/global-event-hub.js';
import type { OpenCodeWireEvent } from '../events/event-mapper.js';
import {
  OC_SESSION_A,
  assistantMessage,
  globalEvent,
  serverConnected,
  sessionCompacted,
  sessionIdle,
  sessionInfo,
  statusEvent,
  textPart,
  userMessage,
} from './opencode-sse-fixtures.js';

/**
 * What the sidecar's durable store holds for a session: the shape
 * `session.messages` answers with, and the one `getMessageHistory` reads.
 */
export type StoredMessages = Array<{ info: Message; parts: Part[] }>;

/**
 * The prompt every conformance turn sends. Shared with the suite (via
 * `messageContent`) and with the scripted turn's echo of it, so the sidecar
 * mock cannot drift from what was actually sent — the invariant that forbids a
 * turn from speaking its own prompt back is only as honest as that match.
 */
export const CONFORMANCE_PROMPT = 'conformance ping';

/**
 * Mock sidecar client for one conformance runtime. The conformance suite
 * drains `sendMessage` to completion and cannot push wire events mid-turn, so
 * every `/global/event` connection is minted with ONE full scripted turn
 * PRE-QUEUED (the caller-provided `turn`): the runtime registers the turn's
 * demux listener before the hub's pump connects, and `TurnEventQueue`
 * buffers, so early-queued events are simply drained once mapping starts.
 * `session.get` reports the SAME directory the event envelopes carry — the
 * demux key is strict string equality on `{directory, sessionID}`, and any
 * drift drops every event.
 *
 * @param turn - The scripted turn every event connection replays.
 * @param projectDir - The folder the session and its events name.
 * @param stored - What the store answers for the turn, when not a tidy success.
 */
export function makeConformanceClient(
  turn: OpenCodeWireEvent[],
  projectDir: string,
  stored?: StoredMessages
) {
  const info = sessionInfo(OC_SESSION_A, projectDir);
  return {
    global: {
      event: vi.fn(async (options?: { signal?: AbortSignal }) => {
        const queue = new TurnEventQueue<GlobalEvent>();
        // End (never fail) on hub abort: the post-turn unsubscribe must read
        // as a quiet client-side wind-down, not a sidecar drop.
        options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
        queue.push(globalEvent(projectDir, serverConnected()));
        for (const event of turn) {
          queue.push(globalEvent(projectDir, event));
        }
        return { stream: queue };
      }),
    },
    app: { agents: vi.fn(async () => ({ data: [] })) },
    session: {
      create: vi.fn(async () => ({ data: info })),
      get: vi.fn(async () => ({ data: info })),
      list: vi.fn(async () => ({ data: [] })),
      // The turn as read back from the sidecar's durable store — OpenCode has
      // real native history, so the suite runs with `expectHistory: true`.
      // A caller that scripted a FAILED turn passes what that failure was
      // stored as instead: the sidecar records the outcome it actually had,
      // and a store still answering with a tidy success would make any
      // assertion about a reopened failed turn meaningless.
      messages: vi.fn(async () => ({
        data: stored ?? [
          {
            info: userMessage(OC_SESSION_A, 'msg_0000'),
            parts: [
              textPart(OC_SESSION_A, 'prt_u1', CONFORMANCE_PROMPT, { messageID: 'msg_0000' }),
            ],
          },
          {
            info: assistantMessage(OC_SESSION_A, { completed: true }),
            parts: [textPart(OC_SESSION_A, 'prt_text01', 'pong from opencode', { end: true })],
          },
        ],
      })),
      update: vi.fn(async () => ({ data: info })),
      fork: vi.fn(async () => ({ data: info })),
      promptAsync: vi.fn(async () => ({})),
      // The command-intent (compact) trigger: OpenCodeRuntime.executeCommandIntent
      // calls session.summarize, then drains the SAME per-turn demux tap as a
      // prompt — so the pre-queued turn's terminal (session.idle → done)
      // satisfies the conformance dispatch gate.
      summarize: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({ data: true })),
      todo: vi.fn(async () => ({ data: [] })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
  };
}

/**
 * A turn that compacts before going idle. OpenCode reports compaction as a
 * single post-hoc `session.compacted` — the mapper emits an `operation_progress`
 * `done` (honest degradation: no start signal) plus the `compact_boundary` row.
 *
 * @param sessionID - The OpenCode session the events belong to.
 */
export function opencodeCompactingTurn(sessionID: string): OpenCodeWireEvent[] {
  return [
    statusEvent(sessionID, { type: 'busy' }),
    sessionCompacted(sessionID),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}
