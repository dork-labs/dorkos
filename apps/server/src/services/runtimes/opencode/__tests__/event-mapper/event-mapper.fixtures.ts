/**
 * Shared setup for the event-mapper tests, split from one file by subject.
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  createOpenCodeEventContext,
  mapOpenCodeEvent,
  mapOpenCodeTurn,
  type OpenCodeEventContext,
  type OpenCodeWireEvent,
} from '../../events/event-mapper.js';
import {
  OC_SESSION_A,
  assistantMessage,
  messageUpdated,
  toEventStream,
} from '../opencode-sse-fixtures.js';

/** DorkOS session id — deliberately NOT the OpenCode `ses_*` id (different namespaces). */
export const SESSION_ID = 'a0000000-0000-4000-8000-000000000001';

export const OC = OC_SESSION_A;

/**
 * A fresh turn context that has already seen the assistant `message.updated`
 * the sidecar opens every message with.
 *
 * Load-bearing, not ceremony: parts name only a `messageID`, so the mapper
 * learns who wrote a message from that announcement and drops parts it cannot
 * attribute to the assistant (`isAssistantMessage`). The wire always announces
 * first — a context that has not seen it is not a state OpenCode can produce —
 * and every part these fixtures build belongs to `msg_0001`, the id
 * {@link assistantMessage} defaults to.
 */
export function makeContext(): OpenCodeEventContext {
  const ctx = createOpenCodeEventContext(SESSION_ID);
  mapOpenCodeEvent(messageUpdated(assistantMessage(OC)), ctx);
  return ctx;
}

/** Shared helper for the event-mapper tests: `drain`. */
export async function drain(
  events: OpenCodeWireEvent[] | AsyncGenerator<OpenCodeWireEvent>,
  ctx = makeContext()
): Promise<StreamEvent[]> {
  const stream = Array.isArray(events) ? toEventStream(events) : events;
  const out: StreamEvent[] = [];
  for await (const event of mapOpenCodeTurn(stream, ctx)) out.push(event);
  return out;
}
