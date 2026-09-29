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

/**
 * What was already said about each registered item, so a broken rule logs once
 * rather than on every render. Keyed by the contribution object itself: an
 * extension that reloads registers new ones, so a fix that still fails — or a
 * new failure — is reported again rather than lost behind the old report.
 */
const reported = new WeakMap<StatusBarContribution, Set<string>>();

/**
 * Report one thing about an item, once per registration.
 *
 * @param item - The contribution it is about.
 * @param kind - What is being reported, for the once-only check.
 * @param say - The report.
 */
function reportOnce(item: StatusBarContribution, kind: string, say: () => void): void {
  let said = reported.get(item);
  if (!said) {
    said = new Set();
    reported.set(item, said);
  }
  if (said.has(kind)) return;
  said.add(kind);
  say();
}

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
  let answer: unknown;
  try {
    answer = run();
  } catch (error) {
    reportOnce(item, `${rule}:throw`, () =>
      console.warn(
        `[extensions] ${item.extensionId}'s status-bar item "${item.id}" threw in ${rule}(); ` +
          'it is hidden until it stops throwing.',
        error
      )
    );
    return false;
  }
  // `true` and `false` only. A Promise or a truthy object is the sign of a rule
  // that fetches or reads state it must not (the rules run in the bar's budget
  // pass), so it reads as `false` and says why once.
  if (typeof answer !== 'boolean') {
    reportOnce(item, `${rule}:type`, () =>
      console.warn(
        `[extensions] ${item.extensionId}'s status-bar item "${item.id}": ${rule}() must return ` +
          `true or false, synchronously, reading only its ctx; it returned ${describe(answer)}, ` +
          'read as false.'
      )
    );
    return false;
  }
  return answer;
}

/** A short name for what a rule returned, for the warning. */
function describe(value: unknown): string {
  if (value instanceof Promise) return 'a Promise';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
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
