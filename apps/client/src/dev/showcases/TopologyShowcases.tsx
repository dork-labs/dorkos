import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { cn } from '@/layers/shared/lib';
import { AgentAvatar } from '@/layers/entities/agent';
import { HEALTH_DISPLAY } from '@/layers/features/mesh';
import { TopologyLegend } from '@/layers/features/mesh/ui/TopologyLegend';
import {
  AgentCompactPill,
  AgentDefaultCard,
  AgentExpandedCard,
  AGENTS,
} from './topology-agent-node';
import {
  AdapterCompactPill,
  AdapterDefaultCard,
  AdapterGhostPlaceholder,
  ADAPTERS,
} from './topology-adapter-node';
import { NamespaceGroupDemo, NAMESPACE_PALETTE } from './topology-namespace-group';
import { RelayFlowPulseDemo } from './topology-relay-flow-pulse';

/**
 * The namespaces the legend showcase names — enough of them that the legend
 * draws its namespace block at all (it hides below two).
 */
const LEGEND_NAMESPACES = (['production', 'staging', 'dev', 'testing'] as const).map(
  (namespace, i) => ({ namespace, color: NAMESPACE_PALETTE[i] })
);

/** Topology graph component showcases: AgentNode, AdapterNode, NamespaceGroupNode, edges, legend. */
export function TopologyShowcases() {
  return (
    <>
      {/* ── AgentNode ── */}
      <PlaygroundSection
        title="AgentNode"
        description="React Flow custom node with three LOD (level-of-detail) bands based on zoom level. Left border inherits agent or namespace color."
      >
        <ShowcaseLabel>Compact band (zoom &lt; 0.6)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            {AGENTS.map((a) => (
              <AgentCompactPill key={a.label} d={a} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Default band (zoom 0.6–1.2)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-4">
            {AGENTS.slice(0, 2).map((a) => (
              <AgentDefaultCard key={a.label} d={a} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Expanded band (zoom &gt; 1.2)</ShowcaseLabel>
        <ShowcaseDemo>
          <AgentExpandedCard d={AGENTS[0]} />
        </ShowcaseDemo>

        <ShowcaseLabel>Health statuses — the node's own dot, never the disc</ShowcaseLabel>
        <ShowcaseDemo>
          {/* The disc used to wear health as a coloured 2px ring, on this page
              and on every list row in the product. Health is a diagnostic about
              the last hour, so it belongs to the surface that is about health,
              beside a word that says which one it is. */}
          <div className="flex flex-wrap items-center gap-4">
            {(['active', 'inactive', 'stale', 'unreachable'] as const).map((status) => (
              <div key={status} className="flex items-center gap-2">
                <AgentAvatar color="#6366f1" emoji="🤖" size="sm" />
                <span
                  aria-hidden
                  className={cn('size-1.5 shrink-0 rounded-full', HEALTH_DISPLAY[status].dot)}
                />
                <span className="text-muted-foreground text-xs">
                  {HEALTH_DISPLAY[status].label}
                </span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      {/* ── AdapterNode ── */}
      <PlaygroundSection
        title="AdapterNode"
        description="React Flow custom node for relay adapters with two LOD bands and a ghost placeholder state."
      >
        <ShowcaseLabel>Default cards — all statuses</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-4">
            {ADAPTERS.map((a) => (
              <AdapterDefaultCard key={a.name} d={a} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Compact pills</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-3">
            {ADAPTERS.map((a) => (
              <AdapterCompactPill key={a.name} d={a} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Ghost placeholder (no adapters registered)</ShowcaseLabel>
        <ShowcaseDemo>
          <AdapterGhostPlaceholder />
        </ShowcaseDemo>
      </PlaygroundSection>

      {/* ── NamespaceGroupNode ── */}
      <PlaygroundSection
        title="NamespaceGroupNode"
        description="Compound container node that visually groups agent nodes within a namespace. Color-coded header bar with active/total badge."
      >
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-4">
            <NamespaceGroupDemo
              namespace="production"
              agentCount={5}
              activeCount={3}
              color={NAMESPACE_PALETTE[0]}
            />
            <NamespaceGroupDemo
              namespace="staging"
              agentCount={2}
              activeCount={0}
              color={NAMESPACE_PALETTE[1]}
            />
            <NamespaceGroupDemo
              namespace="dev"
              agentCount={8}
              activeCount={8}
              color={NAMESPACE_PALETTE[2]}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      {/* ── Edge Styles ── */}
      <PlaygroundSection
        title="Edge Styles"
        description="Custom React Flow edges for bindings (adapter→agent), cross-namespace allow rules, and deny rules."
      >
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <svg width="80" height="8" className="shrink-0 overflow-visible">
                <line
                  x1="0"
                  y1="4"
                  x2="80"
                  y2="4"
                  stroke="var(--color-primary)"
                  strokeWidth="2"
                  opacity="0.6"
                />
              </svg>
              <span className="text-muted-foreground text-xs">Binding (adapter → agent)</span>
            </div>
            <div className="flex items-center gap-3">
              <svg width="80" height="8" className="shrink-0 overflow-visible">
                <defs>
                  <marker
                    id="arrow-demo"
                    markerWidth="6"
                    markerHeight="6"
                    refX="5"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-primary)" />
                  </marker>
                </defs>
                <line
                  x1="0"
                  y1="4"
                  x2="74"
                  y2="4"
                  stroke="var(--color-primary)"
                  strokeWidth="1.5"
                  strokeDasharray="6 3"
                  markerEnd="url(#arrow-demo)"
                />
              </svg>
              <span className="text-muted-foreground text-xs">Cross-namespace allow rule</span>
            </div>
            <div className="flex items-center gap-3">
              <svg width="80" height="8" className="shrink-0 overflow-visible">
                <line
                  x1="0"
                  y1="4"
                  x2="80"
                  y2="4"
                  stroke="var(--color-destructive)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                  opacity="0.5"
                />
              </svg>
              <span className="text-muted-foreground text-xs">Cross-namespace deny rule</span>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      {/* ── Relay Flow Pulse ── */}
      <PlaygroundSection
        title="Relay Flow Pulse"
        description="Live traffic on binding edges: when a message is delivered from an adapter to an agent, a quiet dot travels the wire and fades. Renders the real BindingEdge, driven by synthetic store writes (no live relay/adapter needed)."
      >
        <ShowcaseDemo>
          <RelayFlowPulseDemo />
        </ShowcaseDemo>
      </PlaygroundSection>

      {/* ── TopologyLegend ── */}
      <PlaygroundSection
        title="TopologyLegend"
        description="Positioned panel at the bottom-left of the React Flow canvas showing edge types, health statuses, feature indicators, and namespace colors."
      >
        <ShowcaseDemo>
          {/* The REAL legend, inside a real (empty, inert) canvas — not a
              hand-copied replica of it.

              It was a replica, and the replica is exactly what went wrong: when
              the health vocabulary moved to one map (DOR-1052), this page kept
              drawing the retired design — a pinging green swatch, raw
              `bg-green-500`/`bg-amber-500`, and no entry for Unreachable at all.
              A playground that shows a design the product no longer has is worse
              than no playground, because it is believed.

              The canvas is here because `TopologyLegend` renders inside React
              Flow's `<Panel>`, which needs the provider to position itself. It
              carries no nodes and no interaction: this section is about the
              legend, and a demo graph would just be a second thing to keep in
              sync. Same shape as `RelayFlowPulseDemo`'s shell. */}
          <div className="bg-muted/20 h-[280px] w-full overflow-hidden rounded-md border">
            <ReactFlowProvider>
              <ReactFlow
                nodes={[]}
                edges={[]}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                panOnDrag={false}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: true }}
              >
                <TopologyLegend namespaces={LEGEND_NAMESPACES} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
