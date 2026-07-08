import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useTransport } from '@/layers/shared/model';

/**
 * Worktree/branch badge for the explorer header (spec right-panel-workbench,
 * Chunk B). Resolves the session cwd to its containing workspace via
 * `transport.resolveWorkspace`; renders the branch when the cwd is a workspace
 * checkout and nothing when it is a plain directory (graceful degrade).
 *
 * @param cwd - Absolute session working directory to resolve.
 */
export function WorkspaceBadge({ cwd }: { cwd: string }) {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: ['file-explorer', 'workspace', cwd],
    queryFn: () => transport.resolveWorkspace(cwd),
    staleTime: 60_000,
  });

  if (!data?.branch) return null;

  return (
    <span
      className="text-muted-foreground bg-muted/50 inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
      title={`Workspace ${data.key} on ${data.branch}`}
    >
      <GitBranch className="size-3 flex-shrink-0" />
      <span className="truncate">{data.branch}</span>
    </span>
  );
}
