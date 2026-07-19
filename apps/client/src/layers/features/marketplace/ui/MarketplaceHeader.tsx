import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import type { MarketplaceSort } from '../model/marketplace-search';
import { useMarketplaceParams } from '../model/use-marketplace-params';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay (ms) before the local search value is committed to the store. */
const SEARCH_DEBOUNCE_MS = 300;

// Only sorts backed by real data are offered. `Recent` and `Popular` return
// when AggregatedPackage carries `updatedAt`/`installCount` (tracked in Linear).
const SORT_OPTIONS: ReadonlyArray<{ value: MarketplaceSort; label: string }> = [
  { value: 'featured', label: 'Featured' },
  { value: 'name', label: 'A–Z' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Query controls for the Marketplace browse page: a debounced search field and
 * the sort selector.
 *
 * The filter facets (package type and category) now live in the sidebar
 * takeover panel, so this header stays a slim "search + sort" toolbar — the two
 * controls that shape *how* results are found and ordered, separated from the
 * *what-to-filter* facets. Both write to the URL via `useMarketplaceParams`, so
 * the state survives refresh and is shareable as a link.
 */
export function MarketplaceHeader() {
  const { sort, setSort } = useMarketplaceParams();

  return (
    <header className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <MarketplaceSearchInput />
      </div>
      <Select value={sort} onValueChange={(v) => setSort(v as MarketplaceSort)}>
        <SelectTrigger aria-label="Sort packages" className="w-32 shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="text-xs">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Search input
// ---------------------------------------------------------------------------

/**
 * Debounced marketplace search field.
 *
 * Owns the transient keystroke state locally and commits it to the URL after a
 * short debounce, so rapid typing re-renders only this field. Also wires the
 * `/` shortcut that focuses the input when no other field is focused.
 */
function MarketplaceSearchInput() {
  const { search: committedSearch, setSearch } = useMarketplaceParams();
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
  );
}
