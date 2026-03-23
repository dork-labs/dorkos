import { cn } from '@/layers/shared/lib';
import type { MeshStatus } from '@dorkos/shared/mesh-schemas';
import type { StatusFilter } from './AgentFilterBar';

interface FleetHealthBarProps {
  /** Aggregate mesh status with per-status counts. */
  status: MeshStatus;
  /** Currently active status filter. */
  activeFilter: StatusFilter;
  /** Called when user clicks a status segment. */
  onStatusFilter: (status: StatusFilter) => void;
}

/** Color dot for each status segment. */
function StatusDot({ status }: { status: Exclude<StatusFilter, 'all'> }) {
  const dotClass = {
    active: 'bg-emerald-500',
    inactive: 'bg-amber-500',
    stale: 'bg-muted-foreground/30',
    unreachable: 'bg-red-500',
  }[status];

  return <span className={cn('inline-block h-2 w-2 rounded-full', dotClass)} aria-hidden="true" />;
}

interface SegmentConfig {
  status: Exclude<StatusFilter, 'all'>;
  count: number;
  label: string;
}

function buildSegments(status: MeshStatus): SegmentConfig[] {
  const all: SegmentConfig[] = [
    { status: 'active', count: status.activeCount, label: 'Active' },
    { status: 'inactive', count: status.inactiveCount, label: 'Inactive' },
    { status: 'stale', count: status.staleCount, label: 'Stale' },
    { status: 'unreachable', count: status.unreachableCount, label: 'Unreachable' },
  ];
  return all.filter((seg) => seg.count > 0);
}

/**
 * Fleet health bar — colored dot segments with clickable counts for each
 * health status. Clicking a segment activates that filter; clicking again
 * resets to 'all'.
 */
export function FleetHealthBar({ status, activeFilter, onStatusFilter }: FleetHealthBarProps) {
  const segments = buildSegments(status);
  const totalLabel = status.totalAgents === 1 ? '1 agent' : `${status.totalAgents} agents`;

  function handleSegmentClick(segmentStatus: Exclude<StatusFilter, 'all'>) {
    // Toggle off: clicking the active filter resets to 'all'
    onStatusFilter(activeFilter === segmentStatus ? 'all' : segmentStatus);
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2 text-xs">
      {segments.map(({ status: segStatus, count, label }) => {
        const isActive = activeFilter === segStatus;

        return (
          <button
            key={segStatus}
            type="button"
            aria-label={`${count} ${label}`}
            onClick={() => handleSegmentClick(segStatus)}
            className={cn(
              'flex min-h-[44px] items-center gap-1.5 transition-colors sm:min-h-0',
              isActive
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <StatusDot status={segStatus} />
            <span className="tabular-nums">{count}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}

      <span className="text-muted-foreground ml-auto tabular-nums">{totalLabel}</span>
    </div>
  );
}
