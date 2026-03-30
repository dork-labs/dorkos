import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
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

  /** Active category set derived from the comma-separated URL param. */
  const activeCategories = new Set<ActivityCategory>(
    filters.categories ? (filters.categories.split(',') as ActivityCategory[]) : []
  );

  const handleAllClick = () => {
    if (isFiltered) clearAll();
  };

  return (
    <div data-slot="activity-filter-bar" className={cn('flex items-center gap-1', className)}>
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
  );
}
