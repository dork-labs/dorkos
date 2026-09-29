/**
 * Extension items in the chat status bar: which ones show for this chat, and
 * whether any needs attention (spec `flow-multiproject` §6.6).
 *
 * Every item's `when` and `urgent` run here, once per render, before anything
 * is mounted — that is what lets the budget rank the one `extensions` slot
 * without drawing an extension's component to find out whether it has
 * anything to say. The rules are the extension's own code, so each call is
 * guarded: a rule that throws hides its item and says so once, rather than
 * taking the status bar down with it.
 *
 * @module features/status/model/extension-status-items
 */
import { useMemo } from 'react';
import type { StatusBarSlotContext } from '@dorkos/extension-api';
import { useSlotContributions, type StatusBarContribution } from '@/layers/shared/model';
import type { ExtensionItemPromotion } from './status-bar-registry';

/** What {@link evaluateExtensionStatusItems} works out for one chat. */
export interface EvaluatedExtensionStatusItems {
  /** Every item's answer, for the promotion context. */
  promotion: ExtensionItemPromotion[];
  /** The items to draw, lowest `priority` first. */
  visible: StatusBarContribution[];
}

/** Rule failures already reported, so a throwing rule logs once, not every render. */
const reportedFailures = new Set<string>();

/**
 * Run one of an item's rules, treating a throw as `false`.
 *
 * @param item - The contribution the rule belongs to.
 * @param rule - Which rule, for the log line.
 * @param run - The call.
 */
function guarded(
  item: StatusBarContribution,
  rule: 'when' | 'urgent',
  run: () => boolean
): boolean {
  try {
    return run() === true;
  } catch (error) {
    const key = `${item.id}:${rule}`;
    if (!reportedFailures.has(key)) {
      reportedFailures.add(key);
      console.warn(
        `[extensions] ${item.extensionId}'s status-bar item "${item.id}" threw in ${rule}(); ` +
          'it is hidden until it stops throwing.',
        error
      );
    }
    return false;
  }
}

/**
 * Answer every extension status item's rules for one chat.
 *
 * `when` absent means always shown; `urgent` absent means never urgent. An
 * item is only urgent while it is also shown.
 *
 * @param items - Every registered extension status item.
 * @param ctx - The chat the status bar belongs to.
 */
export function evaluateExtensionStatusItems(
  items: readonly StatusBarContribution[],
  ctx: StatusBarSlotContext
): EvaluatedExtensionStatusItems {
  const promotion: ExtensionItemPromotion[] = [];
  const visible: StatusBarContribution[] = [];
  for (const item of items) {
    const shown = item.when ? guarded(item, 'when', () => item.when!(ctx)) : true;
    const urgent = shown && item.urgent ? guarded(item, 'urgent', () => item.urgent!(ctx)) : false;
    promotion.push({ id: item.id, visible: shown, urgent });
    if (shown) visible.push(item);
  }
  // Stable, so equal priorities keep the order they registered in.
  visible.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return { promotion, visible };
}

/**
 * The extension status items for one chat, kept live from the registry.
 *
 * @param ctx - The chat the status bar belongs to.
 */
export function useExtensionStatusItems(ctx: StatusBarSlotContext): EvaluatedExtensionStatusItems {
  const items = useSlotContributions('status-bar');
  return useMemo(() => evaluateExtensionStatusItems(items, ctx), [items, ctx]);
}

/**
 * Forget which rule failures were already reported, so a test can see the
 * first report again.
 *
 * @internal For tests only.
 */
export function resetExtensionStatusFailuresForTests(): void {
  reportedFailures.clear();
}
