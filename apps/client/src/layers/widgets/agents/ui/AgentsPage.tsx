import { lazy, Suspense, useMemo } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useSearch } from '@tanstack/react-router';
import { Button } from '@/layers/shared/ui/button';
import { useTopology } from '@/layers/entities/mesh';
import { AgentsList, AgentGhostRows } from '@/layers/features/agents-list';

// Lazy-load topology to avoid pulling ReactFlow into the initial bundle.
// Direct internal path used intentionally — barrel re-exports break code splitting.
const LazyTopologyGraph = lazy(() =>
  import('@/layers/features/mesh/ui/TopologyGraph').then((m) => ({ default: m.TopologyGraph }))
);

/** Agents page — full-viewport fleet management surface at /agents. */
export function AgentsPage() {
  const { view: viewMode } = useSearch({ from: '/_shell/agents' });
  const { data: topology, isLoading, isError, refetch } = useTopology();

  // Flatten topology namespaces into a single agent array with health + projectPath attached.
  const agents = useMemo(() => topology?.namespaces.flatMap((ns) => ns.agents) ?? [], [topology]);

  const hasAgents = agents.length > 0;
  const isModeA = !hasAgents && !isLoading && !isError;

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="bg-destructive/10 rounded-xl p-3">
          <TriangleAlert className="text-destructive size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load agents</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The mesh API is unreachable. Check that the server is running correctly.
          </p>
        </div>
        <Button size="sm" onClick={() => void refetch()} className="mt-1">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {isModeA ? (
        <motion.div
          key="mode-a"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="flex h-full flex-col items-center justify-center"
        >
          <AgentGhostRows />
        </motion.div>
      ) : (
        <motion.div
          key="mode-b"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="flex h-full flex-col"
        >
          <AnimatePresence mode="wait" initial={false}>
            {viewMode === 'topology' ? (
              <motion.div
                key="view-topology"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="relative flex-1 overflow-hidden"
              >
                <div className="absolute inset-0">
                  <Suspense
                    fallback={
                      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Loading topology...
                      </div>
                    }
                  >
                    <LazyTopologyGraph />
                  </Suspense>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="view-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex h-full flex-col"
              >
                <AgentsList agents={agents} isLoading={isLoading} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
