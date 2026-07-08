import { Skeleton } from '@/layers/shared/ui';

/**
 * D3 loading state: shown while a `dorkos-ui` fence is still streaming
 * (unclosed). v1 renders the widget only once its fence completes, so this
 * lightweight placeholder stands in until then.
 */
export function WidgetSkeleton() {
  return (
    <div
      className="bg-card flex flex-col gap-3 rounded-lg border p-4"
      aria-busy="true"
      aria-label="Loading widget"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
