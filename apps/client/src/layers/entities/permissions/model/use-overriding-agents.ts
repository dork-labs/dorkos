import { useMemo } from 'react';
import type { PermissionAreaId, PermissionException } from '@dorkos/shared/permissions';
import { usePermissions } from './use-permissions';

/**
 * The agents set differently from the default for one area, derived from the
 * overview's `exceptions`. An agent with only action-level differences in the
 * area is included too, once.
 *
 * @param area - The area.
 * @returns The differing agents, each with its area-level state when it has one.
 */
export function useOverridingAgents(area: PermissionAreaId): PermissionException[] {
  const { data } = usePermissions();
  return useMemo(() => {
    const byAgent = new Map<string, PermissionException>();
    for (const exception of data?.exceptions ?? []) {
      if (exception.area !== area) continue;
      const existing = byAgent.get(exception.agentId);
      // The area-level row wins over an action-level one for the summary.
      if (!existing || (existing.action && !exception.action)) {
        byAgent.set(exception.agentId, exception);
      }
    }
    return [...byAgent.values()];
  }, [data, area]);
}
