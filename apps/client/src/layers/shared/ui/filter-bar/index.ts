/**
 * FilterBar — compound UI component for composable filter controls.
 *
 * @example
 * ```tsx
 * <FilterBar state={filterState}>
 *   <FilterBar.Search placeholder="Filter agents..." />
 *   <FilterBar.Primary name="status" />
 *   <FilterBar.AddFilter />
 *   <FilterBar.Sort options={sortOptions} />
 *   <FilterBar.ResultCount count={4} total={12} noun="agent" />
 *   <FilterBar.ActiveFilters />
 * </FilterBar>
 * ```
 *
 * @module shared/ui/filter-bar
 */
import { FilterBarRoot } from './FilterBar';
import { FilterBarSearch } from './FilterBarSearch';
import { FilterBarPrimary } from './FilterBarPrimary';
import { FilterBarAddFilter } from './FilterBarAddFilter';
import { FilterBarSort } from './FilterBarSort';
import { FilterBarResultCount } from './FilterBarResultCount';
import { FilterBarActiveFilters } from './FilterBarActiveFilters';

/** Composable filter bar with compound sub-components. */
const FilterBar = Object.assign(FilterBarRoot, {
  Search: FilterBarSearch,
  Primary: FilterBarPrimary,
  AddFilter: FilterBarAddFilter,
  Sort: FilterBarSort,
  ResultCount: FilterBarResultCount,
  ActiveFilters: FilterBarActiveFilters,
});

export { FilterBar };
export type { FilterBarProps } from './FilterBar';
