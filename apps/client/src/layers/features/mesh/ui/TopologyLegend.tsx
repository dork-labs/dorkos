import { Panel } from '@xyflow/react';
import { Zap, Clock } from 'lucide-react';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';

interface NamespaceEntry {
  namespace: string;
  color: string;
}

interface TopologyLegendProps {
  namespaces: NamespaceEntry[];
}

/** Graph legend showing edge types, health statuses, indicators, and namespace colors. Positioned at bottom-left of the React Flow canvas. */
export function TopologyLegend({ namespaces }: TopologyLegendProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

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

        {/* Health statuses */}
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-6 items-center justify-center">
            {!prefersReducedMotion && (
              <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-green-500/40" />
            )}
            <span className="relative h-2 w-2 rounded-full bg-green-500" />
          </span>
          <span>Active</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-6 items-center justify-center">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
          </span>
          <span>Inactive</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-6 items-center justify-center">
            <span className="bg-muted-foreground/50 h-2 w-2 rounded-full" />
          </span>
          <span>Stale</span>
        </div>

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
          <span>Pulse schedules</span>
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
