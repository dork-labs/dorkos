import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Button } from '@/layers/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import { useFilterBar } from './FilterBarContext';

interface FilterBarSortProps {
  /** Sort options from createSortOptions — keys map to field names. */
  options: Record<string, { label: string }>;
  /**
   * Field the list sorts by when the URL carries no `sort` param. Naming it
   * lets the trigger read the real default instead of an empty label, and makes
   * the direction toggle act on that field rather than on nothing.
   */
  defaultField?: string;
  /**
   * Applied to the outer wrapper around both controls (the field trigger and
   * the direction toggle as a group) — not to either control individually.
   * For spacing/positioning the pair as a unit, not for styling one button.
   */
  className?: string;
}

/** Dropdown for selecting sort field and toggling direction. */
function FilterBarSort({ options, defaultField, className }: FilterBarSortProps) {
  const { sortField, sortDirection, setSort } = useFilterBar();

  const activeField = sortField || (defaultField ?? '');
  const currentLabel = options[activeField]?.label ?? activeField;
  const DirectionIcon = sortDirection === 'asc' ? ArrowUpIcon : ArrowDownIcon;

  function toggleDirection() {
    setSort(activeField, sortDirection === 'asc' ? 'desc' : 'asc');
  }

  return (
    <div data-slot="filter-bar-sort" className={cn('inline-flex items-center gap-1', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Sort: {currentLabel}
          </Button>
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
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggleDirection}
        aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
      >
        <DirectionIcon className="size-3" />
      </Button>
    </div>
  );
}

export { FilterBarSort };
