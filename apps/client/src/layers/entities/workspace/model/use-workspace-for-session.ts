import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { Workspace } from '@dorkos/shared/workspace';

/**
 * Resolve the managed workspace that contains a session's cwd — the lookup
 * behind the session-view workspace indicator. Returns `null` when the cwd is
 * not inside a managed workspace (the "main checkout" case).
 *
 * @param cwd - The session's working directory (or null/undefined when unknown).
 */
export function useWorkspaceForSession(cwd: string | undefined | null): Workspace | null {
  const transport = useTransport();
  const query = useQuery({
    queryKey: ['workspace-for-session', cwd ?? null],
    queryFn: () => transport.resolveWorkspace(cwd as string),
    enabled: Boolean(cwd),
  });
  return query.data ?? null;
}
