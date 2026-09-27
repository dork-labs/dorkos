import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type {
  PermissionPreset,
  PermissionState,
  PermissionSurface,
} from '@dorkos/shared/permissions';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
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
      /** Agent scope only: the agent's own Files & commands stop; `null` = back to the default. */
      filesAndCommands?: PermissionStop | null;
      /** Default scope only: agents to bring along to the new default. */
      applyToAgents?: string[];
      /** The person just confirmed what Full autonomy means (spec `agent-permissions` D16). */
      acknowledgeAutonomy?: true;
      surface: PermissionSurface;
    }
  | {
      /** Default scope only: choose a preset. */
      kind: 'preset';
      preset: PermissionPreset;
      applyToAgents?: string[];
      /** As on a patch: sent when the preset moves Files & commands to Full autonomy. */
      acknowledgeAutonomy?: true;
      surface: PermissionSurface;
    };

/**
 * Whether a failed write is the server asking for the Full autonomy
 * acknowledgement first (`428 AUTONOMY_ACK_REQUIRED`), which is a question to
 * put to the person rather than a failure to report.
 *
 * @param err - What the write threw.
 */
export function isAutonomyAckRefusal(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'AUTONOMY_ACK_REQUIRED';
}

/**
 * Write a permission for one scope — the defaults, or one agent — through the
 * matching route.
 *
 * Deliberately NOT optimistic: a refused write (only a person can change
 * permissions) must leave the switch where it was, so the cached value only
 * moves when the server's answer comes back. Every write refreshes the
 * overview, every agent view, the history, the mesh agent list, and config: a
 * preset sets the Files & commands stop, and a Full autonomy yes is recorded
 * there too.
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
          ...(input.acknowledgeAutonomy ? { acknowledgeAutonomy: true as const } : {}),
        });
      }
      const body = {
        ...(input.areas ? { areas: input.areas } : {}),
        ...(input.actions ? { actions: input.actions } : {}),
        surface: input.surface,
      };
      if (scope.kind === 'agent') {
        return transport.patchAgentPermissions(scope.agentId, {
          ...body,
          ...(input.filesAndCommands !== undefined
            ? { filesAndCommands: input.filesAndCommands }
            : {}),
          ...(input.acknowledgeAutonomy ? { acknowledgeAutonomy: true as const } : {}),
        });
      }
      return transport.patchPermissionDefaults({
        ...body,
        ...(input.applyToAgents ? { applyToAgents: input.applyToAgents } : {}),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });
}
