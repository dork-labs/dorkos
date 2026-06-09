import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, TerminalReason } from '@dorkos/shared/types';
import { mapErrorCategory } from '../sdk-error-mapping.js';
import { sumContextTokens } from '../context-tokens.js';

/**
 * Map terminal and session-meta SDK messages (`result`, `rate_limit_event`,
 * `prompt_suggestion`) to zero or more StreamEvents.
 *
 * `result` emits the final session_status (cost/tokens/cache/terminalReason), an
 * optional error event, and the terminal `done`. `rate_limit_event` emits rate_limit
 * plus subscription usage_info. `prompt_suggestion` forwards a single suggestion.
 *
 * @param message - The SDK message to map (result/rate_limit_event/prompt_suggestion).
 * @param sessionId - DorkOS session identifier (stamped onto result session_status/done).
 */
export async function* mapResultEvent(
  message: SDKMessage,
  sessionId: string
): AsyncGenerator<StreamEvent> {
  // Handle prompt suggestion messages (SDK 0.2.86: singular `suggestion` field)
  if (message.type === 'prompt_suggestion') {
    const suggestion = (message as Record<string, unknown>).suggestion as string;
    if (suggestion) {
      yield {
        type: 'prompt_suggestion',
        data: { suggestions: [suggestion] },
      };
    }
    return;
  }

  // Handle rate limit events (includes subscription utilization data)
  if (message.type === 'rate_limit_event') {
    const msg = message as Record<string, unknown>;
    const retryAfter = msg.retry_after as number | undefined;
    yield {
      type: 'rate_limit',
      data: { retryAfter },
    };

    // Extract subscription utilization from rate_limit_info if present
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (info) {
      const resetsAtRaw = info.resetsAt as number | undefined;
      const status = (info.status as 'allowed' | 'allowed_warning' | 'rejected') ?? 'allowed';
      yield {
        type: 'usage_info' as const,
        data: {
          status,
          utilization: info.utilization as number | undefined,
          resetsAt: resetsAtRaw ? new Date(resetsAtRaw * 1000).toISOString() : undefined,
          rateLimitType: info.rateLimitType as string | undefined,
          isUsingOverage: info.isUsingOverage as boolean | undefined,
        },
      };
    }
    return;
  }

  // Handle result messages
  if (message.type === 'result') {
    const result = message as Record<string, unknown>;
    const usage = result.usage as Record<string, unknown> | undefined;
    const modelUsageMap = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;
    const terminalReason = result.terminal_reason as TerminalReason | undefined;

    const cacheReadTokens = firstModelUsage?.cacheReadInputTokens as number | undefined;
    const cacheCreationTokens = firstModelUsage?.cacheCreationInputTokens as number | undefined;
    const contextMaxTokens = firstModelUsage?.contextWindow as number | undefined;

    // Context window usage is the full input side of the turn: fresh input tokens
    // plus cached reads plus cache writes. The cache terms hold the bulk of a
    // resumed conversation, so counting `input_tokens` alone drastically
    // understates usage (it reports ~1% when the window is several percent full).
    // Mirror the summation in transcript-reader.ts so the live value agrees with
    // the value recomputed from the transcript after a reload.
    const contextTokens =
      usage !== undefined
        ? sumContextTokens({
            inputTokens: usage.input_tokens as number | undefined,
            cacheReadTokens,
            cacheCreationTokens,
          })
        : undefined;

    // Always emit session_status with final cost/token/model data + cache metrics
    yield {
      type: 'session_status',
      data: {
        sessionId,
        model: result.model as string | undefined,
        costUsd: result.total_cost_usd as number | undefined,
        contextTokens,
        contextMaxTokens,
        cacheReadTokens,
        cacheCreationTokens,
        ...(terminalReason ? { terminalReason } : {}),
      },
    };

    // Emit an accurate context-usage payload derived from the same result figures.
    // The SDK's getContextUsage() control call cannot be used for this: the prompt
    // is a single-yield stream, so the Claude subprocess exits as soon as the
    // result message arrives and its control channel is already gone. Categories
    // are intentionally omitted — the status bar shows the total plus a "used / max"
    // tooltip; the per-category breakdown is out of scope.
    if (contextTokens !== undefined && contextMaxTokens && contextMaxTokens > 0) {
      yield {
        type: 'context_usage',
        data: {
          totalTokens: contextTokens,
          maxTokens: contextMaxTokens,
          percentage: (contextTokens / contextMaxTokens) * 100,
          model: (result.model as string | undefined) ?? '',
          categories: [],
        },
      };
    }

    // Emit error event if the result is an error subtype
    const subtype = result.subtype as string | undefined;
    if (subtype && subtype !== 'success') {
      const errors = result.errors as string[] | undefined;
      const category = mapErrorCategory(subtype);
      yield {
        type: 'error',
        data: {
          message: errors?.[0] ?? 'An unexpected error occurred.',
          code: subtype,
          category,
          details: errors?.join('\n'),
        },
      };
    }

    // Always emit done to trigger client cleanup
    yield {
      type: 'done',
      data: { sessionId },
    };
    return;
  }
}
