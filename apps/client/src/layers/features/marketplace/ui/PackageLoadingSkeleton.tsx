import { Skeleton } from '@/layers/shared/ui';

/**
 * Grid of shimmer skeleton cards displayed while marketplace packages are loading.
 *
 * The card structure mirrors `PackageCard` dimensions so the layout does not
 * jump when real data arrives.
 *
 * @param count - Number of skeleton cards to render. Defaults to 8.
 */
export function PackageLoadingSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
      aria-busy="true"
      aria-label="Loading packages"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-card rounded-xl border p-6">
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
        </div>
      ))}
    </div>
  );
}
