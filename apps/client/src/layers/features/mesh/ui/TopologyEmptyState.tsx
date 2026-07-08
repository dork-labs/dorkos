import { Globe } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

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
        <Button variant="outline" size="sm" onClick={onGoToDiscovery} className="mt-1">
          Go to Discovery
        </Button>
      )}
    </div>
  );
}
