import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import { useFilterBar } from './FilterBarContext';

/**
 * Invisible reach that grows this 28px pill to a 44px touch target below `md`.
 *
 * Vertical reach (`-inset-y-2`, 8px each side) lands exactly on 28+16=44px.
 * Horizontal reach (`-inset-x-1`, 4px each side) stays inside half of the
 * toolbar's `gap-2` (8px) so neighbouring pills' reach zones meet without
 * overlapping — the same anisotropic budget `PresenceStrip` uses for its row
 * of chips.
 */
const TOUCH_REACH = 'relative after:absolute after:-inset-x-1 after:-inset-y-2 md:after:hidden';

interface FilterBarSortProps {
  /** Sort options from createSortOptions — keys map to field names. */
  options: Record<string, { label: string }>;
  /**
   * Field the list sorts by when the URL carries no `sort` param. Naming it
   * lets the trigger read the real default instead of an empty label, and makes
   * the direction toggle act on that field rather than on nothing.
   */
  defaultField?: string;
  className?: string;
}

/** Dropdown for selecting sort field and toggling direction. */
function FilterBarSort({ options, defaultField, className }: FilterBarSortProps) {
  const { sortField, sortDirection, setSort } = useFilterBar();

  const activeField = sortField || (defaultField ?? '');
  const currentLabel = options[activeField]?.label ?? activeField;
  const DirectionIcon = sortDirection === 'asc' ? ArrowUpIcon : ArrowDownIcon;

  function toggleDirection(e: React.MouseEvent) {
    e.stopPropagation();
    setSort(activeField, sortDirection === 'asc' ? 'desc' : 'asc');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="filter-bar-sort"
        className={cn(
          'border-input hover:bg-accent hover:text-accent-foreground inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs',
          TOUCH_REACH,
          className
        )}
      >
        Sort: {currentLabel}
        <span
          role="button"
          tabIndex={-1}
          onClick={toggleDirection}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleDirection(e as unknown as React.MouseEvent);
            }
          }}
          className="hover:bg-muted -mr-1 rounded p-0.5"
          aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
        >
          <DirectionIcon className="size-3" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {Object.entries(options).map(([key, opt]) => (
          <DropdownMenuItem
            key={key}
            onClick={() => setSort(key, sortDirection)}
            className={cn(key === activeField && 'bg-accent font-medium')}
          >
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { FilterBarSort };
