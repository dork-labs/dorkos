import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, TerminalReason, UsageStatus, UsageState } from '@dorkos/shared/types';
import type { AgentSession } from '../../agent-types.js';
import { mapErrorCategory } from '../sdk-error-mapping.js';
import { sumContextTokens } from '../context-tokens.js';

/**
 * Map a Claude rate-limit type to a human-readable window label. Authored
 * server-side so the runtime-neutral `UsageStatus.windowLabel` is written once
 * and every client renders the same string.
 */
function formatLimitType(type?: string): string | undefined {
  if (!type) return undefined;
  switch (type) {
    case 'five_hour':
      return '5-hour window';
    case 'seven_day':
      return '7-day window';
    case 'seven_day_opus':
      return '7-day Opus';
    case 'seven_day_sonnet':
      return '7-day Sonnet';
    case 'overage':
      return 'Overage';
    default:
      return type;
  }
}

/** Map a Claude rate-limit status to the runtime-neutral utilization health. */
function toUsageState(status: 'allowed' | 'allowed_warning' | 'rejected'): UsageState {
  switch (status) {
    case 'rejected':
      return 'exhausted';
    case 'allowed_warning':
      return 'warning';
    default:
      return 'ok';
  }
}

/**
 * Map terminal and session-meta SDK messages (`result`, `rate_limit_event`,
 * `prompt_suggestion`) to zero or more StreamEvents.
 *
 * `result` emits the final session_status (cost/tokens/cache/terminalReason), a
 * context_usage breakdown, an optional error event, and the terminal `done`.
 * `rate_limit_event` emits a usage-only `session_status` carrying
 * runtime-neutral subscription `usage` (utilization/window/reset), when the
 * SDK attaches `rate_limit_info`.
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

    // Project subscription utilization onto a usage-only `session_status`. The
    // projector merges partial status payloads, so a status carrying only
    // `usage` is valid and reaches the client on the durable path (where the
    // former standalone `usage_info` StreamEvent was dropped). Hold the mapped
    // value on the session so a later cost-only `result` can re-attach it.
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    if (info) {
      const resetsAtRaw = info.resetsAt as number | undefined;
      const status = (info.status as 'allowed' | 'allowed_warning' | 'rejected') ?? 'allowed';
      const usage: UsageStatus = {
        kind: 'subscription',
        ...(info.utilization !== undefined ? { utilization: info.utilization as number } : {}),
        ...(formatLimitType(info.rateLimitType as string | undefined) !== undefined
          ? { windowLabel: formatLimitType(info.rateLimitType as string | undefined) }
          : {}),
        ...(resetsAtRaw ? { resetsAt: new Date(resetsAtRaw * 1000).toISOString() } : {}),
        state: toUsageState(status),
        ...(info.isUsingOverage ? { detail: 'Using overage capacity' } : {}),
      };
      session.lastSubscriptionUsage = usage;
      yield {
        type: 'session_status',
        data: { sessionId, usage },
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
    const costUsd = result.total_cost_usd as number | undefined;

    // Turn TOTALS for AI observability (gen_ai.* spans + the opt-in
    // $ai_generation bridge; ADR 260713-143958 Phase 7). Unlike the context/cache
    // figures above — which describe the current window and deliberately avoid the
    // aggregate — a per-turn generation event WANTS the sum across every request in
    // the turn, which is exactly what `modelUsage` carries. Summed across models so
    // a turn that switched models still reports one honest total. Undefined when
    // the SDK reported no `modelUsage` — absent OR empty (older SDKs / error
    // results) — so "no data" never masquerades as a zero-token turn.
    let turnInputTokens: number | undefined;
    let turnOutputTokens: number | undefined;
    if (modelUsageMap && Object.keys(modelUsageMap).length > 0) {
      let inSum = 0;
      let outSum = 0;
      for (const usage of Object.values(modelUsageMap)) {
        inSum += (usage.inputTokens as number | undefined) ?? 0;
        outSum += (usage.outputTokens as number | undefined) ?? 0;
      }
      turnInputTokens = inSum;
      turnOutputTokens = outSum;
    }

    // Stamp `usage` onto the result status so the merged Usage & cost item has
    // the session cost (secondary for a subscription, primary if no rate-limit
    // signal has arrived). Re-attach the last observed subscription utilization
    // (`kind: 'subscription'` with window/reset/state) so the item does not
    // flicker to a cost-only render between turns. With no prior rate-limit
    // signal (e.g. an API-key session), the session reports `pay-as-you-go`.
    let usage: UsageStatus | undefined;
    if (costUsd !== undefined) {
      usage = session.lastSubscriptionUsage
        ? { ...session.lastSubscriptionUsage, costUsd }
        : { kind: 'pay-as-you-go', costUsd };
    } else {
      usage = session.lastSubscriptionUsage;
    }

    // Always emit session_status with final cost/token/model data + cache metrics
    yield {
      type: 'session_status',
      data: {
        sessionId,
        model: result.model as string | undefined,
        costUsd,
        contextTokens,
        contextMaxTokens,
        cacheReadTokens,
        cacheCreationTokens,
        ...(turnInputTokens !== undefined ? { turnInputTokens } : {}),
        ...(turnOutputTokens !== undefined ? { turnOutputTokens } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        ...(usage ? { usage } : {}),
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
