import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input, Label, Tabs, TabsList, TabsTrigger } from '@/layers/shared/ui';
import type { MarketplaceTypeFilter } from '../model/marketplace-search';
import { useMarketplaceParams } from '../model/use-marketplace-params';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay (ms) before the local search value is committed to the store. */
const SEARCH_DEBOUNCE_MS = 300;

const TYPE_TABS: ReadonlyArray<{ value: MarketplaceTypeFilter; label: string }> = [
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
 * Top section of the Marketplace browse page.
 *
 * Renders a debounced search input and a type-filter tab row. The `/` key
 * focuses the search input when no other input is focused.
 */
export function MarketplaceHeader() {
  const { search: committedSearch, type: activeType, setSearch, setType } = useMarketplaceParams();
  const inputRef = useRef<HTMLInputElement>(null);

  const [localSearch, setLocalSearch] = useState(committedSearch);

  // Debounce the local input before committing it to the URL.
  useEffect(() => {
    if (localSearch === committedSearch) return;
    const timer = setTimeout(() => setSearch(localSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localSearch, committedSearch, setSearch]);

  // Resync the input when the committed search changes externally (e.g. reset filters).
  useEffect(() => {
    setLocalSearch(committedSearch);
  }, [committedSearch]);

  // "/" keyboard shortcut to focus search (standard marketplace convention).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (el?.isContentEditable) return;
    e.preventDefault();
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <header className="space-y-3">
      {/* Search row */}
      <div className="group/search relative">
        <Label htmlFor="marketplace-search" className="sr-only">
          Search packages
        </Label>
        <Search
          className="text-muted-foreground group-focus-within/search:text-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 transition-colors duration-200"
          aria-hidden
        />
        <Input
          ref={inputRef}
          id="marketplace-search"
          data-testid="marketplace-search"
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          placeholder="Search packages…"
          className="pr-10 pl-9 transition-shadow duration-200 focus:shadow-md"
        />
        {/* Keyboard shortcut hint */}
        <kbd className="text-muted-foreground/60 pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-current/20 px-1.5 py-0.5 font-mono text-[10px] leading-none group-focus-within/search:opacity-0">
          /
        </kbd>
      </div>

      {/* Type filter tabs */}
      <Tabs
        value={activeType}
        onValueChange={(v) => setType(v as MarketplaceTypeFilter)}
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
