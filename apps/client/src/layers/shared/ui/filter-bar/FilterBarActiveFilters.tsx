import { useState } from 'react';
import { FilterIcon, XIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import {
  isEnumFilter,
  type DateRangeFilterValue,
  type NumericRangeFilterValue,
} from '@/layers/shared/lib/filter-engine';
import { useIsMobile } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/layers/shared/ui/sheet';
import { useFilterBar } from './FilterBarContext';

/**
 * Invisible reach that grows this 28px pill to a 44px touch target.
 *
 * No `md:after:hidden` — this trigger only renders in the `isMobile` branch
 * below, so there is no desktop pointer case to disable it for. Vertical
 * reach (`-inset-y-2`, 8px each side) lands exactly on 28+16=44px; horizontal
 * reach (`-inset-x-1`, 4px each side) stays inside half of the toolbar's
 * `gap-2` (8px), matching the other filter-bar pills.
 */
const TOUCH_REACH = 'relative after:absolute after:-inset-x-1 after:-inset-y-2';

interface FilterBarActiveFiltersProps {
  className?: string;
}

/** Renders active filter chips on desktop, or a badge + sheet on mobile. */
function FilterBarActiveFilters({ className }: FilterBarActiveFiltersProps) {
  const { schema, values, activeCount, isFiltered, clear, clearAll } = useFilterBar();
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!isFiltered) return null;

  // Build active filter entries
  const activeEntries = Object.entries(schema.definitions)
    .filter(([name, def]) => {
      const value = (values as Record<string, unknown>)[name];
      return def.isActive(value);
    })
    .map(([name, def]) => {
      const value = (values as Record<string, unknown>)[name];
      const label = def.label ?? name;
      let displayValue: string;

      if (def.type === 'text') {
        displayValue = String(value);
      } else if (isEnumFilter(def) && def.labels) {
        const resolveLabel = (v: string) => def.labels?.[v] ?? v;
        displayValue = Array.isArray(value)
          ? (value as string[]).map(resolveLabel).join(', ')
          : resolveLabel(value as string);
      } else if (def.type === 'dateRange') {
        const dr = value as DateRangeFilterValue;
        if (dr.preset) displayValue = `Past ${dr.preset}`;
        else if (dr.after && dr.before) displayValue = `${dr.after} – ${dr.before}`;
        else if (dr.after) displayValue = `After ${dr.after}`;
        else if (dr.before) displayValue = `Before ${dr.before}`;
        else displayValue = String(value);
      } else if (def.type === 'numericRange') {
        const nr = value as NumericRangeFilterValue;
        if (nr.min !== undefined && nr.max !== undefined) displayValue = `${nr.min}–${nr.max}`;
        else if (nr.min !== undefined) displayValue = `≥ ${nr.min}`;
        else if (nr.max !== undefined) displayValue = `≤ ${nr.max}`;
        else displayValue = String(value);
      } else if (def.type === 'boolean') {
        displayValue = value === true ? 'Yes' : 'No';
      } else if (Array.isArray(value)) {
        displayValue = (value as unknown[]).join(', ');
      } else {
        displayValue = String(value);
      }

      return { name, label, displayValue };
    });

  // ── Mobile: badge button + sheet ────────────────────────────
  if (isMobile) {
    return (
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetTrigger
          data-slot="filter-bar-active-filters"
          className={cn(
            'border-primary/50 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs',
            TOUCH_REACH,
            className
          )}
        >
          <FilterIcon className="size-3" />
          {activeCount}
        </SheetTrigger>
        <SheetContent side="bottom">
          <SheetHeader>
            <SheetTitle>Active filters</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-2 p-4">
            {activeEntries.map(({ name, label, displayValue }) => (
              <div key={name} className="flex items-center justify-between text-sm">
                <span>
                  {label}: {displayValue}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => clear(name)}
                  aria-label={`Remove ${label} filter`}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="xs"
              className="mt-2 self-start"
              onClick={() => {
                clearAll();
                setSheetOpen(false);
              }}
            >
              Clear all
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  // ── Desktop: inline chips ───────────────────────────────────
  return (
    <div
      data-slot="filter-bar-active-filters"
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {activeEntries.map(({ name, label, displayValue }) => (
        <span
          key={name}
          className="border-muted bg-muted/50 inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs"
        >
          {label}: {displayValue}
          <button
            type="button"
            onClick={() => clear(name)}
            className="hover:text-foreground text-muted-foreground -mr-0.5 rounded-full p-0.5"
            aria-label={`Remove ${label} filter`}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

export { FilterBarActiveFilters };
