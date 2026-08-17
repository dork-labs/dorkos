/**
 * One turn window, as the `StreamEvent`s the durable session stream expects
 * (spec `persistent-session-runtime` §5, task 3.10).
 *
 * ## What this is, next to `executeSdkQuery`'s loop
 *
 * On the resume-per-message path the SDK stream IS the turn, so one loop owns
 * both mapping and process lifecycle: it closes stdin at the `result`, holds
 * that close open while the turn is still alive (`turn-liveness.ts`), fetches
 * the closing accounting, and retries a failed resume by recursing. None of that
 * belongs to a turn on a persistent process, and every one of them has a new
 * owner:
 *
 * | Concern                        | Who owns it on the pump path                      |
 * | ------------------------------ | ------------------------------------------------- |
 * | when the turn ends             | `SessionTurnWindows` — the correlated `result`     |
 * | closing the input stream       | `SessionPump` — at reap, teardown, or crash        |
 * | the closing accounting fetch   | `SessionTurnWindows.onUsage`, before the `result`  |
 * | a launch that fails            | `SessionCrashRecovery` — resume, or refuse         |
 *
 * So what is left here is the mapping itself, and it is deliberately the SAME
 * mapping: `mapSdkMessage`, the same canonical-id rebind ordering, the same
 * content-event accounting and empty-stream guard (both imported from
 * `messaging/empty-stream-guard.ts`, so they cannot drift), the same terminal
 * `done`. A person must not be able to tell which path answered them.
 *
 * ## The event queue is raced, not polled
 *
 * `interactive-handlers.ts` pushes approval cards and question prompts onto
 * `session.eventQueue` from OUTSIDE the SDK stream and wakes the turn through
 * `session.eventQueueNotify`. A loop that only awaited the window would hold
 * every approval until the next SDK message arrived — and an approval is
 * precisely what the process is waiting on, so the next message would never
 * come. The race is the same one `executeSdkQuery` runs, for the same reason.
 *
 * ## Phantom cancellations are counted and reported, never steered
 *
 * The detector runs on this path exactly as it does on the turn path (DOR-1087),
 * and every hit is counted through `observability/phantom-cancellations.ts`
 * (DOR-1288) so the rate is a number anybody can read rather than one somebody
 * remembers. The operator gets a status line either way.
 *
 * The corrective note the turn path steers back into the model is deliberately
 * NOT sent here, and that is now a decision rather than a gap: P4 shipped
 * `SessionPump.steer`, so a note COULD be written into the live turn. Two
 * reasons it is not.
 *
 * - A steer is itself a mid-turn write into the CLI's queue — the very
 *   mechanism suspected of provoking phantoms. Answering a phantom by doing
 *   more of the suspected cause is how a correction feeds itself, which is what
 *   `PHANTOM_CORRECTIONS_MAX_PER_TURN` exists to bound on the other path.
 * - The persistent path is not believed to produce phantoms at all: it never
 *   closes stdin at a `result`, and `SessionPump.reap()` declines while a
 *   background subagent is live (DOR-1238), so an EOF cannot land under one.
 *   Spec task 5.1 measures whether that holds. A correction here would soften
 *   the symptom of the thing being measured; the counter is the point.
 *
 * If 5.1 reports a non-zero `pump` count, the remedy is the trigger, not a
 * note — and the count is what would say so.
 *
 * @module services/runtimes/claude-code/sessions/pump-turn-stream
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import { recordPhantomCancellation } from '../../../observability/phantom-cancellations.js';
import { createToolState, type AgentSession } from '../agent-types.js';
import {
  emptyStreamError,
  isContentEvent,
  isInteractiveEvent,
  isReportedFailure,
} from '../messaging/empty-stream-guard.js';
import type { MessageSenderOpts } from '../messaging/message-sender-shared.js';
import { detectPhantomCancellations } from '../messaging/phantom-cancellation.js';
import { mapSdkMessage } from '../sdk/sdk-event-mapper.js';
import type { TurnWindow } from './session-turn-windows.js';

/** What one window needs to become a turn on the durable stream. */
export interface PumpTurnStreamArgs {
  sessionId: string;
  /** The session being mutated as the mapper adopts ids and usage. */
  session: AgentSession;
  /** The window whose messages are this turn. Iterated exactly once. */
  window: TurnWindow;
  /** The runtime's ports — the rebind announcement and the command cache. */
  opts: MessageSenderOpts;
  /** The mesh agent to stamp `response_complete` on, if this directory hosts one. */
  meshAgentId: string | undefined;
}

/**
 * Map one turn window into the turn's `StreamEvent`s.
 *
 * Ends when the window's stream ends, which the windower does at the correlated
 * `result` — so this generator has exactly the lifetime of one turn even though
 * the process behind it outlives many. That is what lets `withStallGuard` keep
 * measuring the silence of a TURN without being told about windows at all.
 *
 * @param args - The session, the window, and the runtime's ports
 */
export async function* streamTurnWindow(args: PumpTurnStreamArgs): AsyncGenerator<StreamEvent> {
  const { sessionId, session, window, opts, meshAgentId } = args;
  const streamStart = Date.now();
  const toolState = createToolState();
  const messages = window.messages[Symbol.asyncIterator]();
  let emittedDone = false;
  let emittedError = false;
  let eventCount = 0;
  let contentEventCount = 0;
  let wasInteractive = false;
  // Anchor for the NEXT turn's resume: the last main-thread assistant uuid seen
  // this turn. Subagent assistant messages carry a `parent_tool_use_id` and live
  // in a separate transcript, so they must never become the main-session anchor.
  let lastMainAssistantUuid: string | undefined;

  try {
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    for (;;) {
      while (session.eventQueue.length > 0) {
        const queued = session.eventQueue.shift()!;
        if (queued.type === 'done') emittedDone = true;
        if (isInteractiveEvent(queued)) wasInteractive = true;
        eventCount++;
        yield queued;
      }

      const queueWoke = new Promise<'queue'>((resolve) => {
        session.eventQueueNotify = () => resolve('queue');
      });
      pending ??= messages.next();
      const winner = await Promise.race([queueWoke, pending]);
      if (winner === 'queue') continue;

      pending = null;
      if (winner.done) break;
      const message = winner.value;

      if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        lastMainAssistantUuid = message.uuid;
      }

      // DOR-1087: the CLI cancelled pending tool calls, writing a sentinel that
      // reads as a user refusal. Counted and logged (DOR-1288), and the operator
      // is told; the model is NOT corrected here — see the module doc.
      const phantoms = detectPhantomCancellations(message, session);
      let phantomNotice: string | undefined;
      if (phantoms.length > 0) {
        const mainThread = phantoms.some((p) => p.mainThread);
        recordPhantomCancellation({ sessionId, path: 'pump', phantoms, steered: false });
        const plural =
          phantoms.length > 1 ? `${phantoms.length} pending tool calls` : 'a pending tool call';
        const where = mainThread ? '' : ' inside one of its helpers';
        phantomNotice = `A background task finished at the wrong moment and cancelled ${plural}${where}. That was a system glitch, not you.`;
      }

      // A mid-session `commands_changed` push carries the full, authoritative
      // command list. Replace the runtime cache here (this loop holds the
      // callback; the pure system-event mapper does not) so `/api/commands`
      // reflects the change without a restart (DOR-108).
      if (
        message.type === 'system' &&
        'subtype' in message &&
        (message as { subtype?: string }).subtype === 'commands_changed' &&
        opts.onCommandsChanged
      ) {
        const changed = message as unknown as {
          commands?: Array<{
            name: string;
            description: string;
            argumentHint: string;
            aliases?: string[];
          }>;
        };
        opts.onCommandsChanged(
          (changed.commands ?? []).map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
            aliases: c.aliases,
          }))
        );
      }

      let prevSdkId = session.sdkSessionId;
      for await (const event of mapSdkMessage(message, session, sessionId, toolState)) {
        // BEFORE this event leaves the server: `trigger-turn` re-keys the
        // projector on every event it sees, and that announcement is how the
        // cockpit learns the id it POSTs its next message under. Handing the id
        // out before the row has moved is what made a session's own next message
        // look brand new (DOR-493, DOR-838).
        if (session.sdkSessionId !== prevSdkId) {
          const retired = prevSdkId;
          prevSdkId = session.sdkSessionId;
          await opts.onSdkSessionRebind(retired, session.sdkSessionId);
        }
        if (event.type === 'done') {
          emittedDone = true;
          if (opts.meshCore && meshAgentId) {
            opts.meshCore.updateLastSeen(meshAgentId, 'response_complete');
          }
          // Zero-content turn about to close: surface the no-response error
          // BEFORE the terminal done — nothing may follow done, or the durable
          // snapshot settles idle with a stale lastError.
          if (contentEventCount === 0 && !emittedError && !wasInteractive) {
            logger.warn('[pump-turn-stream] window closed with zero content events', {
              session: sessionId,
              eventCount,
              durationMs: Date.now() - streamStart,
            });
            emittedError = true;
            yield emptyStreamError();
          }
        }
        // A failure the turn has already reported — a typed error, or a named
        // operation that resolved `failed` — so the guard does not add its
        // vaguer line on top of it.
        if (isReportedFailure(event)) emittedError = true;
        if (isContentEvent(event)) contentEventCount++;
        if (isInteractiveEvent(event)) wasInteractive = true;
        eventCount++;
        yield event;
      }
      // Trails this message's own mapped events, so the status-strip
      // re-derivation those events trigger cannot wipe it in the same frame.
      if (phantomNotice !== undefined) {
        eventCount++;
        yield { type: 'system_status', data: { message: phantomNotice } };
      }
      if (session.sdkSessionId !== prevSdkId) {
        await opts.onSdkSessionRebind(prevSdkId, session.sdkSessionId);
      }
    }
  } finally {
    // This turn's resume anchor for the next one, or undefined when the turn
    // produced none (empty/error) so the next resume stays plain and keeps this
    // turn's user message in context.
    session.lastAssistantUuid = lastMainAssistantUuid;
    // Never leave a resolver behind that a later turn's push would call.
    session.eventQueueNotify = undefined;
  }

  if (contentEventCount === 0 && !emittedError && !emittedDone && !wasInteractive) {
    logger.warn('[pump-turn-stream] window closed with zero content events', {
      session: sessionId,
      eventCount,
      durationMs: Date.now() - streamStart,
    });
    yield emptyStreamError();
  }

  logger.info('[pump-turn-stream] window done', {
    session: sessionId,
    durationMs: Date.now() - streamStart,
    eventCount,
    contentEventCount,
  });

  if (!emittedDone) {
    yield { type: 'done', data: { sessionId } };
  }
}
