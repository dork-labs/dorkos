/**
 * Pure section-level display-filter application (agent-list-settings,
 * DOR-339). Sibling to `sort-agents.ts`: sorting orders a section's members,
 * this decides which of them are visible at all — reading the same
 * {@link AttentionState} map that drives the group rollup dot.
 *
 * @module features/dashboard-sidebar/model/filter-agents
 */
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import type { AttentionState } from '@/layers/entities/session';

/**
 * An agent-row candidate for filtering. Sections already operate on bare
 * project paths (see `sort-agents.ts`'s `paths: string[]`); this alias just
 * names that shape for the filter's public API.
 */
export type AgentEntry = string;

/** The result of applying a section's display filter to its member paths. */
export interface FilteredSection {
  /** Members that render normally. */
  visible: AgentEntry[];
  /** Members hidden by the `active`/`attention` filter — the "N hidden" reveal row. */
  filteredOut: AgentEntry[];
  /** `all` filter only: `inactive`-state members collapsed behind "N inactive agents". */
  inactive: AgentEntry[];
}

/** Inputs {@link filterSectionAgents} needs to decide what's visible. */
export interface FilterSectionAgentsOptions {
  /** The section's active display filter. */
  filter: SidebarDisplayFilter;
  /** Agent path → attention state (from `useAgentAttentionMap`). Missing paths default to `inactive`. */
  attention: Record<string, AttentionState>;
  /** Individually-muted agent paths (`ui.sidebar.muted`), independent of any containing group. */
  mutedPaths: ReadonlySet<string>;
  /** Whether the containing group itself is muted — applies to every member in this call. */
  groupMuted: boolean;
}

/**
 * A muted agent's `needs-attention` signal is suppressed by definition
 * (ideation decision 6): mute caps the effective state at `active`. This is
 * the ONE place that downgrade happens — every filter branch below reads
 * `effectiveState`, never `attention` directly, so mute semantics can never
 * drift between the three filter branches.
 */
function effectiveState(
  path: AgentEntry,
  { attention, mutedPaths, groupMuted }: FilterSectionAgentsOptions
): AttentionState {
  const state = attention[path] ?? 'inactive';
  const muted = groupMuted || mutedPaths.has(path);
  return muted && state === 'needs-attention' ? 'active' : state;
}

/**
 * Apply a section's display filter to its member paths, per the spec's
 * filter × mute × state interplay matrix:
 *
 * | filter        | visible                                    | filteredOut | inactive row |
 * | ------------- | ------------------------------------------- | ----------- | ------------ |
 * | `'all'`       | everything except `inactive`-state members  | (empty)     | inactive members |
 * | `'active'`    | `needs-attention` + `active` (post-downgrade) | the rest  | (empty)      |
 * | `'attention'` | unmuted `needs-attention` members            | the rest    | (empty)      |
 *
 * Pure and order-preserving — callers sort the returned `visible` list
 * themselves (spec: sorting applies after filtering, `sort-agents.ts`
 * untouched).
 *
 * @param agents - Member agent paths, in their pre-filter order.
 * @param opts - Filter, attention map, and mute state to apply.
 */
export function filterSectionAgents(
  agents: AgentEntry[],
  opts: FilterSectionAgentsOptions
): FilteredSection {
  const visible: AgentEntry[] = [];
  const filteredOut: AgentEntry[] = [];
  const inactive: AgentEntry[] = [];

  for (const agent of agents) {
    const state = effectiveState(agent, opts);

    if (opts.filter === 'all') {
      if (state === 'inactive') inactive.push(agent);
      else visible.push(agent);
      continue;
    }

    if (opts.filter === 'active') {
      if (state === 'needs-attention' || state === 'active') visible.push(agent);
      else filteredOut.push(agent);
      continue;
    }

    // opts.filter === 'attention'
    if (state === 'needs-attention') visible.push(agent);
    else filteredOut.push(agent);
  }

  return { visible, filteredOut, inactive };
}
