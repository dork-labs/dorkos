/**
 * Context-window token accounting for the Claude Code runtime.
 *
 * @module services/runtimes/claude-code/sdk/context-tokens
 */

/**
 * Sum the input-side token components that occupy the context window for a
 * single turn: fresh (uncached) input, cached reads, and cache writes.
 *
 * Counting `input_tokens` alone drastically understates a cached or resumed
 * conversation — with prompt caching on (always, in Claude Code) the cache terms
 * hold the bulk of the prompt. This is the single source of truth for that
 * summation: both the live result-event path (`result-event-mapper.ts`) and the
 * persisted transcript-tail path (`transcript-reader.ts`) call it, so the value
 * shown mid-stream and the value recomputed after a reload cannot drift. (Those
 * two paths disagreeing was the original cause of the context-usage status-bar
 * bug — keep this the only place the components are added.)
 *
 * @param tokens.inputTokens - Fresh, uncached input tokens for the turn.
 * @param tokens.cacheReadTokens - Tokens served from the prompt cache.
 * @param tokens.cacheCreationTokens - Tokens written to the prompt cache.
 * @returns Total input-side tokens charged against the context window.
 */
export function sumContextTokens(tokens: {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
}): number {
  return (
    (tokens.inputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheCreationTokens ?? 0)
  );
}

/**
 * The context window of the model the main thread is talking to, read from a
 * `result`'s `modelUsage` map.
 *
 * The map holds one entry per model the turn used, and the main model is not
 * reliably the first: the CLI's own small helper calls (Haiku, 200k) usually
 * come first, so reading entry `[0]` showed a 1M-window chat as 200k and
 * crossed the 80% early-warning line at a fifth of the real window. The entry
 * is matched to the main thread's model instead, by key (`claude-opus-5-5[1m]`),
 * by key without its `[…]` variant suffix, or by `canonicalModel`. When more
 * than one entry matches, the larger window wins, since both name the model the
 * conversation runs on. With no main-thread model known, or no entry matching
 * it, the largest window in the map stands in: helper models are the small ones.
 *
 * @param modelUsage - The result's `modelUsage` map, keyed by model string.
 * @param mainModel - The model id the last main-thread assistant message named.
 * @returns The window in tokens, or `undefined` when no entry reports one.
 */
export function mainModelContextWindow(
  modelUsage: Record<string, Record<string, unknown>> | undefined,
  mainModel: string | undefined
): number | undefined {
  if (!modelUsage) return undefined;
  const windows = Object.entries(modelUsage).flatMap(([key, usage]) => {
    const window = usage.contextWindow;
    if (typeof window !== 'number' || window <= 0) return [];
    const matches =
      mainModel !== undefined &&
      (key === mainModel ||
        key.replace(/\[[^\]]*\]$/, '') === mainModel ||
        usage.canonicalModel === mainModel);
    return [{ window, matches }];
  });
  const matched = windows.filter((entry) => entry.matches);
  const pool = matched.length > 0 ? matched : windows;
  if (pool.length === 0) return undefined;
  return Math.max(...pool.map((entry) => entry.window));
}
