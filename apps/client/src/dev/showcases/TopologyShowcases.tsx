import { Zap, Clock } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AgentAvatar } from '@/layers/entities/agent';
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

        <ShowcaseLabel>Health statuses (via AgentAvatar ring)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-4">
            {(['active', 'inactive', 'stale', 'unreachable'] as const).map((status) => (
              <div key={status} className="flex items-center gap-2">
                <AgentAvatar color="#6366f1" emoji="🤖" healthStatus={status} size="sm" />
                <span className="text-muted-foreground text-xs capitalize">{status}</span>
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
          <div className="bg-card/90 text-muted-foreground inline-flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[11px] shadow-sm">
            <div className="flex items-center gap-2">
              <svg width="24" height="4" className="shrink-0 overflow-visible">
                <line
                  x1="0"
                  y1="2"
                  x2="24"
                  y2="2"
                  stroke="var(--color-primary)"
                  strokeWidth="1.5"
                />
                <circle cx="8" cy="2" r="2.5" fill="var(--color-primary)" opacity="0.9" />
              </svg>
              <span>Allow rule (data flow)</span>
            </div>
            <div className="flex items-center gap-2">
              <svg width="24" height="4" className="shrink-0 overflow-visible">
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
            <div className="border-t" />
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-6 items-center justify-center">
                <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-green-500/40" />
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
            <div className="border-t" />
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
            <div className="border-t" />
            {NAMESPACE_PALETTE.map((color, i) => (
              <div key={color} className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span>{(['production', 'staging', 'dev', 'testing'] as const)[i]}</span>
              </div>
            ))}
            <div className="border-t" />
            <span className="text-[10px] italic opacity-60">Zoom in for more detail</span>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
