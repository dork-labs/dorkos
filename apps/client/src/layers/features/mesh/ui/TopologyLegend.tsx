import { Panel } from '@xyflow/react';

interface NamespaceEntry {
  namespace: string;
  color: string;
}

interface TopologyLegendProps {
  namespaces: NamespaceEntry[];
}

/** Graph legend showing edge types and namespace colors. Positioned at bottom-left of the React Flow canvas. */
export function TopologyLegend({ namespaces }: TopologyLegendProps) {
  return (
    <Panel position="bottom-left">
      <div className="flex flex-col gap-1.5 rounded-md border bg-card/90 px-3 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <svg width="24" height="2">
            <line x1="0" y1="1" x2="24" y2="1" stroke="currentColor" strokeWidth="1" />
          </svg>
          <span>Same namespace</span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="24" height="2">
            <line
              x1="0"
              y1="1"
              x2="24"
              y2="1"
              stroke="#3b82f6"
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          </svg>
          <span>Cross-namespace</span>
        </div>
        {namespaces.length > 1 &&
          namespaces.map((ns) => (
            <div key={ns.namespace} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: ns.color }}
              />
              <span>{ns.namespace}</span>
            </div>
          ))}
      </div>
    </Panel>
  );
}
