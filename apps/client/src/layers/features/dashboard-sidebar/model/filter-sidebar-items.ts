/**
 * Pure section-level display filtering (sidebar-groups, DOR-580; originally
 * agent-list-settings, DOR-339).
 *
 * Sibling of `sort-sidebar-items.ts`: that orders a section's rows, this decides
 * which of them are visible at all. It reads the item view model, so a group
 * holding a channel filters with no code of its own.
 *
 * @module features/dashboard-sidebar/model/filter-sidebar-items
 */
import type { SidebarDisplayFilter } from '@dorkos/shared/config-schema';
import type { AttentionState } from '@/layers/entities/session';
import type { SidebarItem } from './sidebar-item';

/** The result of applying a section's display filter to its items. */
export interface FilteredSidebarItems {
  /** Items that render normally. */
  visible: SidebarItem[];
  /** Items hidden by the `active`/`attention` filter — the "N hidden" reveal row. */
  filteredOut: SidebarItem[];
  /**
   * `all` filter only: `inactive`-state items collapsed behind "N inactive
   * agents". Only agents ever land here — a room is never `inactive` (see
   * {@link SidebarItem.attention}), which is what keeps that label honest.
   */
  inactive: SidebarItem[];
}

/** Inputs {@link filterSidebarItems} needs to decide what is visible. */
export interface FilterSidebarItemsOptions {
  /** The section's active display filter. */
  filter: SidebarDisplayFilter;
  /**
   * Whether the containing group is muted — applies to every item in this call.
   * Separate from {@link SidebarItem.muted}, which is the item's own mute:
   * group mute belongs to the group, and the same agent can sit in a muted group
   * and an unmuted one.
   */
  groupMuted: boolean;
}

/**
 * A muted item's `needs-attention` signal is suppressed by definition (DOR-339
 * decision 6): mute caps the effective state at `active`. This is the ONE place
 * that downgrade happens — every filter branch below reads `effectiveState`,
 * never `item.attention` directly, so mute semantics can never drift between the
 * three branches.
 */
function effectiveState(item: SidebarItem, groupMuted: boolean): AttentionState {
  const muted = groupMuted || item.muted;
  return muted && item.attention === 'needs-attention' ? 'active' : item.attention;
}

/**
 * Apply a section's display filter to its items, per the filter × mute × state
 * interplay matrix:
 *
 * | filter        | visible                                       | filteredOut | inactive row     |
 * | ------------- | --------------------------------------------- | ----------- | ---------------- |
 * | `'all'`       | everything except `inactive`-state items      | (empty)     | inactive items   |
 * | `'active'`    | `needs-attention` + `active` (post-downgrade) | the rest    | (empty)          |
 * | `'attention'` | unmuted `needs-attention` items               | the rest    | (empty)          |
 *
 * Pure and order-preserving — callers sort the returned `visible` list
 * themselves, because sorting applies after filtering.
 *
 * @param items - The section's items, in their pre-filter order.
 * @param opts - Filter and group-mute state to apply.
 */
export function filterSidebarItems(
  items: readonly SidebarItem[],
  opts: FilterSidebarItemsOptions
): FilteredSidebarItems {
  const visible: SidebarItem[] = [];
  const filteredOut: SidebarItem[] = [];
  const inactive: SidebarItem[] = [];

  for (const item of items) {
    const state = effectiveState(item, opts.groupMuted);

    if (opts.filter === 'all') {
      if (state === 'inactive') inactive.push(item);
      else visible.push(item);
      continue;
    }

    if (opts.filter === 'active') {
      if (state === 'needs-attention' || state === 'active') visible.push(item);
      else filteredOut.push(item);
      continue;
    }

    // opts.filter === 'attention'
    if (state === 'needs-attention') visible.push(item);
    else filteredOut.push(item);
  }

  return { visible, filteredOut, inactive };
}
