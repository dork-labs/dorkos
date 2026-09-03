import { cn } from '@/layers/shared/lib/utils';
import { Button } from '@/layers/shared/ui/button';
import { useFilterBar } from './FilterBarContext';

interface FilterBarResultCountProps {
  /** Number of items currently displayed. */
  count: number;
  /** Total number of items before filtering. */
  total: number;
  /** Singular noun for the item type (auto-pluralized). */
  noun: string;
  className?: string;
}

/** Displays result count with optional "Clear all" when filters are active. */
function FilterBarResultCount({ count, total, noun, className }: FilterBarResultCountProps) {
  const { clearAll } = useFilterBar();
  const plural = count === 1 ? noun : `${noun}s`;

  return (
    <div
      data-slot="filter-bar-result-count"
      className={cn('text-muted-foreground ml-auto flex items-center gap-2 text-xs', className)}
    >
      <span>{count === total ? `${count} ${plural}` : `${count} of ${total} ${plural}`}</span>
      {count < total && (
        <Button variant="ghost" size="xs" onClick={clearAll}>
          Clear all
        </Button>
      )}
    </div>
  );
}

export { FilterBarResultCount };
