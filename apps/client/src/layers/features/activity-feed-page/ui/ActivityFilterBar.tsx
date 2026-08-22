import { useRef } from 'react';
import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useScrollOverflow } from '@/layers/shared/model';
import { CATEGORY_CONFIG } from '@/layers/entities/activity';
import type { ActivityCategory } from '@/layers/entities/activity';
import { useActivityFilters } from '../model/use-activity-filters';

/** All category options in display order. */
const CATEGORIES: ActivityCategory[] = ['tasks', 'relay', 'agent', 'config', 'system'];

interface CategoryChipProps {
  category: ActivityCategory;
  isActive: boolean;
  onToggle: () => void;
}

/** Single toggleable category chip with subtle layout animation on toggle. */
function CategoryChip({ category, isActive, onToggle }: CategoryChipProps) {
  const config = CATEGORY_CONFIG[category];

  return (
    <motion.button
      type="button"
      layout
      onClick={onToggle}
      aria-pressed={isActive}
      transition={{ duration: 0.15 }}
      className={cn(
        'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
        isActive
          ? cn(config.bg, config.text)
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      {config.label}
    </motion.button>
  );
}

interface AllChipProps {
  isActive: boolean;
  onClick: () => void;
}

/** "All" chip — active when no category filter is set, with subtle layout animation. */
function AllChip({ isActive, onClick }: AllChipProps) {
  return (
    <motion.button
      type="button"
      layout
      onClick={onClick}
      aria-pressed={isActive}
      transition={{ duration: 0.15 }}
      className={cn(
        'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium transition-colors',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
        isActive
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
    >
      All
    </motion.button>
  );
}

export interface ActivityFilterBarProps {
  className?: string;
}

/**
 * Horizontal chip bar for the activity feed page.
 *
 * Renders an "All" chip plus one chip per category. Multiple categories
 * can be active simultaneously. Filter state is stored in URL search params
 * via useActivityFilters so filtered views are shareable.
 *
 * Shows a "Clear filters" button when any filter is active.
 */
export function ActivityFilterBar({ className }: ActivityFilterBarProps) {
  const { filters, isFiltered, toggleCategory, clearAll } = useActivityFilters();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const edges = useScrollOverflow(scrollerRef, 'horizontal');

  /** Active category set derived from the comma-separated URL param. */
  const activeCategories = new Set<ActivityCategory>(
    filters.categories ? (filters.categories.split(',') as ActivityCategory[]) : []
  );

  const handleAllClick = () => {
    if (isFiltered) clearAll();
  };

  return (
    // **The row scrolls itself, or it pushes the page sideways.** Six chips plus
    // a Clear button want 383px; a phone gives the content column 358px, and
    // with nowhere to go the overflow escaped the page scroller instead
    // (documentElement 399 wide in a 390 viewport), so every surface below
    // drifted under the reader's thumb. It scrolls the way the bar's tab strip
    // scrolls, and it wears the same cue for the same reason: macOS draws no
    // scrollbar until you have already scrolled, so an edge with chips behind it
    // has to say so — and an edge with nothing behind it must not (ADR
    // 260725-004456).
    <div className={cn('relative', className)}>
      <div
        ref={scrollerRef}
        onScroll={edges.onScroll}
        data-slot="activity-filter-bar"
        className="flex items-center gap-1 overflow-x-auto"
      >
        <AllChip isActive={!isFiltered} onClick={handleAllClick} />

        {CATEGORIES.map((category) => (
          <CategoryChip
            key={category}
            category={category}
            isActive={activeCategories.has(category)}
            onToggle={() => toggleCategory(category)}
          />
        ))}

        <AnimatePresence>
          {isFiltered && (
            <motion.div
              key="clear-filters"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }}
            >
              <Button variant="ghost" size="xs" className="ml-1" onClick={clearAll}>
                <X aria-hidden />
                Clear
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Decorative and never in the way of the chip underneath. */}
      {edges.start && (
        <div
          aria-hidden
          data-testid="activity-filter-bar-fade-start"
          className="from-background via-background/70 pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r to-transparent"
        />
      )}
      {edges.end && (
        <div
          aria-hidden
          data-testid="activity-filter-bar-fade-end"
          className="from-background via-background/70 pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent"
        />
      )}
    </div>
  );
}
