import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { WorktreeScanEntry, WorktreeScanWarning } from '@dorkos/shared/workspace';

/** Query key for the worktree adoption scan. */
export const worktreeScanQueryKey = ['workspaces', 'scan'] as const;

/**
 * How long a scan stays fresh. Each scan shells out to git once per checkout, so
 * re-running it on every remount would spawn dozens of processes on a machine
 * already busy running agents. A minute is far shorter than the pace at which
 * worktrees appear and disappear.
 */
const SCAN_STALE_MS = 60_000;

/**
 * Fetch the checkouts that really exist under the workspace root. Backs the
 * `/workspaces` view; read-only, so there is nothing to invalidate after.
 */
export function useWorktreeScan(): {
  root: string | null;
  worktrees: WorktreeScanEntry[];
  warnings: WorktreeScanWarning[];
  isLoading: boolean;
  isError: boolean;
} {
  const transport = useTransport();
  const query = useQuery({
    queryKey: worktreeScanQueryKey,
    queryFn: () => transport.scanWorktrees(),
    staleTime: SCAN_STALE_MS,
  });
  return {
    root: query.data?.root ?? null,
    worktrees: query.data?.worktrees ?? [],
    warnings: query.data?.warnings ?? [],
    isLoading: query.isLoading,
    // A failed scan is not an empty one. The page has to be able to tell them
    // apart, or a dropped connection renders as "you have no worktrees".
    isError: query.isError,
  };
}
