import { useMemo } from 'react';
import { Search } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui/button';
import { Input } from '@/layers/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';

export type StatusFilter = 'all' | 'active' | 'inactive' | 'stale' | 'unreachable';

export interface FilterState {
  searchQuery: string;
  statusFilter: StatusFilter;
  namespaceFilter: string;
}

/** Color classes for each non-'all' status chip. */
const statusChipColors: Record<Exclude<StatusFilter, 'all'>, string> = {
  active: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
  inactive: 'border-amber-500/30 text-amber-600 dark:text-amber-400',
  stale: 'border-muted-foreground/20 text-muted-foreground',
  unreachable: 'border-red-500/30 text-red-600 dark:text-red-400',
};

/** Human-readable labels for the mobile status dropdown. */
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'stale', label: 'Stale' },
  { value: 'unreachable', label: 'Unreachable' },
];

interface AgentFilterBarProps {
  agents: AgentManifest[];
  /** Current filter state (controlled). */
  filterState: FilterState;
  /** Callback when any filter changes. */
  onFilterStateChange: (state: FilterState) => void;
  /** Number of agents after filtering (shown as result count). */
  filteredCount: number;
  /** Per-status counts used to annotate chips and hide zero-count entries. */
  statusCounts?: Record<Exclude<StatusFilter, 'all'>, number>;
}

/**
 * Filter bar for the agents list — search input, color-coded status chips,
 * namespace dropdown, result count, and a mobile-friendly status dropdown.
 */
export function AgentFilterBar({
  agents,
  filterState,
  onFilterStateChange,
  filteredCount,
  statusCounts,
}: AgentFilterBarProps) {
  const { searchQuery, statusFilter, namespaceFilter } = filterState;

  const namespaces = useMemo(
    () => [...new Set(agents.map((a) => a.namespace).filter((ns): ns is string => Boolean(ns)))],
    [agents]
  );

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3">
      {/* Search input — flexible width, caps at 16rem on sm+ */}
      <div className="relative flex-1 sm:max-w-[16rem]">
        <Search className="text-muted-foreground absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
        <Input
          className="h-8 min-w-[8rem] pl-7 text-sm"
          placeholder="Filter agents..."
          value={searchQuery}
          onChange={(e) => onFilterStateChange({ ...filterState, searchQuery: e.target.value })}
        />
      </div>

      {/* Desktop status chips — hidden on mobile */}
      <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:gap-1.5">
        {/* 'All' chip has no color override */}
        <Button
          key="all"
          variant={statusFilter === 'all' ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-2.5 text-xs capitalize"
          onClick={() => onFilterStateChange({ ...filterState, statusFilter: 'all' })}
        >
          All
        </Button>

        {(['active', 'inactive', 'stale', 'unreachable'] as const).map((status) => {
          const count = statusCounts?.[status];
          // Hide unreachable chip entirely when count is 0 or undefined
          if (status === 'unreachable' && !count) return null;

          const isActive = statusFilter === status;
          const colorClasses = statusChipColors[status];

          return (
            <Button
              key={status}
              variant="outline"
              size="sm"
              className={cn(
                'h-7 px-2.5 text-xs capitalize',
                isActive ? 'bg-accent' : '',
                !isActive && colorClasses
              )}
              onClick={() => onFilterStateChange({ ...filterState, statusFilter: status })}
            >
              {status}
              {count != null && count > 0 && <span className="ml-1 opacity-70">({count})</span>}
            </Button>
          );
        })}
      </div>

      {/* Mobile status dropdown — shown only on mobile */}
      <div className="flex sm:hidden">
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            onFilterStateChange({ ...filterState, statusFilter: value as StatusFilter })
          }
        >
          <SelectTrigger
            className="h-8 min-h-[44px] w-36 text-xs sm:min-h-0"
            aria-label="Filter by status"
          >
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Namespace dropdown — only shown when >1 namespace */}
      {namespaces.length > 1 && (
        <Select
          value={namespaceFilter}
          onValueChange={(ns) => onFilterStateChange({ ...filterState, namespaceFilter: ns })}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All namespaces" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All namespaces</SelectItem>
            {namespaces.map((ns) => (
              <SelectItem key={ns} value={ns}>
                {ns}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Result count */}
      <span className="text-muted-foreground text-xs">{filteredCount} agents</span>
    </div>
  );
}
