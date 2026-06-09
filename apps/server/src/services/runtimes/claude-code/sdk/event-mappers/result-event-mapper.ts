import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, TerminalReason } from '@dorkos/shared/types';
import type { AgentSession } from '../../agent-types.js';
import { mapErrorCategory } from '../sdk-error-mapping.js';
import { sumContextTokens } from '../context-tokens.js';

/**
 * Map terminal and session-meta SDK messages (`result`, `rate_limit_event`,
 * `prompt_suggestion`) to zero or more StreamEvents.
 *
 * `result` emits the final session_status (cost/tokens/cache/terminalReason), a
 * context_usage breakdown, an optional error event, and the terminal `done`.
 * `rate_limit_event` emits rate_limit plus subscription usage_info.
 * `prompt_suggestion` forwards a single suggestion.
 *
 * @param message - The SDK message to map (result/rate_limit_event/prompt_suggestion).
 * @param session - In-memory session state; its `lastRequestUsage` (the most recent
 *   main-thread request's usage) is the source of truth for context/cache figures.
 * @param sessionId - DorkOS session identifier (stamped onto result session_status/done).
 */
export async function* mapResultEvent(
  message: SDKMessage,
  session: AgentSession,
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
    const modelUsageMap = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
    const firstModelUsage = modelUsageMap ? Object.values(modelUsageMap)[0] : undefined;
    const terminalReason = result.terminal_reason as TerminalReason | undefined;

    // Context/cache figures describe the CURRENT window, which is the size of the
    // most recent request — NOT `result.usage`/`result.modelUsage`, which SUM
    // every API round-trip in the turn. On a multi-tool-call turn that aggregate
    // balloons far past the real window (e.g. 3 requests over a ~250k context
    // report ~750k). Use the last main-thread request's usage captured during
    // streaming; all three fields come from one source so they stay coherent (the
    // cache hit-rate and "uncached" breakdown derive from them). `contextWindow`
    // is a per-model constant, so it's safe to read from the aggregate.
    const last = session.lastRequestUsage;
    const contextTokens = last ? sumContextTokens(last) : undefined;
    const cacheReadTokens = last?.cacheReadTokens;
    const cacheCreationTokens = last?.cacheCreationTokens;
    const contextMaxTokens = firstModelUsage?.contextWindow as number | undefined;

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

    // Emit the context-usage breakdown before `done` (so it survives the
    // session-ID remap). Prefer the SDK's authoritative getContextUsage() result
    // (rich per-category breakdown), which message-sender fetches at turn end
    // while the subprocess is held alive. If that fetch failed or timed out, fall
    // back to a self-computed total from the last request (no categories).
    if (session.contextBreakdown) {
      yield { type: 'context_usage', data: session.contextBreakdown };
    } else if (contextTokens !== undefined && contextMaxTokens && contextMaxTokens > 0) {
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
