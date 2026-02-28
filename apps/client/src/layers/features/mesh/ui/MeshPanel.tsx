import { lazy, Suspense, useState, useCallback } from 'react';
import { Loader2, Network, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tabs, TabsList, TabsTrigger, TabsContent, FeatureDisabledState } from '@/layers/shared/ui';
import { Badge } from '@/layers/shared/ui/badge';
import {
  useMeshEnabled,
  useRegisteredAgents,
  useDeniedAgents,
  useUnregisterAgent,
} from '@/layers/entities/mesh';
import type { AgentManifest, DenialRecord } from '@dorkos/shared/mesh-schemas';
import { useDirectoryState } from '@/layers/entities/session';
import { MeshStatsHeader } from './MeshStatsHeader';
import { AgentHealthDetail } from './AgentHealthDetail';
import { TopologyPanel } from './TopologyPanel';
import { DiscoveryView } from './DiscoveryView';
import { MeshEmptyState } from './MeshEmptyState';

const LazyTopologyGraph = lazy(() =>
  import('./TopologyGraph').then((m) => ({ default: m.TopologyGraph })),
);

// -- Agents Tab --

interface AgentsTabProps {
  agents: AgentManifest[];
  isLoading: boolean;
  onGoToDiscovery: () => void;
}

function AgentsTab({ agents, isLoading, onGoToDiscovery }: AgentsTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <MeshEmptyState
        icon={Network}
        headline="No agents registered yet"
        description="Discover agents in your filesystem and register them to the mesh."
        action={{ label: 'Go to Discovery', onClick: onGoToDiscovery }}
      />
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
    <div className="space-y-1 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{agent.name}</p>
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
      <MeshEmptyState
        icon={ShieldCheck}
        headline="No blocked paths"
        description="When you deny agent paths during discovery, they appear here. This is a healthy state."
      />
    );
  }

  return (
    <div className="space-y-2 p-4">
      {denied.map((d) => (
        <div key={d.path} className="flex items-center justify-between rounded-xl border px-4 py-3">
          <div>
            <p className="font-mono text-sm">{d.path}</p>
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

/** Main Mesh panel — progressive disclosure with Mode A (empty) and Mode B (populated). */
export function MeshPanel() {
  const meshEnabled = useMeshEnabled();
  const { data: agentsResult, isLoading: agentsLoading, isError: agentsError, refetch: refetchAgents } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsResult?.agents ?? [];
  const { data: deniedResult, isLoading: deniedLoading } = useDeniedAgents(meshEnabled);
  const denied = deniedResult?.denied ?? [];
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('topology');

  const [, setDir] = useDirectoryState();

  /** Navigate to agent's working directory to start a chat session. */
  const handleOpenChat = useCallback(
    (agentDir: string) => {
      setDir(agentDir);
    },
    [setDir],
  );

  const hasAgents = agents.length > 0;
  // Only show Mode A (discovery flow) when we *know* there are no agents.
  // An error state is distinct: we can't tell if agents exist, so don't
  // redirect the user to Discovery — show an explicit error instead.
  const isModeA = !hasAgents && !agentsLoading && !agentsError;

  if (!meshEnabled) {
    return (
      <FeatureDisabledState
        icon={Network}
        name="Mesh"
        description="Mesh provides agent discovery and registry. Start DorkOS with mesh enabled."
        command="DORKOS_MESH_ENABLED=true dorkos"
      />
    );
  }

  if (agentsError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="rounded-xl bg-destructive/10 p-3">
          <TriangleAlert className="size-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load agents</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The mesh API is unreachable. Check that the server is running with{' '}
            <code className="rounded bg-muted px-1 font-mono">DORKOS_MESH_ENABLED=true</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetchAgents()}
          className="mt-1 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  const switchToDiscovery = () => setActiveTab('discovery');

  return (
    <AnimatePresence mode="wait" initial={false}>
      {isModeA ? (
        <motion.div
          key="mode-a"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          <DiscoveryView fullBleed />
        </motion.div>
      ) : (
        <motion.div
          key="mode-b"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex h-full flex-col"
        >
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
            <MeshStatsHeader />
            <TabsList className="mx-4 mt-3 shrink-0">
              <TabsTrigger value="topology">Topology</TabsTrigger>
              <TabsTrigger value="discovery">Discovery</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="denied">Denied</TabsTrigger>
              <TabsTrigger value="access">Access</TabsTrigger>
            </TabsList>

            <TabsContent value="topology" className="relative flex-1 overflow-hidden">
              <div className="absolute inset-0">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading topology...
                    </div>
                  }
                >
                  <LazyTopologyGraph
                    onSelectAgent={setSelectedAgentId}
                    onOpenChat={handleOpenChat}
                    // onOpenSettings omitted — requires agent projectPath which isn't
                    // exposed in the topology data yet. Settings button in NodeToolbar
                    // hides itself when this callback is absent.
                  />
                </Suspense>
              </div>
              <AnimatePresence>
                {selectedAgentId && (
                  <motion.div
                    key={selectedAgentId}
                    initial={{ x: 64, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 64, opacity: 0 }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className="absolute right-0 top-0 bottom-0"
                  >
                    <AgentHealthDetail
                      agentId={selectedAgentId}
                      onClose={() => setSelectedAgentId(null)}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </TabsContent>

            <TabsContent value="discovery" className="min-h-0 flex-1 overflow-y-auto">
              <DiscoveryView />
            </TabsContent>

            <TabsContent value="agents" className="min-h-0 flex-1 overflow-y-auto">
              <AgentsTab agents={agents} isLoading={agentsLoading} onGoToDiscovery={switchToDiscovery} />
            </TabsContent>

            <TabsContent value="denied" className="min-h-0 flex-1 overflow-y-auto">
              <DeniedTab denied={denied} isLoading={deniedLoading} />
            </TabsContent>

            <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto">
              <TopologyPanel onGoToDiscovery={switchToDiscovery} />
            </TabsContent>
          </Tabs>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
