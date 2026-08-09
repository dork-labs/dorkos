import { Panel } from '@xyflow/react';
import { Zap, Clock } from 'lucide-react';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { cn } from '@/layers/shared/lib';
import { HEALTH_DISPLAY } from '../lib/health-display';

interface NamespaceEntry {
  namespace: string;
  color: string;
}

interface TopologyLegendProps {
  namespaces: NamespaceEntry[];
}

/** The health statuses the legend explains, in the order a reader wants them. */
const LEGEND_HEALTH: readonly AgentHealthStatus[] = ['active', 'inactive', 'stale', 'unreachable'];

/**
 * Graph legend showing edge types, health statuses, indicators, and namespace
 * colors. Positioned at bottom-left of the React Flow canvas.
 *
 * The health swatches are the SAME map the nodes draw from
 * ({@link HEALTH_DISPLAY}), so a legend cannot describe a colour no node wears
 * — which it did: it explained a pulsing green dot for "Active" and offered no
 * entry at all for "Unreachable".
 */
export function TopologyLegend({ namespaces }: TopologyLegendProps) {
  return (
    <Panel position="bottom-left">
      <div className="bg-card/90 text-muted-foreground flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[11px] shadow-sm backdrop-blur-sm">
        {/* Edge types */}
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-6 items-center">
            <svg width="24" height="4" className="overflow-visible">
              <line x1="0" y1="2" x2="24" y2="2" stroke="var(--color-primary)" strokeWidth="1.5" />
              <circle cx="8" cy="2" r="2.5" fill="var(--color-primary)" opacity="0.9" />
            </svg>
          </span>
          <span>Allow rule (data flow)</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="24" height="4" className="overflow-visible">
            <line
              x1="0"
              y1="2"
              x2="24"
              y2="2"
              stroke="var(--color-destructive)"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          </svg>
          <span>Deny rule</span>
        </div>

        {/* Divider */}
        <div className="border-t" />

        {/* Health statuses — still, every one of them. Health is a state, and
            the animated "Active" swatch this used to draw claimed liveness for
            an agent that may not have been heard from in fifty-nine minutes. */}
        {LEGEND_HEALTH.map((status) => (
          <div key={status} className="flex items-center gap-2">
            <span className="flex h-2.5 w-6 items-center justify-center">
              <span className={cn('h-2 w-2 rounded-full', HEALTH_DISPLAY[status].dot)} />
            </span>
            <span>{HEALTH_DISPLAY[status].label}</span>
          </div>
        ))}

        {/* Divider */}
        <div className="border-t" />

        {/* Feature indicators */}
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-6 items-center justify-center">
            <Zap className="h-3 w-3 text-yellow-500" />
          </span>
          <span>Relay-enabled</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-6 items-center justify-center">
            <Clock className="h-3 w-3 text-blue-500" />
          </span>
          <span>Tasks schedules</span>
        </div>

        {/* Namespace colors (only when multiple namespaces) */}
        {namespaces.length > 1 && (
          <>
            <div className="border-t" />
            {namespaces.map((ns) => (
              <div key={ns.namespace} className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: ns.color }}
                />
                <span>{ns.namespace}</span>
              </div>
            ))}
          </>
        )}

        {/* Zoom hint */}
        <div className="border-t" />
        <span className="text-[10px] italic opacity-60">Zoom in for more detail</span>
      </div>
    </Panel>
  );
}
