import type { ReactNode } from 'react';
import type { UseFilterStateReturn } from '@/layers/shared/model';
import type { FilterDefinition } from '@/layers/shared/lib/filter-engine';
import { cn } from '@/layers/shared/lib/utils';
import { FilterBarContext } from './FilterBarContext';

export interface FilterBarProps {
  /** Filter state from useFilterState hook. */
  state: UseFilterStateReturn<Record<string, FilterDefinition<unknown, unknown>>>;
  children: ReactNode;
  className?: string;
}

/** Container component that provides filter state context to sub-components. */
function FilterBarRoot({ state, children, className }: FilterBarProps) {
  return (
    <FilterBarContext.Provider value={state}>
      <div
        data-slot="filter-bar"
        className={cn('flex flex-wrap items-center gap-2 px-4 py-3', className)}
      >
        {children}
      </div>
    </FilterBarContext.Provider>
  );
}

export { FilterBarRoot };
