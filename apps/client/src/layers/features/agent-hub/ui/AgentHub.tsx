import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { useAppStore } from '@/layers/shared/model';
import { Skeleton } from '@/layers/shared/ui';
import { RightPanelHeader } from '@/layers/features/right-panel';
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
      <div className="relative flex flex-col items-center gap-1 border-b pb-0">
        <div className="relative z-10 w-full">
          <RightPanelHeader />
        </div>
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

  // Hub store path takes precedence; fall back to selected cwd.
  const hubAgentPath = useAgentHubStore((s) => s.agentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const agentPath = hubAgentPath ?? selectedCwd;

  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen);

  const { data: agent, isLoading } = useCurrentAgent(agentPath);
  const updateAgent = useUpdateAgent();

  // Hold previous agent visible while the next one loads to avoid blank flash.
  const previousAgentRef = useRef<{ agent: AgentManifest; path: string } | null>(null);
  if (agent && agentPath) {
    previousAgentRef.current = { agent, path: agentPath };
  }

  const togglePanel = useCallback((panel: 'avatar' | 'personality') => {
    setHeroPanel((prev) => (prev === panel ? null : panel));
  }, []);

  const closePanel = useCallback(() => setHeroPanel(null), []);

  // No path configured at all.
  if (!agentPath) {
    return <NoAgentSelected />;
  }

  // Derive display data: prefer fresh data, fall back to previous agent during load.
  const displayAgent = agent ?? previousAgentRef.current?.agent;
  const displayPath = agent ? agentPath : previousAgentRef.current?.path;
  const isFirstLoad = isLoading && !displayAgent;

  // First ever load with no cached data — show skeleton.
  if (isFirstLoad) {
    return <AgentHubSkeleton />;
  }

  // Path is set but the agent manifest could not be found (and no fallback).
  if (!displayAgent || !displayPath) {
    return <AgentNotFound agentPath={agentPath} />;
  }

  const contextValue = {
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
  };

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
