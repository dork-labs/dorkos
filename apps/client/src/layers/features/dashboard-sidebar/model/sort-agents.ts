/**
 * Pure agent-path sort helpers for the dashboard sidebar (DOR-329).
 *
 * Group sections use all three modes; the ungrouped ("Agents") section only ever
 * uses `name` or `recent`. All sorts are stable and never mutate their input.
 *
 * @module features/dashboard-sidebar/model/sort-agents
 */

/** How a section orders its member agent rows. */
export type AgentSortMode = 'manual' | 'name' | 'recent';

/** Lookup maps a sort needs: disambiguated display names and per-agent activity. */
export interface SortAgentsContext {
  /** Agent projectPath → disambiguated display name (mirrors the sidebar's own logic). */
  displayNames: Record<string, string>;
  /** Agent projectPath → latest session `updatedAt` (ISO string); absent when the agent has no sessions. */
  agentActivity: Record<string, string>;
}

/**
 * Sort agent project paths by the given mode, immutably.
 *
 * - `manual` — returns a copy of `paths` in the given order (no sorting).
 * - `name` — ascending `localeCompare` on the disambiguated display name.
 * - `recent` — descending by `agentActivity` timestamp; paths with no activity
 *   sort last, and ties (equal or both-missing timestamps) break by display name.
 *
 * @param paths - Agent project paths to order.
 * @param mode - Ordering mode.
 * @param ctx - Display-name and activity lookups.
 */
export function sortAgentPaths(
  paths: string[],
  mode: AgentSortMode,
  ctx: SortAgentsContext
): string[] {
  if (mode === 'manual') return [...paths];

  const nameOf = (path: string): string => ctx.displayNames[path] ?? path;

  if (mode === 'name') {
    return [...paths].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }

  // mode === 'recent'
  return [...paths].sort((a, b) => {
    const ta = ctx.agentActivity[a];
    const tb = ctx.agentActivity[b];
    if (ta && tb) {
      if (ta !== tb) return ta < tb ? 1 : -1; // later timestamp first
      return nameOf(a).localeCompare(nameOf(b));
    }
    if (ta) return -1; // a has activity, b does not → a first
    if (tb) return 1; // b has activity, a does not → b first
    return nameOf(a).localeCompare(nameOf(b)); // both missing → name tiebreak
  });
}
