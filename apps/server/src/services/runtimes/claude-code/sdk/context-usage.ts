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
 * Keeps only the categories that occupy the active context window. Dropped:
 * `isDeferred` categories (tools that are available but not loaded into the
 * prompt) and the "Free space" remainder — neither is current usage, and either
 * would dominate and mislead the status-bar breakdown. Colors are reassigned from
 * {@link CATEGORY_PALETTE} because the SDK's are theme tokens, not CSS colors.
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
      .filter((c) => !c.isDeferred && c.name !== 'Free space')
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
 * @param query - The active SDK query.
 * @param timeoutMs - Max time to wait for the control response.
 */
export async function fetchContextBreakdown(
  query: Query,
  timeoutMs: number
): Promise<ContextUsage> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const usage = await Promise.race([
      query.getContextUsage(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('getContextUsage timed out')), timeoutMs);
      }),
    ]);
    return mapSdkContextUsage(usage);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
