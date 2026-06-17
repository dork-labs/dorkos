import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { WorkspaceWithSessions } from '@dorkos/shared/workspace';

/** Query key for the workspace list (optionally scoped to one project). */
export const workspacesQueryKey = (projectKey?: string): [string, string | null] => [
  'workspaces',
  projectKey ?? null,
];

/**
 * Fetch the workspaces (optionally for one project), each with its attached
 * sessions. Backs the `/workspaces` view.
 *
 * @param projectKey - Optional project filter.
 */
export function useWorkspaces(projectKey?: string): {
  workspaces: WorkspaceWithSessions[];
  isLoading: boolean;
  error: unknown;
} {
  const transport = useTransport();
  const query = useQuery({
    queryKey: workspacesQueryKey(projectKey),
    queryFn: () => transport.listWorkspaces(projectKey),
  });
  return { workspaces: query.data ?? [], isLoading: query.isLoading, error: query.error };
}

/** Invalidate the workspace list after a mutation (pin/remove). */
export function useInvalidateWorkspaces(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['workspaces'] });
}
