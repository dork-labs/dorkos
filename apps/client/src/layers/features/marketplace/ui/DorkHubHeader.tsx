import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Input, Label, Tabs, TabsList, TabsTrigger } from '@/layers/shared/ui';
import { useDorkHubStore, type DorkHubTypeFilter } from '../model/dork-hub-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay (ms) before the local search value is committed to the store. */
const SEARCH_DEBOUNCE_MS = 300;

const TYPE_TABS: ReadonlyArray<{ value: DorkHubTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'agent', label: 'Agents' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'skill-pack', label: 'Skill Packs' },
  { value: 'adapter', label: 'Adapters' },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Top section of the Dork Hub browse page.
 *
 * Renders a debounced search input and a type-filter tab row. The search
 * value is committed to `dorkHubStore` after a {@link SEARCH_DEBOUNCE_MS}ms
 * idle period to avoid triggering a query on every keystroke. The type filter
 * is applied immediately on tab selection.
 *
 * Accessibility:
 * - Search input has a visually-hidden `<Label>` for screen readers.
 * - Type filter row uses Radix `Tabs` which provides `role="tablist"` and
 *   `aria-selected` semantics automatically.
 */
export function DorkHubHeader() {
  const storeSearch = useDorkHubStore((s) => s.filters.search);
  const activeType = useDorkHubStore((s) => s.filters.type);
  const setSearch = useDorkHubStore((s) => s.setSearch);
  const setTypeFilter = useDorkHubStore((s) => s.setTypeFilter);

  // Local copy of the search string so the input stays responsive while the
  // debounce timer is pending.
  const [localSearch, setLocalSearch] = useState(storeSearch);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(localSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localSearch, setSearch]);

  return (
    <header className="space-y-3">
      {/* Search row */}
      <div className="relative">
        <Label htmlFor="dork-hub-search" className="sr-only">
          Search packages
        </Label>
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          id="dork-hub-search"
          data-testid="dork-hub-search"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          placeholder="Search packages…"
          className="pl-9"
        />
      </div>

      {/* Type filter tabs */}
      <Tabs
        value={activeType}
        onValueChange={(v) => setTypeFilter(v as DorkHubTypeFilter)}
        aria-label="Filter by package type"
      >
        <TabsList className="h-auto flex-wrap gap-1 bg-transparent p-0">
          {TYPE_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-full"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </header>
  );
}
