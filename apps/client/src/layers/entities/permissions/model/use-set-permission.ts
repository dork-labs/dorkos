import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PermissionPreset,
  PermissionState,
  PermissionSurface,
} from '@dorkos/shared/permissions';
import { useTransport } from '@/layers/shared/model';
import { permissionKeys } from './permission-keys';

/** Where a permission write lands. */
export type PermissionScope = { kind: 'default' } | { kind: 'agent'; agentId: string };

/** One permission write, in the scope's own terms. */
export type SetPermissionInput =
  | {
      /** Change areas or actions; `null` removes a change. */
      kind: 'patch';
      areas?: Record<string, PermissionState | null>;
      actions?: Record<string, PermissionState | null>;
      /** Default scope only: agents to bring along to the new default. */
      applyToAgents?: string[];
      surface: PermissionSurface;
    }
  | {
      /** Default scope only: choose a preset. */
      kind: 'preset';
      preset: PermissionPreset;
      applyToAgents?: string[];
      surface: PermissionSurface;
    };

/**
 * Write a permission for one scope — the defaults, or one agent — through the
 * matching route.
 *
 * Deliberately NOT optimistic: a refused write (only a person can change
 * permissions) must leave the switch where it was, so the cached value only
 * moves when the server's answer comes back. Every write refreshes the
 * overview, every agent view, the history, and the mesh agent list.
 *
 * @param scope - Where the write lands.
 * @returns The TanStack mutation.
 */
export function useSetPermission(scope: PermissionScope) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetPermissionInput) => {
      if (input.kind === 'preset') {
        if (scope.kind !== 'default') throw new Error('A preset is chosen for everyone.');
        return transport.setPermissionPreset({
          preset: input.preset,
          surface: input.surface,
          ...(input.applyToAgents ? { applyToAgents: input.applyToAgents } : {}),
        });
      }
      const body = {
        ...(input.areas ? { areas: input.areas } : {}),
        ...(input.actions ? { actions: input.actions } : {}),
        surface: input.surface,
      };
      if (scope.kind === 'agent') return transport.patchAgentPermissions(scope.agentId, body);
      return transport.patchPermissionDefaults({
        ...body,
        ...(input.applyToAgents ? { applyToAgents: input.applyToAgents } : {}),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
    },
  });
}
