/**
 * Each plugin whose extensions wait to be allowed together (DOR-3583). Read by
 * Settings → Extensions, which draws the "Allow all" card, and by ⌘K, which
 * only opens it.
 *
 * @module entities/extension/model/use-approval-sets
 */
import { useQuery } from '@tanstack/react-query';
import type { ExtensionApprovalSet } from '@dorkos/shared/extension-approval-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';

/** The query key for the waiting sets. Under `['extensions']`, so one refresh covers it. */
export const approvalSetsKey = [...extensionQueryKeys.all, 'approval-sets'] as const;

/**
 * A plugin id as a name a person reads ("marketing-suite" → "Marketing suite").
 *
 * @param plugin - The plugin id.
 */
export function pluginDisplayName(plugin: string): string {
  const words = plugin.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Each plugin whose extensions wait to be allowed together, A–Z by plugin. */
export function useApprovalSets() {
  return useQuery({
    queryKey: approvalSetsKey,
    queryFn: async ({ signal }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions/approval-sets`, { signal });
      if (!res.ok) throw new Error(`Couldn’t check which extensions are waiting (${res.status}).`);
      return ((await res.json()) as { sets: ExtensionApprovalSet[] }).sets;
    },
  });
}
