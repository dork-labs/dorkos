import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent, TerminalReason, UsageStatus, UsageState } from '@dorkos/shared/types';
import type { AgentSession } from '../../agent-types.js';
import { describeAuthError, detectAuthError } from '@dorkos/shared/runtime-error-classification';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import {
  CLAUDE_CODE_RUNTIME_TYPE,
  isStoppedTurnResult,
  mapErrorCategory,
} from '../sdk-error-mapping.js';
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

/**
 * The honest basis for a cost SUMMED over several models (SDK 0.3.246).
 *
 * `ModelUsage.costBasis` is per-model, and `total_cost_usd` is one number over
 * all of them, so a turn that switched models can carry more than one basis
 * behind a single figure. The weakest claim wins, because a total is only as
 * trustworthy as its least-trustworthy part: any `unknown` makes the sum a
 * guess, any `managed` makes it a non-list price, and only an all-list set can
 * be shown plain.
 *
 * A model with no basis yet counts as `list` — the SDK's field doc says to read
 * absence that way, and that is also what every DorkOS cost figure meant before
 * the field existed. `undefined` comes back only when there are no models at
 * all, so "the SDK told us nothing" never masquerades as "we checked".
 *
 * @param modelUsage - The result's `modelUsage` map, keyed by model string.
 */
function resolveCostBasis(
  modelUsage: Record<string, Record<string, unknown>> | undefined
): 'list' | 'managed' | 'unknown' | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  let sawManaged = false;
  for (const usage of entries) {
    const basis = usage.costBasis as 'list' | 'managed' | 'unknown' | undefined;
    if (basis === 'unknown') return 'unknown';
    if (basis === 'managed') sawManaged = true;
  }
  return sawManaged ? 'managed' : 'list';
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
 * @param wasStopped - Whether DorkOS aimed a Stop at the query running this
 *   turn, supplied by the loop that owns it because only that loop knows WHICH
 *   query the turn is on. A predicate rather than a value, and called at the
 *   moment the `result` is mapped: a Stop can land at any point of a stream, and
 *   the question is whether one had landed by the time the turn ended. Absent
 *   means "nobody stopped anything", which is the honest default for every
 *   caller that does not track stops.
 */
export async function* mapResultEvent(
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  wasStopped?: () => boolean
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
    //
    // `thinkingTokens` (SDK 0.3.257) rides the same sum with one difference: it
    // is written ONLY when at least one model actually reported it. The field is
    // absent on turns the CLI did not record it for, and a `0` there would read
    // as "the model did not think" — a claim nobody made. Absent says "not
    // reported", which is the only thing that is true.
    let turnInputTokens: number | undefined;
    let turnOutputTokens: number | undefined;
    let turnThinkingTokens: number | undefined;
    if (modelUsageMap && Object.keys(modelUsageMap).length > 0) {
      let inSum = 0;
      let outSum = 0;
      let thinkingSum = 0;
      let sawThinking = false;
      for (const usage of Object.values(modelUsageMap)) {
        inSum += (usage.inputTokens as number | undefined) ?? 0;
        outSum += (usage.outputTokens as number | undefined) ?? 0;
        const thinking = usage.thinkingTokens as number | undefined;
        if (typeof thinking === 'number') {
          thinkingSum += thinking;
          sawThinking = true;
        }
      }
      turnInputTokens = inSum;
      turnOutputTokens = outSum;
      if (sawThinking) turnThinkingTokens = thinkingSum;
    }

    // Stamp `usage` onto the result status so the merged Usage & cost item has
    // the session cost (secondary for a subscription, primary if no rate-limit
    // signal has arrived). Re-attach the last observed subscription utilization
    // (`kind: 'subscription'` with window/reset/state) so the item does not
    // flicker to a cost-only render between turns. With no prior rate-limit
    // signal (e.g. an API-key session), the session reports `pay-as-you-go`.
    //
    // The cost travels with the price table it came from ({@link resolveCostBasis}),
    // so a client can say which figures are the published price and which are a
    // guess instead of rendering all of them with the same confidence. Attached
    // only beside a cost, because a basis with no figure under it describes
    // nothing.
    let usage: UsageStatus | undefined;
    if (costUsd !== undefined) {
      const costBasis = resolveCostBasis(modelUsageMap);
      const cost = { costUsd, ...(costBasis ? { costBasis } : {}) };
      usage = session.lastSubscriptionUsage
        ? { ...session.lastSubscriptionUsage, ...cost }
        : { kind: 'pay-as-you-go', ...cost };
    } else {
      usage = session.lastSubscriptionUsage;
    }

    // The stop record this turn's ending is read beside. Resolved ONCE and used
    // twice — here, and by `isStoppedTurnResult` below — so the intent the wire
    // carries and the intent that decides the error frame cannot disagree about
    // one result.
    //
    // **Reading it this early is safe because of WHERE the record is written.**
    // `interruptGivenQuery` adds the query to `stoppedQueries` BEFORE it attempts
    // the interrupt (`sessions/session-store.ts`), precisely so a Stop still in
    // flight is already on record. So any abort DorkOS caused already carries
    // its record by the time the `result` it produced reaches this mapper, and
    // moving the read ahead of the two yields below cannot lose it. The residual
    // window is the opposite case — something else aborts the turn in the
    // instant a Stop is landing — and there the early read reports `false`, so
    // the turn settles `error` with its failure text kept. That is the more
    // honest of the two answers for a turn nobody had yet stopped.
    //
    // Undefined when the caller supplied no `wasStopped` probe at all (the
    // media-capture path), which is the honest answer: that caller holds no
    // session and so has no record to report. Settlement reads an absent signal
    // as it always did, so nothing about those paths changes.
    const stopWasRequested = wasStopped === undefined ? undefined : wasStopped();

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
        ...(turnThinkingTokens !== undefined ? { turnThinkingTokens } : {}),
        ...(terminalReason ? { terminalReason } : {}),
        // Attached only beside an ABORT reason, which is the only ending whose
        // settlement it changes. Every other terminal would carry a fact no
        // reader consults into the durable log of every turn this session ever
        // runs. Absent therefore means either "no record" or "no decision to
        // make", and settlement treats both the same way.
        ...(terminalReason !== undefined &&
        stopWasRequested !== undefined &&
        isInterruptedTerminalReason(terminalReason)
          ? { stopWasRequested }
          : {}),
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

    // Emit an error event if the result is an error subtype — UNLESS this turn
    // is one a person STOPPED. A Stop the CLI acks comes back as
    // `error_during_execution` with `terminal_reason: 'aborted_streaming'`, and
    // calling that an error put a red frame in the durable record of a turn the
    // operator ended on purpose (DOR-1320). The `session_status` above already
    // carried the reason, which the projector settles as `interrupted`, so the
    // turn still ends honestly.
    //
    // Both halves are required, and `isStoppedTurnResult` explains why: the
    // terminal reason says a turn was aborted but never by whom, so intent
    // comes from DorkOS's own stop record.
    const subtype = result.subtype as string | undefined;
    const stopped = isStoppedTurnResult({
      terminalReason,
      stopWasRequested: stopWasRequested ?? false,
    });
    if (subtype && subtype !== 'success' && !stopped) {
      const errors = result.errors as string[] | undefined;
      // Prefer the auth category when the failure text or subtype signals a
      // revoked/expired sign-in, so the client offers a re-auth affordance
      // instead of a generic execution error.
      const isAuthError = detectAuthError({ message: errors?.join(' '), code: subtype });
      // A credential failure gets DorkOS's own sentence, not the CLI's. The two
      // SDK channels used to disagree about the SAME expiry: the assistant
      // channel already spoke this sentence while this one forwarded the binary's
      // internals verbatim ("Failed to authenticate: OAuth session expired and
      // could not be refreshed"). Which one a person met depended only on which
      // channel the CLI happened to report through (DOR-1656). Nothing is lost —
      // `details` below already carries every raw error line.
      const message = isAuthError
        ? describeAuthError(CLAUDE_CODE_RUNTIME_TYPE)
        : (errors?.[0] ?? 'An unexpected error occurred.');
      yield {
        type: 'error',
        data: {
          message,
          code: subtype,
          category: isAuthError ? 'auth_error' : mapErrorCategory(subtype),
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
