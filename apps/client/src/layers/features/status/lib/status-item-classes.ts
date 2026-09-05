/**
 * Shared trigger classes for the composer status line's clickable items.
 *
 * `RuntimeItem`, `ModelConfigPopover`, `PlanModeItem` and `PermissionModeItem`
 * each hand-copied this string before this file existed, and none of the four
 * copies carried a focus-visible ring — a keyboard user tabbing the status
 * line fell back to Chromium's native blue outline on every one of them
 * (UI/UX audit batch 3, DOR-1749). One string, one fix.
 *
 * @module features/status/lib/status-item-classes
 */

/**
 * Base classes for a status-line item's clickable trigger: hover colour,
 * shrink-safe layout, the hover transition, and the app's keyboard focus
 * ring. Callers add their own `items-center gap-1`, disabled state, and
 * active-state colour on top via `cn()`.
 */
export const STATUS_ITEM_TRIGGER_CLASS =
  'hover:text-foreground inline-flex min-w-0 rounded-sm outline-none transition-colors duration-150 focus-visible:ring-ring/50 focus-visible:ring-[3px]';
