import { Card, Skeleton } from '@/layers/shared/ui';
import { PACKAGE_GRID_COLUMNS, PACKAGE_GRID_CONTAINER } from '../lib/package-grid-layout';

/**
 * Grid of shimmer skeleton cards displayed while marketplace packages are loading.
 *
 * The card structure mirrors `PackageCard` dimensions, and the columns come from
 * the same shared rule the real grid uses, so the layout does not jump when real
 * data arrives. It carries its own query container because it renders *instead
 * of* the grid, not inside it.
 *
 * @param count - Number of skeleton cards to render. Defaults to 8.
 */
export function PackageLoadingSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={PACKAGE_GRID_CONTAINER}>
      <div
        data-slot="package-grid"
        className={PACKAGE_GRID_COLUMNS}
        aria-busy="true"
        aria-label="Loading packages"
      >
        {Array.from({ length: count }).map((_, i) => (
          <Card key={i} radius="lg" gap="none" className="p-6">
            {/* Icon row */}
            <div className="mb-3 flex items-start justify-between gap-2">
              <Skeleton className="size-6 rounded-full" />
            </div>
            {/* Name */}
            <Skeleton className="mb-1 h-4 w-3/4" />
            {/* Type badge */}
            <Skeleton className="mb-3 h-3 w-16" />
            {/* Description lines */}
            <Skeleton className="mb-1 h-3 w-full" />
            <Skeleton className="mb-4 h-3 w-2/3" />
            {/* Action row */}
            <div className="flex items-center justify-end">
              <Skeleton className="h-7 w-16" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
