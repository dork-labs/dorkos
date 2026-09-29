import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PermissionSurface } from '@dorkos/shared/permissions';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/** Which of an agent's own settings to put back on the default. */
export type AgentPermissionKey =
  { kind: 'area'; area: string } | { kind: 'action'; action: string } | { kind: 'files' };

/** One reset: the agent, the setting, and where it was made. */
export interface ResetAgentPermissionInput {
  agentId: string;
  key: AgentPermissionKey;
  surface: PermissionSurface;
}

/**
 * Put one of any agent's own settings back on the default, for a list that
 * spans agents (the Control Center's exceptions). `useSetPermission` binds one
 * agent per hook; a list of rows across agents needs the agent per call.
 *
 * @returns The TanStack mutation.
 */
export function useResetAgentPermission() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, key, surface }: ResetAgentPermissionInput) =>
      transport.patchAgentPermissions(agentId, {
        ...(key.kind === 'area' ? { areas: { [key.area]: null } } : {}),
        ...(key.kind === 'action' ? { actions: { [key.action]: null } } : {}),
        ...(key.kind === 'files' ? { filesAndCommands: null } : {}),
        surface,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
    },
  });
}
