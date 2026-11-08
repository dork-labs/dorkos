/**
 * Claude Code's half of the turn-context record. Two parts per turn, in the
 * order the model meets them: the session append (the text DorkOS adds after
 * the `claude_code` preset) and the turn's prompt (its context blocks and the
 * words). What Claude Code loads by itself — its preset, CLAUDE.md, skills —
 * never passes through DorkOS and is not recorded here.
 *
 * The append is read from what the SDK was actually handed: the per-turn path
 * hands it on every turn; a warm process holds the one it was launched with
 * ({@link AgentSession.liveSystemAppend}), which can be older than the append
 * this turn resolved.
 *
 * @module services/runtimes/claude-code/messaging/turn-context-record
 */
import type {
  Options,
  Query,
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import {
  attachTurnContextUsage,
  recordTurnContext,
  turnPlaceOf,
} from '../../../../session/turn-context/record-turn-context.js';
import type {
  TurnContextPartInput,
  TurnContextUsage,
} from '../../../../session/turn-context/turn-context-store.js';
import type { AgentSession } from '../../agent-types.js';

/** The runtime name the record carries. */
const RUNTIME = 'claude-code';

/**
 * How long the measured count may take before the estimate is asked for
 * instead. `'full'` runs the token-count API once per category, which costs
 * about half a second on a warm process (see `sdk/context-usage.ts`).
 */
const FULL_USAGE_BOUND_MS = 1_000;
/** How long the estimate may take before the record goes without a count. */
const SUMMARY_USAGE_BOUND_MS = 1_000;

/** A promise that rejects once `ms` pass without an answer. */
async function within<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The SDK's answer, kept to what the record needs: counts, never text. */
function usageOf(
  answer: SDKControlGetContextUsageResponse,
  kind: TurnContextUsage['kind']
): TurnContextUsage {
  return {
    kind,
    at: 'turn_start',
    ...(answer.model ? { model: answer.model } : {}),
    totalTokens: answer.totalTokens,
    maxTokens: answer.maxTokens,
    categories: answer.categories.map((category) => ({
      ...(category.id !== undefined ? { id: category.id } : {}),
      name: category.name,
      tokens: category.tokens,
      kind: category.kind,
    })),
  };
}

/**
 * Ask a live process how its context breaks down: the measured count first,
 * the SDK's estimate when that is slow or refused, and `null` when neither
 * answers. Never throws.
 *
 * @param query - The process the turn was handed to.
 * @param bounds - How long each ask may take; injectable for tests.
 */
export async function measureTurnStartUsage(
  query: Pick<Query, 'getContextUsage'>,
  bounds = { fullMs: FULL_USAGE_BOUND_MS, summaryMs: SUMMARY_USAGE_BOUND_MS }
): Promise<TurnContextUsage | null> {
  try {
    return usageOf(
      await within(query.getContextUsage({ detail: 'full' }), bounds.fullMs),
      'measured'
    );
  } catch {
    // Slow, rate-limited or refused: the estimate costs no token-count calls.
  }
  try {
    const answer = await within(query.getContextUsage({ detail: 'summary' }), bounds.summaryMs);
    return usageOf(answer, 'estimate');
  } catch {
    return null;
  }
}

/**
 * The append a launch hands the SDK, or `undefined` when it hands none.
 *
 * @param options - The SDK options of the launch.
 */
export function systemAppendOf(options: Options): string | undefined {
  const prompt = options.systemPrompt;
  return prompt !== undefined &&
    !Array.isArray(prompt) &&
    typeof prompt !== 'string' &&
    prompt.type === 'preset'
    ? prompt.append
    : undefined;
}

/** What one Claude Code hand-over records. */
export interface ClaudeTurnContext {
  /** The session that took the turn. */
  sessionId: string;
  /** The message the turn delivered. */
  messageId?: string;
  /** The append the process runs on, or `undefined` when it has none. */
  systemAppend: string | undefined;
  /** Whether the append rode this hand-over (a launch) or was already held. */
  systemSentThisTurn: boolean;
  /** The prompt exactly as handed over: context blocks and words. */
  prompt: string;
  /** The SDK options of this turn, for its permission mode. */
  sdkOptions: Options;
  /** The turn's message options, for where it happened. */
  messageOpts: MessageOpts | undefined;
  /** The process the turn went to, asked for its context count beside the turn. */
  query?: Pick<Query, 'getContextUsage'> | undefined;
}

/**
 * Record one Claude Code hand-over. Never throws.
 *
 * @param turn - What was handed over.
 */
export function recordClaudeTurnContext(turn: ClaudeTurnContext): void {
  const parts: TurnContextPartInput[] = [];
  if (turn.systemAppend !== undefined)
    parts.push({ slot: 'system_append', text: turn.systemAppend });
  parts.push({ slot: 'prompt', text: turn.prompt });
  const id = recordTurnContext({
    sessionId: turn.sessionId,
    ...(turn.messageId !== undefined ? { messageId: turn.messageId } : {}),
    runtime: RUNTIME,
    place: turnPlaceOf(turn.messageOpts),
    ...(turn.sdkOptions.permissionMode !== undefined
      ? { permissionMode: turn.sdkOptions.permissionMode }
      : {}),
    systemSentThisTurn: turn.systemSentThisTurn,
    parts,
  });
  // Beside the turn, never in its way: the count lands on the record when it comes.
  if (id === null || turn.query === undefined) return;
  void measureTurnStartUsage(turn.query).then((usage) => {
    if (usage !== null) attachTurnContextUsage(id, usage);
  });
}

/**
 * Note the append a warm process was just launched with. Called by the pump's
 * launcher right after it hands the options to the SDK.
 *
 * @param session - The session whose process launched.
 * @param options - The options it launched with.
 */
export function noteLaunchedAppend(session: AgentSession, options: Options): void {
  const text = systemAppendOf(options);
  session.liveSystemAppend = text === undefined ? undefined : { text, recorded: false };
}

/**
 * Record a warm-process turn once its prompt is in the process. The append is
 * the one the process holds; the first turn after a launch claims it as sent.
 *
 * @param session - The session.
 * @param sessionId - The id the turn was dispatched under.
 * @param messageId - The message the turn delivered.
 * @param plan - The turn's plan: the prompt it handed over and its options.
 * @param messageOpts - The turn's message options, for where it happened.
 */
export function recordPumpTurnContext(
  session: AgentSession,
  sessionId: string,
  messageId: string,
  plan: { enrichedContent: string; sdkOptions: Options },
  messageOpts: MessageOpts | undefined
): void {
  const live = session.liveSystemAppend;
  const sentNow = live !== undefined && !live.recorded;
  if (live !== undefined) live.recorded = true;
  recordClaudeTurnContext({
    sessionId,
    messageId,
    systemAppend: live?.text,
    systemSentThisTurn: sentNow,
    prompt: plan.enrichedContent,
    sdkOptions: plan.sdkOptions,
    messageOpts,
    query: session.activeQuery,
  });
}
