import { lazy, Suspense, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { Drawer, DrawerContent, QueryErrorState } from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { useProfileStore } from '@/layers/features/profile';
import { useOpenConnections } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useTopology } from '@/layers/entities/mesh';
import { normalizeTeamView } from '@/layers/shared/lib';
import type { TeamGrouping, TeamKindFilter, TeamRosterFilters } from '@/layers/entities/team';
import { AgentsList, AgentGhostRows, DeniedView, AccessView } from '@/layers/features/agents-list';
import { AgentHealthDetail } from '@/layers/features/mesh';
import { TeamPage } from './TeamPage';

// Lazy-load topology to avoid pulling ReactFlow into the initial bundle.
// Direct internal path used intentionally — barrel re-exports break code splitting.
const LazyTopologyGraph = lazy(() =>
  import('@/layers/features/mesh/ui/TopologyGraph').then((m) => ({ default: m.TopologyGraph }))
);

/** How long a view cross-fade takes, in seconds. */
const FADE_SECONDS = 0.15;

const FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: FADE_SECONDS },
};

/**
 * The `/team` route: everyone on this install, in whichever view is addressed.
 *
 * This component owns the search params and nothing else owns them — the roster
 * page below is controlled, so a chip, a group toggle and the search box all
 * write to the URL and a narrowed roster is an address someone can send.
 *
 * The four non-roster views are the ones `/agents` used to serve, moved here
 * whole rather than left behind a second page: the table is the fleet table,
 * the topology is the mesh map, and denied/access are its management surfaces.
 * They are reached from this page's view switch instead of a separate concept.
 */
export function TeamRoute() {
  const search = useSearch({ from: '/_shell/team' });
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const openConnections = useOpenConnections();
  const [, setDir] = useDirectoryState();
  const { data: topology, isLoading, isError, refetch } = useTopology();

  // Every one of these reached us through `teamSearchSchema`, so the values are
  // already validated — but they typecheck as `unknown`, because
  // `agentFilterSchema.searchValidator` is declared `ZodObject<Record<string,
  // ZodTypeAny>>` and merging that index signature widens every sibling key
  // with it. So this narrows what Zod already checked rather than re-checking
  // it. `view` goes through the shared normalizer instead of a cast, because
  // that one has a legacy spelling to fold in anyway.
  const viewMode = normalizeTeamView(search.view);
  const selectedAgentId = search.agent as string | undefined;

  const filters: TeamRosterFilters = useMemo(
    () => ({
      kind: search.kind as TeamKindFilter,
      owner: search.owner as string | undefined,
      group: search.group as TeamGrouping,
      q: search.q as string | undefined,
    }),
    [search.kind, search.owner, search.group, search.q]
  );

  function patchFilters(patch: Partial<TeamRosterFilters>) {
    void navigate({ to: '/team', search: (prev) => ({ ...prev, ...patch }) });
  }

  function clearSelectedAgent() {
    void navigate({ to: '/team', search: (prev) => ({ ...prev, agent: undefined }) });
  }

  // Flatten topology namespaces into a single agent array with health + projectPath attached.
  const agents = useMemo(() => topology?.namespaces.flatMap((ns) => ns.agents) ?? [], [topology]);

  // The invitation to bring projects in, instead of an empty fleet view. Not
  // for the cards roster: the person reading the page is on that one, so it is
  // never empty and `TeamPage` puts the invitation below the roster instead.
  const isEmptyFleet =
    agents.length === 0 &&
    !isLoading &&
    !isError &&
    (viewMode === 'table' || viewMode === 'topology');

  if (isError && viewMode !== 'cards') {
    return (
      <QueryErrorState
        className="h-full"
        title="Could not load agents"
        description="The mesh API is unreachable. Check that the server is running correctly."
        onRetry={() => void refetch()}
      />
    );
  }

  if (isEmptyFleet) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <AgentGhostRows />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <AnimatePresence mode="wait" initial={false}>
        {viewMode === 'cards' && (
          <motion.div key="view-cards" {...FADE} className="flex h-full flex-col">
            <TeamPage filters={filters} onFiltersChange={patchFilters} />
          </motion.div>
        )}
        {viewMode === 'table' && (
          <motion.div key="view-table" {...FADE} className="flex h-full flex-col">
            {/* The same filters the cards obey. A chip that narrowed one view
                and not the other would leave the URL describing a page that is
                not on screen. */}
            <AgentsList agents={agents} isLoading={isLoading} rosterFilters={filters} />
          </motion.div>
        )}
        {viewMode === 'topology' && (
          <motion.div key="view-topology" {...FADE} className="relative flex-1 overflow-hidden">
            <div className="flex h-full">
              <motion.div
                layout
                className="min-w-0 flex-1"
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
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
                    <LazyTopologyGraph
                      onSelectAgent={(agentId) =>
                        void navigate({
                          to: '/team',
                          search: (prev) => ({ ...prev, agent: agentId }),
                        })
                      }
                      onViewProfile={(_agentId, projectPath) => {
                        useProfileStore.getState().openProfileDocked(projectPath);
                      }}
                      onOpenChat={(projectPath) => setDir(projectPath)}
                      onOpenAdapterCatalog={() => openConnections('messaging')}
                      onGoToDiscovery={() =>
                        void navigate({
                          to: '/team',
                          search: (prev) => ({ ...prev, view: 'table' }),
                        })
                      }
                    />
                  </Suspense>
                </div>
              </motion.div>
              {isMobile ? (
                <Drawer
                  open={!!selectedAgentId}
                  onOpenChange={(open) => !open && clearSelectedAgent()}
                >
                  <DrawerContent>
                    {selectedAgentId && (
                      <AgentHealthDetail agentId={selectedAgentId} onClose={clearSelectedAgent} />
                    )}
                  </DrawerContent>
                </Drawer>
              ) : (
                <AnimatePresence>
                  {selectedAgentId && (
                    <motion.div
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: 256, opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                      className="bg-background overflow-y-auto border-l"
                    >
                      <AgentHealthDetail agentId={selectedAgentId} onClose={clearSelectedAgent} />
                    </motion.div>
                  )}
                </AnimatePresence>
              )}
            </div>
          </motion.div>
        )}
        {viewMode === 'denied' && (
          <motion.div key="view-denied" {...FADE}>
            <DeniedView />
          </motion.div>
        )}
        {viewMode === 'access' && (
          <motion.div key="view-access" {...FADE}>
            <AccessView />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
