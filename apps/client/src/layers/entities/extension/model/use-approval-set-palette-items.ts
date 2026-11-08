/**
 * ⌘K's "Review {plugin} extensions" rows (DOR-3583): one per plugin whose
 * extensions wait to be allowed together. A row only opens the card in
 * Settings → Extensions; it never approves anything itself.
 *
 * @module entities/extension/model/use-approval-set-palette-items
 */
import { useMemo } from 'react';
import type { CommandPaletteContribution } from '@/layers/shared/model';
import { pluginDisplayName, useApprovalSets } from './use-approval-sets';

/** The action prefix ⌘K's `usePaletteActions` dispatches on; the plugin id follows it. */
export const REVIEW_EXTENSION_SET_ACTION = 'reviewExtensionSet:';

/** The Settings section a group row answers to, for a plugin. */
export function extensionSetSection(plugin: string): string {
  return `group:${plugin}`;
}

/**
 * The plugin a palette action names, or null when it is not a review row.
 *
 * @param action - The palette action.
 */
export function extensionSetFromAction(action: string): string | null {
  return action.startsWith(REVIEW_EXTENSION_SET_ACTION)
    ? action.slice(REVIEW_EXTENSION_SET_ACTION.length)
    : null;
}

/** One row per plugin with extensions waiting together. */
export function useExtensionSetPaletteItems(): CommandPaletteContribution[] {
  const { data: sets } = useApprovalSets();
  return useMemo(
    () =>
      (sets ?? []).map((set) => ({
        id: `extension-set-${set.plugin}`,
        label: `Review ${pluginDisplayName(set.plugin)} extensions`,
        icon: 'Shapes',
        action: `${REVIEW_EXTENSION_SET_ACTION}${set.plugin}`,
        category: 'quick-action' as const,
        priority: 20,
        keywords: ['extension', 'allow', 'approve', set.plugin],
      })),
    [sets]
  );
}
