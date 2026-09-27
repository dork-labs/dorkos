import { countAgentsFollowing, type PermissionDefaultKey } from '@dorkos/shared/permissions';
import { usePermissions } from './use-permissions';

/**
 * How many agents a change to one default reaches, before it is made ("affects
 * 33 agents"): the agents that follow that key today. Every surface that
 * changes a default reads this one count, computed by the same shared function
 * the CLI uses, so no two surfaces can disagree (spec `agent-permissions`, task
 * 4.3).
 *
 * @param key - The default about to change.
 * @returns The count, or `undefined` until the permissions have been read.
 */
export function useAffectedAgentCount(key: PermissionDefaultKey): number | undefined {
  const { data } = usePermissions();
  return data ? countAgentsFollowing(data, key) : undefined;
}
