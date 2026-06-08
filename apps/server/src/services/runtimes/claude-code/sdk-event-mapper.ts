import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentSession, ToolState } from './agent-types.js';
import { mapSystemEvent } from './sdk-event-mappers/system-event-mapper.js';
import { mapStreamEvent } from './sdk-event-mappers/stream-event-mapper.js';
import { mapMessageEvent } from './sdk-event-mappers/message-event-mapper.js';
import { mapResultEvent } from './sdk-event-mappers/result-event-mapper.js';
import { logger } from '../../../lib/logger.js';

/**
 * Map a single SDK message to zero or more DorkOS StreamEvent objects.
 *
 * Thin dispatcher: routes by `message.type` to the focused per-category mappers in
 * `sdk-event-mappers/` (`system-event-mapper`, `stream-event-mapper`,
 * `message-event-mapper`, `result-event-mapper`). Pure async generator — no I/O, no
 * SDK iterator interaction, no session Map access. ToolState is passed by reference
 * (mutable struct owned by the caller's streaming loop).
 *
 * @param message - The SDK message to map.
 * @param session - In-memory session state (mutated by system init/memory-recall events).
 * @param sessionId - DorkOS session identifier.
 * @param toolState - Mutable tool tracking state passed by reference.
 */
export async function* mapSdkMessage(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState
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
      yield* mapMessageEvent(message, toolState);
      return;
    case 'result':
    case 'rate_limit_event':
    case 'prompt_suggestion':
      yield* mapResultEvent(message, sessionId);
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
