/* ---------------------------------------------------------------------------
 * Namespace group node — color-coded container that groups agent nodes.
 *
 * Mirrors the real NamespaceGroupNode React Flow custom node for use in
 * the dev playground topology showcases.
 * --------------------------------------------------------------------------- */

/** Four-color palette cycling across namespaces in the topology graph. */
export const NAMESPACE_PALETTE = ['#6366f1', '#f59e0b', '#10b981', '#ec4899'] as const;

export type NamespacePaletteColor = (typeof NAMESPACE_PALETTE)[number];

/* ---------------------------------------------------------------------------
 * Component
 * --------------------------------------------------------------------------- */

interface NamespaceGroupDemoProps {
  namespace: string;
  agentCount: number;
  activeCount: number;
  color: string;
}

/** Visual replica of the NamespaceGroupNode with a color-coded header bar. */
export function NamespaceGroupDemo({
  namespace,
  agentCount,
  activeCount,
  color,
}: NamespaceGroupDemoProps) {
  return (
    <div
      className="bg-card/50 w-[260px] rounded-xl border-2"
      style={{
        borderColor: `${color}40`,
        backgroundColor: `${color}08`,
        minHeight: 80,
      }}
    >
      <div
        className="flex items-center gap-2 rounded-t-[10px] px-3 py-1.5"
        style={{ backgroundColor: `${color}15` }}
      >
        <span className="text-xs font-semibold" style={{ color }}>
          {namespace}
        </span>
        <span className="text-muted-foreground text-3xs">
          {activeCount}/{agentCount} agents
        </span>
        {activeCount > 0 && (
          <span
            className="animate-breath h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
      </div>
      <div className="px-3 py-3">
        <span className="text-muted-foreground text-xs italic">Agent nodes render here</span>
      </div>
    </div>
  );
}
