import { useMeshEnabled, useMeshStatus } from '@/layers/entities/mesh';

interface MeshStatsHeaderProps {
  /** When false, the header is suppressed regardless of mesh state. Defaults to true. */
  enabled?: boolean;
}

/**
 * Compact aggregate mesh status bar showing total agent count and
 * per-status dot indicators (active / inactive / stale).
 *
 * Renders null when mesh is disabled, the `enabled` prop is false,
 * the query is loading, or no status data is available.
 */
export function MeshStatsHeader({ enabled = true }: MeshStatsHeaderProps) {
  const meshEnabled = useMeshEnabled();
  const { data: status, isLoading } = useMeshStatus(enabled && meshEnabled);

  if (!meshEnabled || !enabled || isLoading || !status) return null;

  return (
    <div className="flex items-center gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground">
      <span>{status.totalAgents} agents</span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
        {status.activeCount}
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
        {status.inactiveCount}
      </span>
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-zinc-400" aria-hidden="true" />
        {status.staleCount}
      </span>
    </div>
  );
}
