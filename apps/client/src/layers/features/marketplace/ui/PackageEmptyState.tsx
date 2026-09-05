import { PackageSearch } from 'lucide-react';
import { EmptyState } from '@/layers/shared/ui';

interface PackageEmptyStateProps {
  /**
   * Escape-hatch handler shown as a button. Omit to hide the button (e.g.,
   * when the store has no active filters and there are simply no packages
   * available at all). The label defaults to "Reset filters" — override it
   * via {@link PackageEmptyStateProps.resetLabel} for a scoped action like
   * clearing a single category.
   */
  onResetFilters?: () => void;
  /** Label for the escape-hatch button (default: "Reset filters"). */
  resetLabel?: string;
  /** Override the default heading. */
  title?: string;
  /** Override the default supporting text. */
  description?: string;
}

/**
 * Empty state displayed when the active filter combination returns zero packages.
 *
 * The marketplace's copy over the shared `EmptyState` shell — the dashed border
 * says "this grid could have things in it", the words say which filter emptied
 * it.
 *
 * Distinguishes a filter-induced empty state (provides an escape-hatch action)
 * from a true empty catalog (no action button). Pass `onResetFilters` when
 * filters are active so the user has a clear escape hatch; use `resetLabel` to
 * scope the action (e.g. "Clear category" when only a category filter is set).
 *
 * @param onResetFilters - Escape-hatch handler shown as a button.
 * @param resetLabel - Button label (default "Reset filters").
 * @param title - Heading text.
 * @param description - Supporting body text.
 */
export function PackageEmptyState({
  onResetFilters,
  resetLabel = 'Reset filters',
  title = 'No packages match your filters',
  description = 'Try adjusting your search or category filters.',
}: PackageEmptyStateProps) {
  return (
    <EmptyState
      className="rounded-xl border border-dashed"
      icon={PackageSearch}
      headline={title}
      description={description}
      action={
        onResetFilters
          ? { label: resetLabel, onClick: onResetFilters, variant: 'outline' }
          : undefined
      }
    />
  );
}
