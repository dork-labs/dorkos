import { lazy, Suspense, useState, useCallback, useMemo } from 'react';
import { Loader2, Network, Radar, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import { Badge } from '@/layers/shared/ui/badge';
import {
  useRegisteredAgents,
  useRegisterAgent,
  useDeniedAgents,
  useUnregisterAgent,
} from '@/layers/entities/mesh';
import type { AgentManifest, DenialRecord } from '@dorkos/shared/mesh-schemas';
import { useDirectoryState } from '@/layers/entities/session';
import { AgentDialog } from '@/layers/features/agent-settings';
import { useDiscoveryScan, AgentCard as OnboardingAgentCard } from '@/layers/features/onboarding';
import type { ScanCandidate } from '@/layers/features/onboarding';
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

// -- Discover Agents Section --

interface DiscoverAgentsSectionProps {
  registeredNames: Set<string>;
}

/** Inline discovery section using the SSE-based scanner from onboarding. */
function DiscoverAgentsSection({ registeredNames }: DiscoverAgentsSectionProps) {
  const { candidates, isScanning, progress, startScan, error } = useDiscoveryScan();
  const { mutate: registerAgent } = useRegisterAgent();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleCandidate = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  /** Check if a candidate is already registered by name or .dork marker. */
  const isRegistered = useCallback(
    (c: ScanCandidate) => registeredNames.has(c.name) || c.markers.includes('.dork'),
    [registeredNames],
  );

  const handleRegisterSelected = useCallback(() => {
    for (const path of selected) {
      const candidate = candidates.find((c) => c.path === path);
      if (candidate && !isRegistered(candidate)) {
        registerAgent({ path: candidate.path });
      }
    }
    setSelected(new Set());
  }, [selected, candidates, isRegistered, registerAgent]);

  // Enrich candidates with registration status for the onboarding AgentCard
  const enrichedCandidates = useMemo(
    () =>
      candidates.map((c) => ({
        ...c,
        hasDorkManifest: isRegistered(c),
      })),
    [candidates, isRegistered],
  );

  const unregisteredSelected = [...selected].filter((p) => {
    const c = candidates.find((cand) => cand.path === p);
    return c && !isRegistered(c);
  });

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => startScan()}
          disabled={isScanning}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isScanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Radar className="size-4" />
          )}
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>

        {progress && (
          <span className="text-xs text-muted-foreground">
            {progress.scannedDirs} dirs scanned, {progress.foundAgents} agents found
          </span>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {!isScanning && candidates.length === 0 && progress && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="text-sm font-medium">No agents found</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try scanning from a different directory or check your project structure.
          </p>
        </div>
      )}

      {enrichedCandidates.length > 0 && (
        <>
          <div className="space-y-2">
            {enrichedCandidates.map((c) => (
              <OnboardingAgentCard
                key={c.path}
                candidate={c}
                selected={selected.has(c.path)}
                onToggle={() => toggleCandidate(c.path)}
              />
            ))}
          </div>

          {unregisteredSelected.length > 0 && (
            <button
              type="button"
              onClick={handleRegisterSelected}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Register {unregisteredSelected.length} agent{unregisteredSelected.length > 1 ? 's' : ''}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// -- Main Panel --

/** Main Mesh panel — progressive disclosure with Mode A (empty) and Mode B (populated). */
export function MeshPanel() {
  const { data: agentsResult, isLoading: agentsLoading, isError: agentsError, refetch: refetchAgents } = useRegisteredAgents();
  const agents = agentsResult?.agents ?? [];
  const { data: deniedResult, isLoading: deniedLoading } = useDeniedAgents();
  const denied = deniedResult?.denied ?? [];
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');
  const [activeTab, setActiveTab] = useState('topology');

  // Agent settings dialog state
  const [settingsProjectPath, setSettingsProjectPath] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [, setDir] = useDirectoryState();

  /** Navigate to agent's working directory to start a chat session. */
  const handleOpenChat = useCallback(
    (projectPath: string) => {
      setDir(projectPath);
    },
    [setDir],
  );

  /** Track selected agent and its project path from topology clicks. */
  const handleSelectAgent = useCallback(
    (agentId: string, projectPath: string) => {
      setSelectedAgentId(agentId);
      setSelectedProjectPath(projectPath);
    },
    [],
  );

  /** Open agent settings dialog from topology toolbar. */
  const handleOpenSettings = useCallback(
    (_agentId: string, projectPath: string) => {
      setSettingsProjectPath(projectPath);
      setSettingsOpen(true);
    },
    [],
  );

  const [showQuickDiscover, setShowQuickDiscover] = useState(false);

  // Build a set of registered agent names for quick lookup
  const registeredNames = useMemo(
    () => new Set(agents.map((a) => a.name)),
    [agents],
  );

  const hasAgents = agents.length > 0;
  // Only show Mode A (discovery flow) when we *know* there are no agents.
  // An error state is distinct: we can't tell if agents exist, so don't
  // redirect the user to Discovery — show an explicit error instead.
  const isModeA = !hasAgents && !agentsLoading && !agentsError;

  if (agentsError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="rounded-xl bg-destructive/10 p-3">
          <TriangleAlert className="size-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load agents</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The mesh API is unreachable. Check that the server is running correctly.
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
    <>
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
            <div className="flex items-center justify-between">
              <MeshStatsHeader />
              <button
                type="button"
                onClick={() => setShowQuickDiscover((v) => !v)}
                className="mr-3 mt-1 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Discover Agents"
              >
                <Radar className="size-3.5" />
                Discover Agents
              </button>
            </div>

            <AnimatePresence initial={false}>
              {showQuickDiscover && (
                <motion.div
                  key="quick-discover"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden border-b"
                >
                  <DiscoverAgentsSection registeredNames={registeredNames} />
                </motion.div>
              )}
            </AnimatePresence>

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
                    onSelectAgent={handleSelectAgent}
                    onOpenSettings={handleOpenSettings}
                    onOpenChat={handleOpenChat}
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
                      onOpenSettings={selectedProjectPath ? () => handleOpenSettings(selectedAgentId, selectedProjectPath) : undefined}
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
    {settingsProjectPath && (
      <AgentDialog
        projectPath={settingsProjectPath}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    )}
    </>
  );
}
