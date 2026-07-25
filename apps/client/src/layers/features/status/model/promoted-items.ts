/**
 * Turns the registry plus live state into the ordered list of items the status
 * line renders. This is the one place promotion decisions are made — the line
 * itself only draws what it is handed, so nothing about "should this show?" is
 * buried in JSX where it cannot be measured, tested, or truncated.
 *
 * @module features/status/model/promoted-items
 */
import type { ReactNode } from 'react';
import {
  STATUS_BAR_REGISTRY,
  isPinnable,
  type StatusBarCluster,
  type StatusBarItemKey,
  type StatusPromotionContext,
} from './status-bar-registry';

/** One status item that earned a slot in the line. */
export interface PromotedStatusItem {
  /** Registry key — the React key and the pin identity. */
  key: StatusBarItemKey;
  /** Which cluster it renders in. */
  cluster: StatusBarCluster;
  /**
   * Budget rank resolved against the item's current state — higher wins a
   * contested slot when the bar cannot fit everything that promoted.
   */
  severity: number;
  /**
   * True when a person has pinned this item. A pin is what puts a quiet item in
   * the line, and it raises the item's priority when slots are contested — but it
   * never exempts it from a width budget.
   */
  pinned: boolean;
  /** The rendered item. */
  node: ReactNode;
}

/** Inputs to {@link selectPromotedItems}. */
export interface SelectPromotedItemsInput {
  /** Live state the promotion rules read. */
  ctx: StatusPromotionContext;
  /** Pinned keys as persisted (opaque strings; unknown or unpinnable keys are ignored). */
  pins: readonly string[];
  /**
   * The rendered node for each key. A key with no node — because its data has
   * not arrived, or there is nothing to show — never enters the line, whatever
   * its rule says. Absence of content is its own answer.
   */
  nodes: Partial<Record<StatusBarItemKey, ReactNode>>;
}

/** Whether a node is worth giving a slot to. */
function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/**
 * Select the items the status line should show, in registry order.
 *
 * An item is included when it has renderable content, is not categorically
 * excluded from the line, and either its promotion rule fires or a person
 * pinned it. A pin overrides the promotion rule and raises priority — it does
 * **not** buy immunity from a width budget, or pinning five items would recreate
 * the overflow this design exists to remove.
 *
 * The result is deliberately data, not markup: a caller that has to fit the line
 * into a measured width can sort it by `severity`, cut it, and report the
 * remainder as a count.
 *
 * @param input - Live promotion context, the pin list, and the node per key.
 */
export function selectPromotedItems({
  ctx,
  pins,
  nodes,
}: SelectPromotedItemsInput): PromotedStatusItem[] {
  const pinnedKeys = new Set(pins);
  const promoted: PromotedStatusItem[] = [];

  for (const item of STATUS_BAR_REGISTRY) {
    if (item.neverInLine) continue;

    const node = nodes[item.key];
    if (!hasContent(node)) continue;

    const pinned = pinnedKeys.has(item.key) && isPinnable(item);
    if (!pinned && !item.promote(ctx)) continue;

    promoted.push({
      key: item.key,
      cluster: item.cluster,
      severity: item.severity(ctx),
      pinned,
      node,
    });
  }

  return promoted;
}
