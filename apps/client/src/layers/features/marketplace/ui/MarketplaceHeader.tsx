import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  MARKETPLACE_CATEGORIES,
} from '@dorkos/marketplace';
import { Input, Label, Tabs, TabsList, TabsTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
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
  { value: 'shape', label: 'Shapes' },
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MarketplaceHeaderProps {
  /**
   * Category slugs that at least one currently-loaded package belongs to.
   * Only these get a facet chip, so the row never shows a dead filter that
   * would return zero results. Omitted (or empty) renders no chip row — e.g.
   * while the catalog is still loading or every package is uncategorized.
   */
  presentCategories?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Top section of the Marketplace browse page.
 *
 * Renders a debounced search input and two clearly-labelled filter axes — a
 * "Type" segmented-pill row and a "Category" facet-chip row. Each row carries a
 * small muted label so a first-time user can tell the two `All`-first rows apart
 * at a glance (the label is the disambiguator; the type row keeps its existing
 * look). The category row is present-only: chips render for `presentCategories`
 * in the canonical vocabulary order, and the active chip carries an `✕` that
 * clears the filter — there is no redundant "All" chip.
 *
 * The search input owns its own transient keystroke state (see
 * {@link MarketplaceSearchInput}), so typing never re-renders the type tabs or
 * the category chips.
 *
 * @param presentCategories - Category slugs with at least one package present;
 *   controls which facet chips render (present-only, no dead facets).
 */
export function MarketplaceHeader({ presentCategories }: MarketplaceHeaderProps = {}) {
  const {
    type: activeType,
    category: activeCategory,
    setType,
    setCategory,
  } = useMarketplaceParams();

  // Canonical-ordered subset of the vocabulary that actually has packages.
  // Runs only when the header itself re-renders (a committed param change), not
  // per keystroke — search state is isolated in MarketplaceSearchInput.
  const visibleCategories = MARKETPLACE_CATEGORIES.filter((slug) => presentCategories?.has(slug));

  return (
    <header className="space-y-3">
      <MarketplaceSearchInput />

      {/* Type filter — segmented pills, keeps its established look */}
      <FacetRow label="Type">
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
      </FacetRow>

      {/* Category facet chips — only rendered for categories that have packages */}
      {visibleCategories.length > 0 && (
        <FacetRow label="Category">
          <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-1">
            {visibleCategories.map((slug) => (
              <CategoryChip
                key={slug}
                active={activeCategory === slug}
                title={CATEGORY_DESCRIPTIONS[slug]}
                // Re-clicking the active chip clears the filter (toggle off).
                onClick={() => setCategory(activeCategory === slug ? null : slug)}
              >
                {CATEGORY_LABELS[slug]}
              </CategoryChip>
            ))}
          </div>
        </FacetRow>
      )}
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
 * short debounce, so rapid typing re-renders only this field — never the type
 * tabs or category chips that sit beside it. Also wires the `/` shortcut that
 * focuses the input when no other field is focused.
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

// ---------------------------------------------------------------------------
// Facet row
// ---------------------------------------------------------------------------

interface FacetRowProps {
  /** Short muted label naming the filter axis (e.g. "Type", "Category"). */
  label: string;
  /** The filter control for this axis (tab row or chip group). */
  children: ReactNode;
}

/**
 * One labelled filter axis: a small muted uppercase label beside its control.
 *
 * On narrow viewports the label stacks above the control; from `sm` up it
 * becomes a fixed-width leading column so the Type and Category controls align
 * into a tidy control-panel grid. The label is a sighted-user affordance — the
 * control keeps its own `aria-label` for assistive tech.
 *
 * @param label - Short axis name shown in the leading column.
 * @param children - The control rendered beside the label.
 */
function FacetRow({ label, children }: FacetRowProps) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wider uppercase sm:w-16 sm:pt-2">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category chip
// ---------------------------------------------------------------------------

interface CategoryChipProps {
  /** Whether this chip's category is the active filter. */
  active: boolean;
  /** Toggle handler — sets or clears `?category=`. */
  onClick: () => void;
  /** Tooltip text (the category's one-line description). */
  title?: string;
  /** Chip label. */
  children: ReactNode;
}

/**
 * A single category facet chip. A real `<button>` with `aria-pressed` so it is
 * keyboard-operable and announced as a toggle. Inactive chips carry a `bg-muted`
 * pill fill, which distinguishes the row from the type filter's transparent
 * segmented pills; the active chip fills with `bg-primary` and shows an `✕` to
 * signal that clicking it again clears the filter (the removable-tag idiom).
 *
 * @param active - Whether this chip is the active category filter.
 * @param onClick - Toggle handler.
 * @param title - Tooltip text.
 * @param children - Chip label.
 */
function CategoryChip({ active, onClick, title, children }: CategoryChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        active
          ? 'bg-primary text-primary-foreground pr-2'
          : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      {children}
      {active && <X className="size-3" aria-hidden />}
    </button>
  );
}
