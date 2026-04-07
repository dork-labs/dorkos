import { lazy, Suspense, useState, useCallback } from 'react';
import { Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import { Badge } from '@/layers/shared/ui/badge';
import { useRegisteredAgents, useDeniedAgents } from '@/layers/entities/mesh';
import type { DenialRecord } from '@dorkos/shared/mesh-schemas';
import { useDirectoryState } from '@/layers/entities/session';
import { useOpenAgentDialog } from '@/layers/shared/model';
import { MeshStatsHeader } from './MeshStatsHeader';
import { AgentHealthDetail } from './AgentHealthDetail';
import { TopologyPanel } from './TopologyPanel';
import { DiscoveryView } from './DiscoveryView';
import { MeshEmptyState } from './MeshEmptyState';

const LazyTopologyGraph = lazy(() =>
  import('./TopologyGraph').then((m) => ({ default: m.TopologyGraph }))
);

// -- Denied Tab --

interface DeniedTabProps {
  denied: DenialRecord[];
  isLoading: boolean;
}

function DeniedTab({ denied, isLoading }: DeniedTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
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
            {d.reason && <p className="text-muted-foreground text-xs">{d.reason}</p>}
          </div>
          <Badge variant="outline" className="text-xs">
            {d.deniedBy}
          </Badge>
        </div>
      ))}
    </div>
  );
}

// -- Main Panel --

/** Main Mesh panel — progressive disclosure with Mode A (empty) and Mode B (populated). */
export function MeshPanel() {
  const {
    data: agentsResult,
    isLoading: agentsLoading,
    isError: agentsError,
    refetch: refetchAgents,
  } = useRegisteredAgents();
  const agents = agentsResult?.agents ?? [];
  const { data: deniedResult, isLoading: deniedLoading } = useDeniedAgents();
  const denied = deniedResult?.denied ?? [];
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');
  const [activeTab, setActiveTab] = useState('topology');

  const openAgentDialog = useOpenAgentDialog();
  const [, setDir] = useDirectoryState();

  /** Navigate to agent's working directory to start a chat session. */
  const handleOpenChat = useCallback(
    (projectPath: string) => {
      setDir(projectPath);
    },
    [setDir]
  );

  /** Track selected agent and its project path from topology clicks. */
  const handleSelectAgent = useCallback((agentId: string, projectPath: string) => {
    setSelectedAgentId(agentId);
    setSelectedProjectPath(projectPath);
  }, []);

  /** Open agent settings dialog from topology toolbar. */
  const handleOpenSettings = useCallback(
    (_agentId: string, projectPath: string) => {
      openAgentDialog(projectPath);
    },
    [openAgentDialog]
  );

  const hasAgents = agents.length > 0;
  // Only show Mode A (discovery flow) when we *know* there are no agents.
  // An error state is distinct: we can't tell if agents exist, so don't
  // redirect the user to Discovery — show an explicit error instead.
  const isModeA = !hasAgents && !agentsLoading && !agentsError;

  if (agentsError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="bg-destructive/10 rounded-xl p-3">
          <TriangleAlert className="text-destructive size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load agents</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The mesh API is unreachable. Check that the server is running correctly.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetchAgents()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 mt-1 inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium"
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
              <MeshStatsHeader />

              <TabsList className="mx-4 mt-3 shrink-0">
                <TabsTrigger value="topology">Topology</TabsTrigger>
                <TabsTrigger value="discovery">Discovery</TabsTrigger>
                <TabsTrigger value="denied">Denied</TabsTrigger>
                <TabsTrigger value="access">Access</TabsTrigger>
              </TabsList>

              <TabsContent value="topology" className="relative flex-1 overflow-hidden">
                <div className="absolute inset-0">
                  <Suspense
                    fallback={
                      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
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
                      className="absolute top-0 right-0 bottom-0"
                    >
                      <AgentHealthDetail
                        agentId={selectedAgentId}
                        onClose={() => setSelectedAgentId(null)}
                        onOpenSettings={
                          selectedProjectPath
                            ? () => handleOpenSettings(selectedAgentId, selectedProjectPath)
                            : undefined
                        }
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </TabsContent>

              <TabsContent value="discovery" className="min-h-0 flex-1 overflow-y-auto">
                <DiscoveryView />
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
    </>
  );
}
