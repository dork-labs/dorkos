import { PackageSearch } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

interface PackageEmptyStateProps {
  /**
   * Called when the user clicks "Reset filters". Omit to hide the button
   * (e.g., when the store has no active filters and there are simply no
   * packages available at all).
   */
  onResetFilters?: () => void;
  /** Override the default heading. */
  title?: string;
  /** Override the default supporting text. */
  description?: string;
}

/**
 * Empty state displayed when the active filter combination returns zero packages.
 *
 * Distinguishes a filter-induced empty state (provides "Reset filters" action)
 * from a true empty catalog (no action button). Pass `onResetFilters` when
 * filters are active so the user has a clear escape hatch.
 *
 * @param onResetFilters - Reset handler shown as a "Reset filters" button.
 * @param title - Heading text.
 * @param description - Supporting body text.
 */
export function PackageEmptyState({
  onResetFilters,
  title = 'No packages match your filters',
  description = 'Try adjusting your search or category filters.',
}: PackageEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
      <PackageSearch className="text-muted-foreground mb-4 size-10" aria-hidden />
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      <p className="text-muted-foreground mb-4 max-w-sm text-sm">{description}</p>
      {onResetFilters && (
        <Button variant="outline" onClick={onResetFilters}>
          Reset filters
        </Button>
      )}
    </div>
  );
}
