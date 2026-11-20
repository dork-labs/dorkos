import { timeRuntimeEvents } from '../../shared/timing/runtime-timing.js';
import { claudeRequestEvents } from './request-timing.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from '../agent-types.js';
import { mapSystemEvent } from './event-mappers/system-event-mapper.js';
import { mapStreamEvent } from './event-mappers/stream-event-mapper.js';
import { mapMessageEvent } from './event-mappers/message-event-mapper.js';
import { mapResultEvent } from './event-mappers/result-event-mapper.js';
import { logger } from '../../../../lib/logger.js';

/**
 * Map a single SDK message to zero or more DorkOS StreamEvent objects.
 *
 * Thin dispatcher: routes by `message.type` to the focused per-category mappers in
 * `event-mappers/` (`system-event-mapper`, `stream-event-mapper`,
 * `message-event-mapper`, `result-event-mapper`). Pure async generator — no I/O, no
 * SDK iterator interaction, no session Map access. ToolState is passed by reference
 * (mutable struct owned by the caller's streaming loop).
 *
 * @param message - The SDK message to map.
 * @param session - In-memory session state (mutated by system init/memory-recall events).
 * @param sessionId - DorkOS session identifier.
 * @param toolState - Mutable tool tracking state passed by reference.
 * @param wasStopped - Whether DorkOS aimed a Stop at the query running this
 *   turn. Forwarded to the result mapper, which needs it to tell a turn a
 *   person stopped from one that failed (DOR-1320); every other mapper ignores
 *   it. Omitted means "nobody stopped anything".
 */
export async function* mapSdkMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState,
  wasStopped?: () => boolean
): AsyncGenerator<StreamEvent> {
  // Retain raw structured errors even when an unknown SDK code has no UI mapper.
  // A hidden/unknown cause must not be erased by a later server-error wrapper.
  if (message.type === 'assistant') {
    const raw = message as unknown as Record<string, unknown>;
    if (raw.error !== undefined) {
      const evidence = (session.serverErrorEvidence ??= { notices: [], vetoed: false });
      if (raw.error !== 'server_error') evidence.vetoed = true;
      else {
        const body = raw.message as { content?: unknown } | undefined;
        const blocks = body?.content;
        const first = Array.isArray(blocks) ? blocks[0] : undefined;
        if (first?.type === 'text' && typeof first.text === 'string' && first.text.trim()) {
          evidence.notices.push(first.text.trim());
        }
      }
    }
  }
  yield* claudeRequestEvents(message, toolState);
  for await (const event of mapMessage(message, session, sessionId, toolState, wasStopped)) {
    if (event.type === 'error' && message.type !== 'result') {
      const error = event.data as { code?: string; category?: string };
      if (error.code !== 'server_error' || error.category !== 'execution_error') {
        (session.serverErrorEvidence ??= { notices: [], vetoed: false }).vetoed = true;
      }
    }
    yield* timeRuntimeEvents(toolState, [event], { observeStart: message.type === 'stream_event' });
  }
}

async function* mapMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState,
  wasStopped?: () => boolean
): AsyncGenerator<StreamEvent> {
  switch (message.type) {
    case 'system':
      yield* mapSystemEvent(message, session, sessionId, toolState);
      return;
    case 'stream_event':
      yield* mapStreamEvent(message, sessionId, toolState);
      return;
    case 'assistant':
    case 'user':
    case 'tool_use_summary':
    case 'tool_progress':
      yield* mapMessageEvent(message, session, toolState, sessionId);
      return;
    case 'result':
    case 'rate_limit_event':
    case 'prompt_suggestion':
      yield* mapResultEvent(message, session, sessionId, wasStopped);
      return;
    default:
      // Catch-all: log unhandled message types for debugging.
      logger.debug(
        'Unhandled SDK message type: %s (subtype: %s)',
        (message as { type?: string }).type,
        'subtype' in message ? (message as Record<string, unknown>).subtype : 'none'
      );
  }
}
