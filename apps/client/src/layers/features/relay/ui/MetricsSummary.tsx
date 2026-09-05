import { useDeliveryMetrics } from '@/layers/entities/relay';
import { cn } from '@/layers/shared/lib';

interface MetricsSummaryProps {
  enabled: boolean;
}

/**
 * Inline summary row of key delivery metrics for the Activity tab.
 *
 * Renders five stat pills (Total, Delivered, Failed, No listener, Never
 * arrived) and an average latency indicator. Failed is red when > 0, Never
 * arrived is amber when > 0, Delivered is green when > 0. Returns null when relay is
 * disabled or metrics are not yet loaded.
 *
 * "No listener" is deliberately its own pill and deliberately not red: those
 * messages went to a subject nothing was watching, which is a fact about the
 * setup, not a failure. They used to be counted as failures, which is how a
 * quiet machine could show a wall of red.
 */
export function MetricsSummary({ enabled }: MetricsSummaryProps) {
  const { data: metrics } = useDeliveryMetrics();
  if (!enabled || !metrics) return null;

  const pills = [
    { label: 'Total', value: metrics.totalMessages, variant: 'default' as const },
    { label: 'Delivered', value: metrics.deliveredCount, variant: 'success' as const },
    {
      label: 'Failed',
      value: metrics.failedCount,
      variant: metrics.failedCount > 0 ? 'danger' : 'default',
    },
    { label: 'No listener', value: metrics.noSubscriberCount, variant: 'default' as const },
    {
      label: 'Never arrived',
      value: metrics.deadLetteredCount,
      variant: metrics.deadLetteredCount > 0 ? 'warning' : 'default',
    },
  ];

  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      {pills.map(({ label, value, variant }) => (
        <div key={label} className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span
            className={cn(
              'font-medium tabular-nums',
              variant === 'success' && value > 0 && 'text-green-600 dark:text-green-500',
              variant === 'danger' && 'text-red-600 dark:text-red-500',
              variant === 'warning' && 'text-amber-600 dark:text-amber-500'
            )}
          >
            {value.toLocaleString()}
          </span>
        </div>
      ))}
      {metrics.avgDeliveryLatencyMs != null && (
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Avg</span>
          <span className="font-medium tabular-nums">
            {metrics.avgDeliveryLatencyMs < 1000
              ? `${Math.round(metrics.avgDeliveryLatencyMs)}ms`
              : `${(metrics.avgDeliveryLatencyMs / 1000).toFixed(1)}s`}
          </span>
        </div>
      )}
    </div>
  );
}
