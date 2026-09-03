import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
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
import { useRenderSlot } from '@/layers/shared/lib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay (ms) before the local search value is committed to the store. */
const SEARCH_DEBOUNCE_MS = 300;

/** Sort options offered by the menu. */
const SORT_OPTIONS: ReadonlyArray<{ value: MarketplaceSort; label: string }> = [
  { value: 'featured', label: 'Featured' },
  { value: 'name', label: 'A–Z' },
  { value: 'popular', label: 'Popular' },
  { value: 'recent', label: 'Recent' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Query controls for the Marketplace browse page: a debounced search field and
 * the sort selector.
 *
 * The filter facets (package type and category) now live in the sidebar
 * takeover panel, so this stays a slim "search + sort" toolbar — the two
 * controls that shape *how* results are found and ordered, separated from the
 * *what-to-filter* facets. Both write to the URL via `useMarketplaceParams`, so
 * the state survives refresh and is shareable as a link.
 */
export function MarketplaceToolbar() {
  const { sort, setSort } = useMarketplaceParams();
  const { data: packages } = useMarketplacePackages();

  // Popular and Recent are backed by data enriched server-side (community
  // install counts and registry-derived update dates). When dorkos.ai is
  // unreachable (offline-first: the marketplace still works) no package carries
  // that field, so the option grays out rather than silently no-op'ing. One
  // package carrying the field is enough to know the data is available.
  const popularAvailable = useMemo(
    () => (packages ?? []).some((pkg) => pkg.installCount !== undefined),
    [packages]
  );
  const recentAvailable = useMemo(
    () => (packages ?? []).some((pkg) => pkg.updatedAt !== undefined),
    [packages]
  );

  // A data-backed sort with no data behind it is grayed out. Featured and A–Z
  // are always available.
  const isSortDisabled = (value: MarketplaceSort): boolean => {
    if (value === 'popular') return !popularAvailable;
    if (value === 'recent') return !recentAvailable;
    return false;
  };

  return (
    <header className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <MarketplaceSearchInput />
      </div>
      <Select value={sort} onValueChange={(v) => setSort(v as MarketplaceSort)}>
        {/* Narrower on a phone, where the row is 358px wide and the search
            field beside it has one job. Measured at 390px: with `w-32` the
            placeholder still clipped after the keyboard hint went away, and
            with `w-24` "Featured" clipped instead. 7rem is the width where
            both are whole — the placeholder needs 181px and gets 184
            (DOR-1747). */}
        <SelectTrigger aria-label="Sort packages" className="w-28 shrink-0 text-xs sm:w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem
              key={opt.value}
              value={opt.value}
              disabled={isSortDisabled(opt.value)}
              className="text-xs"
            >
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
  // A number that moves once per committed search, whatever the search says.
  // Stamping typed text against THIS rather than against the committed string is
  // what lets an external change win: "Reset filters" puts the committed search
  // back to '', the value it had when the typing started, and the string alone
  // cannot tell that new commit from the one the typing was stamped over — so
  // the field refilled itself and the debounce re-committed the query it had
  // just been asked to drop.
  const commit = useRenderSlot({ value: committedSearch, generation: 0 });
  if (commit.read().value !== committedSearch) {
    commit.write({ value: committedSearch, generation: commit.read().generation + 1 });
  }
  const commitGeneration = commit.read().generation;

  // What has been typed but not yet committed. A committed search that changes
  // elsewhere (reset filters, a link) therefore wins on its own, without an
  // effect writing the field back.
  const [typed, setTyped] = useState<{ generation: number; value: string } | null>(null);
  const localSearch =
    typed !== null && typed.generation === commitGeneration ? typed.value : committedSearch;
  const setLocalSearch = (value: string) => setTyped({ generation: commitGeneration, value });

  // Debounce the local input before committing it to the URL.
  useEffect(() => {
    if (localSearch === committedSearch) return;
    const timer = setTimeout(() => setSearch(localSearch), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [localSearch, committedSearch, setSearch]);

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
        className="pl-9 transition-shadow duration-200 focus:shadow-md max-sm:pr-3 sm:pr-10"
      />
      {/* The keyboard hint, and only where a keyboard is. A phone cannot press
          "/", so on one this badge charged the row for a shortcut nobody could
          use — and the placeholder it crowded out clipped to "Search packag"
          (DOR-1747). Gone below `sm`, along with the padding held for it. */}
      <kbd className="text-muted-foreground/60 text-3xs pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-current/20 px-1.5 py-0.5 font-mono leading-none group-focus-within/search:opacity-0 sm:block">
        /
      </kbd>
    </div>
  );
}
