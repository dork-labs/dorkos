import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronLeft } from 'lucide-react';
import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  MARKETPLACE_CATEGORIES,
  PackageTypeSchema,
} from '@dorkos/marketplace';
import type { MarketplacePackageType } from '@dorkos/shared/marketplace-schemas';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useMarketplaceParams } from '../model/use-marketplace-params';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Humanized, plural type labels — mirror the retired header type tabs. */
const TYPE_LABELS: Record<MarketplacePackageType, string> = {
  agent: 'Agents',
  plugin: 'Plugins',
  'skill-pack': 'Skill Packs',
  adapter: 'Adapters',
  shape: 'Shapes',
};

/**
 * Solid hue swatch per type — the base of the `PackageTypeBadge` hue families
 * (blue / purple / emerald / amber / rose), so the sidebar dot and the card
 * badge speak the same color language.
 */
const TYPE_SWATCH: Record<MarketplacePackageType, string> = {
  agent: 'bg-blue-500',
  plugin: 'bg-purple-500',
  'skill-pack': 'bg-emerald-500',
  adapter: 'bg-amber-500',
  shape: 'bg-rose-500',
};

/** Every package type in taxonomy order — derived so a new type never goes stale. */
const TYPE_VALUES = PackageTypeSchema.options;

/** Present categories beyond this count collapse behind a "Show all" toggle. */
const CATEGORY_COLLAPSE_THRESHOLD = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Marketplace filter panel that takes over the app-shell sidebar body on
 * `/marketplace` routes (registered as a `sidebar.body` contribution).
 *
 * It owns the two filter axes that used to sit in the page header: a
 * single-select package-type facet (All + the five types, each with a live
 * result count and a hue swatch matching its card badge) and a multi-select,
 * OR-combined category facet (the present categories in canonical order, each
 * with a count). Both write the same URL params the browse page reads, so the
 * grid, the Featured rail, and shared links all stay in sync — the panel holds
 * no local filter state of its own. A back affordance returns to the dashboard.
 *
 * Counts are computed client-side from the cached, unfiltered catalog (the same
 * TanStack Query cache the grid uses — no extra fetch), so they report how many
 * packages *exist* for each facet, independent of the other active filters.
 */
export function MarketplaceSidebar() {
  const navigate = useNavigate();
  const { data: packages } = useMarketplacePackages();
  const { type, setType, categories, toggleCategory, clearCategories } = useMarketplaceParams();
  const selectedCategories = useMemo(() => new Set(categories), [categories]);

  // Type counts: mirror the filter's rule that a missing `type` reads as
  // `'plugin'`; `all` is the raw total. A package whose type is outside the
  // taxonomy counts toward `all` only (it matches no specific type facet).
  const typeCounts = useMemo(() => {
    const byType = new Map<MarketplacePackageType, number>();
    let all = 0;
    for (const pkg of packages ?? []) {
      all += 1;
      const effective = (pkg.type ?? 'plugin') as MarketplacePackageType;
      if (TYPE_VALUES.includes(effective)) {
        byType.set(effective, (byType.get(effective) ?? 0) + 1);
      }
    }
    return { all, byType };
  }, [packages]);

  // Category counts: a package that lists a slug in both `categories[]` and the
  // legacy singular `category` is counted once (Set dedupe).
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pkg of packages ?? []) {
      const slugs = new Set<string>();
      for (const slug of pkg.categories ?? []) slugs.add(slug);
      if (pkg.category) slugs.add(pkg.category);
      for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    return counts;
  }, [packages]);

  // Present-only, canonical order — no dead facets that would return nothing.
  const presentCategories = useMemo(
    () => MARKETPLACE_CATEGORIES.filter((slug) => (categoryCounts.get(slug) ?? 0) > 0),
    [categoryCounts]
  );

  const [expanded, setExpanded] = useState(false);
  const collapsible = presentCategories.length > CATEGORY_COLLAPSE_THRESHOLD;
  const shownCategories = useMemo(() => {
    if (!collapsible || expanded) return presentCategories;
    // Keep the first N plus any selected slug from the tail visible, so a
    // collapsed panel never hides an active filter.
    return presentCategories.filter(
      (slug, i) => i < CATEGORY_COLLAPSE_THRESHOLD || selectedCategories.has(slug)
    );
  }, [presentCategories, collapsible, expanded, selectedCategories]);

  return (
    <>
      <SidebarHeader className="gap-2 border-b p-3">
        <button
          type="button"
          onClick={() => void navigate({ to: '/' })}
          className="text-muted-foreground hover:bg-accent hover:text-foreground -ml-1 flex w-fit items-center gap-1 rounded-md py-1 pr-2 pl-1 text-xs font-medium transition-colors"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Dashboard
        </button>
        <h2 className="px-1 text-sm font-semibold">Marketplace</h2>
      </SidebarHeader>

      <SidebarContent className="gap-4 p-3">
        {/* Type — single select */}
        <SidebarGroup className="p-0">
          <SidebarGroupLabel>Type</SidebarGroupLabel>
          <div role="group" aria-label="Filter by type" className="flex flex-col gap-0.5">
            <FacetButton
              label="All"
              count={typeCounts.all}
              active={type === 'all'}
              onClick={() => setType('all')}
            />
            {TYPE_VALUES.map((value) => (
              <FacetButton
                key={value}
                label={TYPE_LABELS[value]}
                swatch={TYPE_SWATCH[value]}
                count={typeCounts.byType.get(value) ?? 0}
                active={type === value}
                onClick={() => setType(value)}
              />
            ))}
          </div>
        </SidebarGroup>

        {/* Category — multi-select, OR-combined */}
        {presentCategories.length > 0 && (
          <SidebarGroup className="p-0">
            <SidebarGroupLabel className="justify-between">
              <span>Category</span>
              {selectedCategories.size > 0 && (
                <button
                  type="button"
                  onClick={clearCategories}
                  className="text-muted-foreground hover:text-foreground text-[10px] font-medium tracking-wide uppercase transition-colors"
                >
                  Clear
                </button>
              )}
            </SidebarGroupLabel>
            <div role="group" aria-label="Filter by category" className="flex flex-col gap-0.5">
              {shownCategories.map((slug) => (
                <FacetButton
                  key={slug}
                  label={CATEGORY_LABELS[slug]}
                  title={CATEGORY_DESCRIPTIONS[slug]}
                  count={categoryCounts.get(slug) ?? 0}
                  active={selectedCategories.has(slug)}
                  multi
                  onClick={() => toggleCategory(slug)}
                />
              ))}
            </div>
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="text-muted-foreground hover:text-foreground mt-1 px-2 text-left text-xs font-medium transition-colors"
              >
                {expanded ? 'Show less' : `Show all ${presentCategories.length}`}
              </button>
            )}
          </SidebarGroup>
        )}
      </SidebarContent>
    </>
  );
}

// ---------------------------------------------------------------------------
// Facet button
// ---------------------------------------------------------------------------

interface FacetButtonProps {
  /** Row label. */
  label: string;
  /** Live result count shown right-aligned. */
  count: number;
  /** Whether this facet is currently selected. */
  active: boolean;
  /** Toggle/select handler. */
  onClick: () => void;
  /** Solid Tailwind bg-class for the leading hue swatch (type facets only). */
  swatch?: string;
  /** Tooltip text (category descriptions). */
  title?: string;
  /** Multi-select semantics — renders a check on the active row. */
  multi?: boolean;
}

/**
 * One facet row: an accessible toggle button with an optional leading hue
 * swatch, a label, and a trailing result count. `aria-pressed` reflects the
 * selected state for both the single-select type rows and the multi-select
 * category rows; the check icon on an active multi-select row signals that a
 * second click removes it.
 */
function FacetButton({ label, count, active, onClick, swatch, title, multi }: FacetButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
      )}
    >
      {/* Leading indicator: a hue swatch for types, a spacer otherwise, so every
          label aligns to the same column. */}
      <span
        className={cn('size-2 shrink-0 rounded-full', swatch ?? 'bg-transparent')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {multi && active && <Check className="size-3.5 shrink-0" aria-hidden />}
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{count}</span>
    </button>
  );
}
