import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/layers/shared/ui/dialog';
import { useDeliveryMetrics, useAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { DeliveryMetricsDashboard } from './DeliveryMetrics';

interface RelayHealthBarProps {
  /** When false, the bar is suppressed regardless of relay state. Defaults to true. */
  enabled?: boolean;
  /** Called when the failure count indicator is clicked. */
  onFailedClick?: () => void;
}

/** Format a latency value to a display string. */
function fmtLatency(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1 ? '<1ms' : `${Math.round(ms)}ms`;
}

/** Derive connected/total adapter counts from the catalog. */
function useAdapterConnectivity(enabled: boolean) {
  const { data: catalog = [], isLoading } = useAdapterCatalog(enabled);

  const instances = catalog.flatMap((entry) => entry.instances);
  const total = instances.length;
  const connected = instances.filter((inst) => inst.status.state === 'connected').length;

  return { total, connected, isLoading };
}

/**
 * Compact health summary bar for the Relay panel.
 *
 * Shows adapter connectivity, message throughput, failure count, and average latency.
 * Includes a BarChart3 icon button that opens a Dialog with the full DeliveryMetricsDashboard.
 *
 * Renders null when relay is disabled, the `enabled` prop is false, or data is loading.
 */
export function RelayHealthBar({ enabled = true, onFailedClick }: RelayHealthBarProps) {
  const relayEnabled = useRelayEnabled();
  const [metricsOpen, setMetricsOpen] = useState(false);

  const { data: metrics, isLoading: metricsLoading } = useDeliveryMetrics();
  const { total, connected, isLoading: catalogLoading } = useAdapterConnectivity(
    enabled && relayEnabled,
  );

  if (!relayEnabled || !enabled || metricsLoading || catalogLoading || !metrics) return null;

  const hasFailures = metrics.failedCount > 0;
  const allConnected = total > 0 && connected === total;
  const connectivityDotClass = allConnected ? 'bg-green-500' : 'bg-amber-500';

  return (
    <div className="flex items-center gap-3 border-b px-3 py-1.5 text-xs text-muted-foreground">
      {/* Adapter connectivity */}
      <span className="flex items-center gap-1">
        <span className={`h-2 w-2 rounded-full ${connectivityDotClass}`} aria-hidden="true" />
        {connected}/{total} connected
      </span>

      {/* Message throughput */}
      <span>{metrics.totalMessages} today</span>

      {/* Failure count — clickable when failures exist */}
      {hasFailures ? (
        <button
          type="button"
          onClick={onFailedClick}
          className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          aria-label={`${metrics.failedCount} failed messages — click to view`}
        >
          {metrics.failedCount} failed
        </button>
      ) : (
        <span>{metrics.failedCount} failed</span>
      )}

      {/* Average latency */}
      <span>{fmtLatency(metrics.avgDeliveryLatencyMs)} avg</span>

      {/* Metrics dashboard trigger */}
      <Dialog open={metricsOpen} onOpenChange={setMetricsOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto size-6 p-0"
            aria-label="Open delivery metrics"
          >
            <BarChart3 className="size-3.5" />
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Delivery Metrics</DialogTitle>
          </DialogHeader>
          <DeliveryMetricsDashboard />
        </DialogContent>
      </Dialog>
    </div>
  );
}
