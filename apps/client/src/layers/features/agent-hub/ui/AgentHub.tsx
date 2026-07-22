import { useState, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { useAppStore, useSafePathname } from '@/layers/shared/model';
import { Skeleton } from '@/layers/shared/ui';
import { AgentHubProvider } from '../model/agent-hub-context';
import { useAgentHubStore } from '../model/agent-hub-store';
import { useAgentHubDeepLink, useAgentDialogRedirect } from '../model/use-agent-hub-deep-link';
import { AgentHubHero } from './AgentHubHero';
import { AgentHubTabBar } from './AgentHubTabBar';
import { AgentHubTabContent } from './AgentHubTabContent';
import { AvatarPickerPanel } from './AvatarPickerPopover';
import { PersonalityPickerPanel } from './PersonalityPickerPopover';
import { NoAgentSelected } from './NoAgentSelected';
import { AgentNotFound } from './AgentNotFound';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Which inline picker panel is open, or null for normal tab view. */
type HeroPanel = 'avatar' | 'personality' | null;

/** Placeholder that matches the AgentHub layout while data loads for the first time. */
function AgentHubSkeleton() {
  return (
    <div data-slot="agent-hub" className="flex h-full flex-col overflow-hidden">
      <div className="relative flex flex-col items-center gap-1 border-b pt-4 pb-0">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="mt-1 h-4 w-24 rounded" />
        <Skeleton className="h-3 w-12 rounded" />
        <Skeleton className="mt-1 h-6 w-20 rounded-full" />
        <div className="h-2" />
      </div>
      <div className="flex border-b">
        {['w-16', 'w-14', 'w-16'].map((w, i) => (
          <div key={i} className="flex flex-1 justify-center py-2">
            <Skeleton className={`h-3 ${w} rounded`} />
          </div>
        ))}
      </div>
      <div className="flex-1 space-y-3 p-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}

/**
 * Shell component for the Agent Hub right-panel contribution.
 *
 * Layout: Hero (sticky) -> TabBar | Picker header -> TabContent | Picker body.
 * When a hero element is clicked (avatar or personality badge), the tab area
 * is replaced by a full-width inline picker panel.
 *
 * Holds the previous agent visible during loading to avoid blank flashes
 * when switching between agents.
 */
export function AgentHub() {
  useAgentHubDeepLink();
  useAgentDialogRedirect();

  const [heroPanel, setHeroPanel] = useState<HeroPanel>(null);
  const [previewColor, setPreviewColor] = useState<string | null>(null);

  // An explicit Agent Hub selection (openHub) always wins. The `selectedCwd`
  // fallback is only honest ON /session — there it IS the session's own agent.
  // Off /session `selectedCwd` is the server's ambient startup directory, not a
  // user pick, so we must NOT resolve it: the panel would otherwise profile an
  // agent nobody chose. This keeps the component in agreement with the
  // contribution's selection-honest `visibleWhen` gate (see init-extensions.ts).
  const hubAgentPath = useAgentHubStore((s) => s.agentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  // In the routed cockpit this is the live pathname; in the Obsidian embed it is
  // always the session surface ('/session'), so the panel profiles the session's
  // own agent there just as it does on the web session route.
  const isSessionRoute = useSafePathname() === '/session';
  const agentPath = hubAgentPath ?? (isSessionRoute ? selectedCwd : null);

  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  const { data: agent, isLoading } = useCurrentAgent(agentPath);
  const updateAgent = useUpdateAgent();

  // Hold previous agent visible while the next one loads to avoid blank flash.
  const previousAgentRef = useRef<{ agent: AgentManifest; path: string } | null>(null);
  if (agent && agentPath) {
    previousAgentRef.current = { agent, path: agentPath };
  }

  const togglePanel = useCallback((panel: 'avatar' | 'personality') => {
    setHeroPanel((prev) => {
      if (prev === panel) {
        setPreviewColor(null);
        return null;
      }
      return panel;
    });
  }, []);

  const closePanel = useCallback(() => {
    setHeroPanel(null);
    setPreviewColor(null);
  }, []);

  // Derive display data: prefer fresh data, fall back to previous agent during load.
  const displayAgent = agentPath ? (agent ?? previousAgentRef.current?.agent) : undefined;
  const displayPath = agentPath ? (agent ? agentPath : previousAgentRef.current?.path) : undefined;

  const contextValue = useMemo(
    () =>
      displayAgent && displayPath
        ? {
            agent: displayAgent,
            projectPath: displayPath,
            onUpdate: (updates: Partial<AgentManifest>) =>
              updateAgent.mutate({ path: displayPath, updates }),
            onPersonalityUpdate: (
              updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
            ) => {
              const { soulContent: _soul, nopeContent: _nope, ...manifestUpdates } = updates;
              if (Object.keys(manifestUpdates).length > 0) {
                updateAgent.mutate({ path: displayPath, updates: manifestUpdates });
              }
            },
            previewColor,
            onPreviewColor: setPreviewColor,
            isPickerOpen: heroPanel === 'avatar',
          }
        : null,
    [displayAgent, displayPath, updateAgent, previewColor, heroPanel]
  );

  // No path configured at all.
  if (!agentPath) {
    return <NoAgentSelected />;
  }

  const isFirstLoad = isLoading && !displayAgent;

  // First ever load with no cached data — show skeleton.
  if (isFirstLoad) {
    return <AgentHubSkeleton />;
  }

  // Path is set but the agent manifest could not be found (and no fallback).
  if (!contextValue) {
    return <AgentNotFound agentPath={agentPath} />;
  }

  return (
    <AgentHubProvider value={contextValue}>
      <motion.div
        data-slot="agent-hub"
        className="flex h-full flex-col overflow-hidden"
        animate={{ opacity: rightPanelOpen ? 1 : 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      >
        <AgentHubHero
          onAvatarClick={() => togglePanel('avatar')}
          onPersonalityClick={() => togglePanel('personality')}
        />
        {heroPanel === null ? (
          <>
            <AgentHubTabBar />
            <AnimatePresence mode="wait">
              <motion.div
                key={displayPath}
                className="flex min-h-0 flex-1 flex-col"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15, ease: 'easeInOut' }}
              >
                <AgentHubTabContent />
              </motion.div>
            </AnimatePresence>
          </>
        ) : heroPanel === 'avatar' ? (
          <AvatarPickerPanel onClose={closePanel} />
        ) : (
          <PersonalityPickerPanel onClose={closePanel} />
        )}
      </motion.div>
    </AgentHubProvider>
  );
}
