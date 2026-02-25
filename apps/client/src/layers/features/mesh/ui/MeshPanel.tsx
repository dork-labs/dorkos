import { lazy, Suspense, useState } from 'react';
import { Loader2, Network, Plus, Search, Trash2, X } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import { Badge } from '@/layers/shared/ui/badge';
import {
  useMeshEnabled,
  useRegisteredAgents,
  useDiscoverAgents,
  useDeniedAgents,
  useUnregisterAgent,
} from '@/layers/entities/mesh';
import type { DiscoveryCandidate, AgentManifest, DenialRecord } from '@dorkos/shared/mesh-schemas';
import { MeshStatsHeader } from './MeshStatsHeader';
import { AgentHealthDetail } from './AgentHealthDetail';
import { TopologyPanel } from './TopologyPanel';

const LazyTopologyGraph = lazy(() =>
  import('./TopologyGraph').then((m) => ({ default: m.TopologyGraph })),
);

// -- Discovery Tab --

function DiscoveryTab() {
  const [roots, setRoots] = useState('');
  const { mutate: discover, data: result, isPending } = useDiscoverAgents();
  const candidates = result?.candidates;

  function handleScan() {
    const parsed = roots
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (parsed.length > 0) {
      discover({ roots: parsed });
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={roots}
          onChange={(e) => setRoots(e.target.value)}
          placeholder="Roots to scan (comma-separated, e.g. ~/projects, /opt/agents)"
          className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={handleScan}
          disabled={isPending || roots.trim().length === 0}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Scan
        </button>
      </div>

      {isPending && (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isPending && candidates && candidates.length === 0 && (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No agents discovered. Try scanning different directories.
        </div>
      )}

      {!isPending && candidates && candidates.length > 0 && (
        <div className="space-y-2">
          {candidates.map((c: DiscoveryCandidate) => (
            <CandidateCard key={c.path} candidate={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CandidateCard({ candidate }: { candidate: DiscoveryCandidate }) {
  return (
    <div className="rounded-xl border p-4 space-y-1">
      <div className="flex items-center justify-between">
        <p className="font-medium text-sm">{candidate.hints.suggestedName}</p>
        <Badge variant="secondary">{candidate.hints.detectedRuntime}</Badge>
      </div>
      <p className="text-xs text-muted-foreground font-mono">{candidate.path}</p>
      {candidate.hints.description && (
        <p className="text-xs text-muted-foreground">{candidate.hints.description}</p>
      )}
      {candidate.hints.inferredCapabilities && candidate.hints.inferredCapabilities.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {candidate.hints.inferredCapabilities.map((cap) => (
            <Badge key={cap} variant="outline" className="text-xs">
              {cap}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Agents Tab --

interface AgentsTabProps {
  agents: AgentManifest[];
  isLoading: boolean;
}

function AgentsTab({ agents, isLoading }: AgentsTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No agents registered. Discover and register agents from the Discovery tab.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentManifest }) {
  const { mutate: unregister } = useUnregisterAgent();

  return (
    <div className="rounded-xl border p-4 space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{agent.name}</p>
          <Badge variant="secondary">{agent.runtime}</Badge>
        </div>
        <button
          type="button"
          onClick={() => unregister(agent.id)}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Unregister ${agent.name}`}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {agent.description && (
        <p className="text-xs text-muted-foreground">{agent.description}</p>
      )}
      {agent.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1">
          {agent.capabilities.map((cap) => (
            <Badge key={cap} variant="outline" className="text-xs">
              {cap}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// -- Denied Tab --

interface DeniedTabProps {
  denied: DenialRecord[];
  isLoading: boolean;
}

function DeniedTab({ denied, isLoading }: DeniedTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (denied.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No denied paths.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {denied.map((d) => (
        <div key={d.path} className="flex items-center justify-between rounded-xl border px-4 py-3">
          <div>
            <p className="text-sm font-mono">{d.path}</p>
            {d.reason && <p className="text-xs text-muted-foreground">{d.reason}</p>}
          </div>
          <Badge variant="outline" className="text-xs">
            {d.strategy}
          </Badge>
        </div>
      ))}
    </div>
  );
}

// -- Main Panel --

/** Main Mesh panel — tabs for Topology, Discovery, Agents, and Denied, with disabled/loading states. */
export function MeshPanel() {
  const meshEnabled = useMeshEnabled();
  const { data: agentsResult, isLoading: agentsLoading } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsResult?.agents ?? [];
  const { data: deniedResult, isLoading: deniedLoading } = useDeniedAgents(meshEnabled);
  const denied = deniedResult?.denied ?? [];
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  if (!meshEnabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Network className="size-8 text-muted-foreground/50" />
        <div>
          <p className="font-medium">Mesh is not enabled</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Mesh provides agent discovery and registry. Start DorkOS with mesh enabled.
          </p>
        </div>
        <code className="mt-2 rounded-md bg-muted px-3 py-1.5 font-mono text-sm">
          DORKOS_MESH_ENABLED=true dorkos
        </code>
      </div>
    );
  }

  return (
    <Tabs defaultValue="topology" className="flex h-full flex-col">
      <MeshStatsHeader />
      <TabsList className="mx-4 mt-3 shrink-0">
        <TabsTrigger value="topology">Topology</TabsTrigger>
        <TabsTrigger value="discovery">Discovery</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
        <TabsTrigger value="denied">Denied</TabsTrigger>
        <TabsTrigger value="access">Access</TabsTrigger>
      </TabsList>

      <TabsContent value="topology" className="flex-1 flex overflow-hidden">
        <div className="flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading topology...
              </div>
            }
          >
            <LazyTopologyGraph onSelectAgent={setSelectedAgentId} />
          </Suspense>
        </div>
        {selectedAgentId && (
          <AgentHealthDetail
            agentId={selectedAgentId}
            onClose={() => setSelectedAgentId(null)}
          />
        )}
      </TabsContent>

      <TabsContent value="discovery" className="min-h-0 flex-1 overflow-y-auto">
        <DiscoveryTab />
      </TabsContent>

      <TabsContent value="agents" className="min-h-0 flex-1 overflow-y-auto">
        <AgentsTab agents={agents} isLoading={agentsLoading} />
      </TabsContent>

      <TabsContent value="denied" className="min-h-0 flex-1 overflow-y-auto">
        <DeniedTab denied={denied} isLoading={deniedLoading} />
      </TabsContent>

      <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto">
        <TopologyPanel />
      </TabsContent>
    </Tabs>
  );
}
