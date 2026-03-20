import { Globe } from 'lucide-react';

interface TopologyEmptyStateProps {
  /** Called to switch to the Discovery tab from the empty state. */
  onGoToDiscovery?: () => void;
}

/**
 * Empty state shown in the topology graph when no agents have been discovered.
 */
export function TopologyEmptyState({ onGoToDiscovery }: TopologyEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <Globe className="text-muted-foreground/50 size-10" />
      <div>
        <h3 className="text-sm font-medium">No agents discovered yet</h3>
        <p className="text-muted-foreground mt-1 max-w-[240px] text-xs">
          Discover agents from your workspace to see them on the topology graph.
        </p>
      </div>
      {onGoToDiscovery && (
        <button
          type="button"
          onClick={onGoToDiscovery}
          className="hover:bg-muted mt-1 rounded-md border px-3 py-1.5 text-xs font-medium"
        >
          Go to Discovery
        </button>
      )}
    </div>
  );
}
