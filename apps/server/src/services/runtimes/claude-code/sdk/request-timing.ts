import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelRequestEvent, StreamEvent } from '@dorkos/shared/types';

const requests = new WeakMap<object, ModelRequestEvent>();

/** Observe each main-thread API response; the SDK exposes no outbound dispatch timestamp. */
export function claudeRequestEvents(message: SDKMessage, owner: object): StreamEvent[] {
  if (message.type !== 'stream_event' || message.parent_tool_use_id) return [];
  const event = message.event as unknown as Record<string, unknown>;
  if (event.type === 'message_start') {
    const response = event.message as {
      id: string;
      model?: string;
      usage?: Record<string, number>;
    };
    const usage = response.usage;
    const request: ModelRequestEvent = {
      requestId: response.id,
      phase: 'start',
      ...(response.model ? { model: response.model } : {}),
      ...(usage?.input_tokens === undefined
        ? {}
        : {
            inputTokens:
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0),
          }),
    };
    requests.set(owner, request);
    return [{ type: 'model_request', data: { ...request } }];
  }
  const request = requests.get(owner);
  if (!request) return [];
  if (event.type === 'content_block_delta' && request.firstTokenAt === undefined) {
    const delta = event.delta as {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
    if (!(delta.text || delta.thinking || delta.partial_json)) return [];
    request.firstTokenAt = Date.now();
    return [{ type: 'model_request', data: { ...request, phase: 'first_token' } }];
  }
  if (event.type === 'message_delta') {
    const usage = event.usage as { output_tokens?: number } | undefined;
    if (usage?.output_tokens !== undefined) request.outputTokens = usage.output_tokens;
  }
  if (event.type !== 'message_stop') return [];
  requests.delete(owner);
  return [{ type: 'model_request', data: { ...request, phase: 'end', endedAt: Date.now() } }];
}
