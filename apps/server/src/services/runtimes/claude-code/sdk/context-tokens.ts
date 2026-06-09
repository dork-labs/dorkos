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
