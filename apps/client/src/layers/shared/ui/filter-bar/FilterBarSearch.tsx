import { SearchIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Input } from '@/layers/shared/ui/input';
import { useFilterBar } from './FilterBarContext';

interface FilterBarSearchProps {
  /** Placeholder text for the search input. */
  placeholder?: string;
  className?: string;
}

/** Search input bound to the filter state's search field. */
function FilterBarSearch({ placeholder = 'Search...', className }: FilterBarSearchProps) {
  const { inputValues, set } = useFilterBar();
  const value = (inputValues as Record<string, unknown>).search as string | undefined;

  return (
    <div data-slot="filter-bar-search" className={cn('relative', className)}>
      <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
      <Input
        placeholder={placeholder}
        value={value ?? ''}
        onChange={(e) => set('search', e.target.value)}
        // `md:h-8` keeps today's desktop density; below `md` the default
        // `h-11` responsive scale (Input's own default) takes over instead
        // of being disabled outright.
        className="pl-8 text-sm sm:max-w-64 md:h-8"
      />
    </div>
  );
}

export { FilterBarSearch };
