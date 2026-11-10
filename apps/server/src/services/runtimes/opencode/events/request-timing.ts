import type { StreamEvent, ModelRequestEvent } from '@dorkos/shared/types';
import { timeRuntimeEvents } from '../../shared/timing/runtime-timing.js';
import type { OpenCodeEventContext, OpenCodeWireEvent } from './event-mapper.js';
const requests = new WeakMap<object, Map<string, ModelRequestEvent>>();

/** Preserve native clock readings and message identity; do not time synthetic starts as real starts. */
export function openCodeTimingEvents(
  event: OpenCodeWireEvent,
  ctx: OpenCodeEventContext,
  mapped: StreamEvent[]
): StreamEvent[] {
  const now = ctx.clock();
  const output = timeRuntimeEvents(ctx, mapped, { observeStart: false, now });
  if (event.type === 'message.part.updated' && event.properties.part.type === 'tool') {
    const state = event.properties.part.state;
    if (state.status !== 'pending') {
      for (const result of output) {
        if (!['tool_call_start', 'tool_call_end', 'tool_result'].includes(result.type)) continue;
        Object.assign(
          result.data,
          { startedAt: state.time.start },
          state.status === 'running' ? {} : { endedAt: state.time.end }
        );
      }
    }
  }
  let byId = requests.get(ctx);
  if (!byId) {
    byId = new Map();
    requests.set(ctx, byId);
  }
  if (event.type === 'message.updated') {
    const info = event.properties.info;
    if (info.role !== 'assistant' || ctx.subagentTaskIdBySession.has(info.sessionID)) return output;
    const prior = byId.get(info.id);
    if (prior?.endedAt !== undefined) return output;
    const request: ModelRequestEvent = {
      ...prior,
      requestId: info.id,
      phase: info.time.completed === undefined ? 'start' : 'end',
      model: info.modelID,
      startedAt: info.time.created,
      ...(info.time.completed === undefined
        ? {}
        : {
            endedAt: info.time.completed,
            inputTokens: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write,
            outputTokens: info.tokens.output,
          }),
    };
    byId.set(info.id, request);
    if (!prior || request.endedAt !== undefined)
      output.unshift({ type: 'model_request', data: { ...request } });
  }
  if (event.type === 'message.part.delta') {
    const request = byId.get(event.properties.messageID);
    if (
      request &&
      request.firstTokenAt === undefined &&
      event.properties.delta &&
      mapped.some((e) => e.type === 'text_delta' || e.type === 'thinking_delta') &&
      request.endedAt === undefined
    ) {
      request.firstTokenAt = now;
      output.unshift({ type: 'model_request', data: { ...request, phase: 'first_token' } });
    }
  }
  return output;
}
