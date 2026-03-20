import { useMeshStatus } from '@/layers/entities/mesh';

interface MeshStatsHeaderProps {
  /** When false, the header is suppressed. Defaults to true. */
  enabled?: boolean;
}

/**
 * Compact aggregate mesh status bar showing total agent count and
 * per-status dot indicators (active / inactive / stale).
 *
 * Renders null when the `enabled` prop is false, the query is loading,
 * or no status data is available.
 */
export function MeshStatsHeader({ enabled = true }: MeshStatsHeaderProps) {
  const { data: status, isLoading } = useMeshStatus(enabled);

  if (!enabled || isLoading || !status) return null;

  return (
    <div className="text-muted-foreground flex items-center gap-3 border-b px-3 py-1.5 text-xs">
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
