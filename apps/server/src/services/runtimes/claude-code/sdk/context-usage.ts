/**
 * Bridges the SDK's `getContextUsage()` control response to our `ContextUsage`
 * event payload.
 *
 * @module services/runtimes/claude-code/sdk/context-usage
 */
import type { Query, SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsage } from '@dorkos/shared/types';

/**
 * Tooltip dot colors, assigned by category order. The SDK's own category colors
 * are internal theme TOKENS (e.g. "warning", "promptBorder"), not CSS values, so
 * we substitute a stable, theme-neutral palette the client can render directly.
 */
const CATEGORY_PALETTE = [
  '#6366f1', // indigo
  '#22c55e', // green
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ef4444', // red
  '#84cc16', // lime
];

/**
 * Map the SDK's getContextUsage() response to our ContextUsage event payload.
 *
 * Keeps only the rows that occupy the active context window, classified by the
 * SDK's `kind` (0.3.268) rather than by the CLI's display string. The names are
 * what the CLI renders and the SDK's own doc says so outright — _"Use `kind`
 * (not this name) to classify the row"_ — so the previous `name !== 'Free
 * space'` match was one wording change away from putting the whole remaining
 * window into the status-bar breakdown.
 *
 * Two of the four kinds are dropped. `'free'` is the remainder, which would
 * dominate every row beside it. `'deferred'` rows are tool schemas that exist
 * but are not in the prompt, and the SDK excludes them from its own usage math
 * (`isDeferred` is the same rows under the older spelling).
 *
 * `'buffer'` — the compaction reserve — is KEPT, and that is a decision rather
 * than a leftover. The name match included or excluded it by accident depending
 * on what the CLI happened to call it. It is space the conversation cannot use:
 * it is why free space is smaller than the window, and it is what the session
 * compacts into. A breakdown that hides it does not add up to the headline
 * percentage beside it, and an operator who subtracts the rows from the total
 * finds a gap with no name.
 *
 * Colors are reassigned from {@link CATEGORY_PALETTE} because the SDK's are
 * theme tokens, not CSS colors.
 *
 * @param usage - The SDK getContextUsage() control response.
 */
export function mapSdkContextUsage(usage: SDKControlGetContextUsageResponse): ContextUsage {
  return {
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    model: usage.model,
    categories: usage.categories
      .filter((c) => c.kind === 'used' || c.kind === 'buffer')
      .map((c, i) => ({
        name: c.name,
        tokens: c.tokens,
        color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
      })),
  };
}

/**
 * Fetch the context-usage breakdown from a live query, bounded by a timeout so a
 * stuck control channel can never hang the stream. Must be called while the
 * subprocess is still alive (i.e. before the prompt's input stream is closed).
 *
 * **`detail: 'full'`, and that is a measured decision, not the default falling
 * through.** SDK 0.3.257 added `detail: 'summary'`, which answers from the last
 * response's usage and local estimates instead of counting each category. It was
 * measured against `'full'` on a live Opus session over three turns, calling both
 * in alternating order after every turn (2026-09-11, SDK 0.3.268):
 *
 * - **Speed: no win.** The FIRST `'full'` of a session cost 549ms; every call
 *   after it — `'full'`, `'summary'`, or the no-arg default — landed between 1.4
 *   and 4.9ms. The CLI keeps its counts, so the per-category work is paid once
 *   per session, not once per turn, and `'summary'` has nothing left to save.
 * - **Headline figure: identical.** `totalTokens`, `maxTokens` and `percentage`
 *   matched to the digit on all three turns, so the status-bar percentage itself
 *   would not have changed.
 * - **Breakdown: wrong.** The per-category split did NOT match. On the third
 *   turn `'full'` reported `System tools=7629, Messages=4938` where `'summary'`
 *   reported `System tools=11572, Messages=995` — the same total, split between
 *   the wrong rows. `'summary'` cannot attribute what it did not count, so it
 *   banks the difference against system tools.
 *
 * DorkOS renders those rows, and a breakdown telling an operator their
 * conversation occupies 995 tokens when it occupies 4938 is the same class of
 * wrong as the name-matching bug {@link mapSdkContextUsage} was written to fix.
 * So: a real cost of ~0.55s once per session buys an honest breakdown, and the
 * saving on offer is ~1ms a turn. Keep `'full'`. Passed explicitly rather than
 * left to the SDK default so a later default flip cannot quietly decide this.
 *
 * @param query - The active SDK query.
 * @param timeoutMs - Max time to wait for the control response.
 */
export async function fetchContextBreakdown(
  query: Pick<Query, 'getContextUsage'>,
  timeoutMs: number
): Promise<ContextUsage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      query.getContextUsage({ detail: 'full' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('getContextUsage timed out')), timeoutMs);
      }),
    ]);
    return mapSdkContextUsage(usage);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
