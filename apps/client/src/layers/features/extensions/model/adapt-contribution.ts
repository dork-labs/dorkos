/**
 * How a `registerComponent` call becomes the contribution shape each registry
 * slot draws. Split from the API factory so that file stays readable.
 *
 * @module features/extensions/model/adapt-contribution
 */
import type { ComponentType } from 'react';
import type { ExtensionPointId, ExtensionTabPlacement } from '@dorkos/extension-api';
import { placementFromInput } from '@dorkos/shared/mini-app-placement';

/** Default priority for extension contributions (mid-range, after built-ins). */
const DEFAULT_PRIORITY = 50;

/** Lucide icon name used as a fallback for extension commands. */
export const FALLBACK_ICON = 'puzzle';

/** Default order of an extension's status-bar item among the others (spec §11.1). */
export const DEFAULT_STATUS_BAR_PRIORITY = 100;

/**
 * Adapt a generic component registration into the Phase 2 registry's per-slot
 * contribution shape. Each slot has its own required fields.
 */
export function adaptToContribution(
  // `registerComponent` refuses `dialog` before it gets here (no way to open it).
  slot: Exclude<ExtensionPointId, 'dialog'>,
  id: string,
  component: ComponentType,
  options?: {
    priority?: number;
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    group?: string;
    visibleWhen?: () => boolean;
    showIn?: ExtensionTabPlacement;
  }
): Record<string, unknown> {
  const base = { id, priority: options?.priority ?? DEFAULT_PRIORITY };
  // Human label for labelled/tabbed slots; namespaced id is the honest fallback.
  const label = options?.label ?? id;

  switch (slot) {
    case 'dashboard.sections':
      // `visibleWhen` is forwarded, not dropped: the section renders on the
      // Activity tab, which re-evaluates the predicate on every render, so an
      // extension can hide its own section without unregistering it.
      return { ...base, component, visibleWhen: options?.visibleWhen };
    case 'sidebar.footer':
      return {
        ...base,
        onClick: () => {},
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'right-panel':
      // Third-party right-panel tabs register their content component and, if
      // they choose, a tab icon; the strip falls back to a puzzle-piece when
      // `icon` is omitted. The container owns the shared header (tab strip +
      // close), so an extension tab can never trap the user — no per-tab header
      // wiring is required. `headerActions` is reserved for built-ins that need
      // header controls.
      // `extensionId` and `declaredPlacement` are what make it a mini-app tab
      // to the panel: placement rules apply only to tabs that carry them.
      return {
        ...base,
        component,
        title: label,
        icon: options?.icon,
        headerActions: undefined,
        visibleWhen: undefined,
        extensionId: id.slice(0, id.indexOf(':')),
        declaredPlacement: placementFromInput(options?.showIn),
      };
    case 'settings.tabs':
      return {
        ...base,
        component,
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        // Absent group is resolved to "Add-ons" by the Settings dialog itself.
        group: options?.group,
      };
    case 'command-palette.items':
      return {
        ...base,
        label,
        icon: FALLBACK_ICON,
        action: `ext:${id}`,
        category: 'feature' as const,
        // So the palette names the app from DorkOS's record (DOR-4282).
        extensionId: id.slice(0, id.indexOf(':')),
      };
    case 'status-bar':
      // `registerStatusBarItem` is the documented way in; this keeps
      // `registerComponent('status-bar', …)` from registering something the bar
      // cannot draw. Always shown, never urgent.
      return {
        ...base,
        extensionId: id.slice(0, id.indexOf(':')),
        label,
        priority: options?.priority ?? DEFAULT_STATUS_BAR_PRIORITY,
        component,
      };
    default: {
      // Exhaustive check for future slot additions
      const _exhaustive: never = slot;
      console.warn('[ExtensionAPI] Unknown slot:', _exhaustive);
      return { ...base, component };
    }
  }
}
