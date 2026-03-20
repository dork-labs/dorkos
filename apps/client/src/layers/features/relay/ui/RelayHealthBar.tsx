import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/layers/shared/ui/tooltip';
import { useDeliveryMetrics, useAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import type { DeliveryMetrics } from '@dorkos/shared/relay-schemas';

interface RelayHealthBarProps {
  /** When false, the bar is suppressed regardless of relay state. Defaults to true. */
  enabled?: boolean;
  /** Called when the failure count indicator is clicked. */
  onFailedClick?: () => void;
}

type HealthState = 'healthy' | 'degraded' | 'critical';

const DOT_COLORS: Record<HealthState, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  critical: 'bg-red-500',
};

/** Format a latency value to a display string. */
function fmtLatency(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1 ? '<1ms' : `${Math.round(ms)}ms`;
}

/**
 * Compute a semantic health state from delivery metrics and adapter connectivity.
 *
 * @param metrics - Live delivery metrics for the last 24 hours
 * @param connected - Number of adapters currently in connected state
 * @param total - Total number of configured adapter instances
 * @returns The health state and a human-readable status message
 *
 * @internal Exported for testing only.
 */
export function computeHealthState(
  metrics: DeliveryMetrics,
  connected: number,
  total: number
): { state: HealthState; message: string } {
  const failureRate =
    metrics.totalMessages > 0
      ? (metrics.failedCount + metrics.deadLetteredCount) / metrics.totalMessages
      : 0;

  if (total === 0) {
    return { state: 'healthy', message: 'No connections configured' };
  }

  if (failureRate > 0.5 || connected === 0) {
    const pct = Math.round(failureRate * 100);
    return {
      state: 'critical',
      message: `${pct}% failure rate \u2014 ${metrics.failedCount} messages failed today`,
    };
  }

  if (connected < total || failureRate >= 0.05) {
    const disconnected = total - connected;
    if (disconnected > 0) {
      return {
        state: 'degraded',
        message: `${disconnected} connection${disconnected > 1 ? 's' : ''} disconnected`,
      };
    }
    return {
      state: 'degraded',
      message: `${metrics.failedCount} failure${metrics.failedCount !== 1 ? 's' : ''} in last 24h`,
    };
  }

  return {
    state: 'healthy',
    message: `${connected} connection${connected > 1 ? 's' : ''} active`,
  };
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
 * Compact semantic health bar for the Relay panel.
 *
 * Shows a colored status dot (green/amber/red) and a plain-language status message.
 * Healthy state includes a tooltip with detailed metrics breakdown.
 * Degraded/critical failure text is clickable to scroll to dead letters.
 *
 * Renders null when relay is disabled, the `enabled` prop is false, or data is loading.
 */
export function RelayHealthBar({ enabled = true, onFailedClick }: RelayHealthBarProps) {
  const relayEnabled = useRelayEnabled();

  const { data: metrics, isLoading: metricsLoading } = useDeliveryMetrics();
  const {
    total,
    connected,
    isLoading: catalogLoading,
  } = useAdapterConnectivity(enabled && relayEnabled);

  if (!relayEnabled || !enabled || metricsLoading || catalogLoading || !metrics) return null;

  const { state, message } = computeHealthState(metrics, connected, total);
  const isClickable = (state === 'degraded' || state === 'critical') && onFailedClick != null;
  const latency = fmtLatency(metrics.avgDeliveryLatencyMs);

  const tooltipContent = `${metrics.totalMessages} messages today \u00b7 ${metrics.failedCount} failed \u00b7 ${latency} avg latency`;

  return (
    <TooltipProvider>
      <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        {/* Semantic status indicator */}
        {state === 'healthy' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 flex-1 cursor-default items-center gap-1.5">
                <span
                  className={`size-2 shrink-0 rounded-full ${DOT_COLORS[state]}`}
                  aria-hidden="true"
                />
                <span className="truncate">{message}</span>
                {metrics.avgDeliveryLatencyMs != null && (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span>{latency}</span>
                  </>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={`size-2 shrink-0 rounded-full ${DOT_COLORS[state]}`}
              aria-hidden="true"
            />
            {isClickable ? (
              <button
                type="button"
                onClick={onFailedClick}
                className="truncate text-left hover:underline"
                aria-label={`${message} — click to view failures`}
              >
                {message}
              </button>
            ) : (
              <span className="truncate">{message}</span>
            )}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}
