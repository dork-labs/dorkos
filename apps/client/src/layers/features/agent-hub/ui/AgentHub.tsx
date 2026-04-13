import { useState, useCallback } from 'react';
import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { useAppStore } from '@/layers/shared/model';
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

/**
 * Shell component for the Agent Hub right-panel contribution.
 *
 * Layout: Hero (sticky) -> TabBar | Picker header -> TabContent | Picker body.
 * When a hero element is clicked (avatar or personality badge), the tab area
 * is replaced by a full-width inline picker panel.
 */
export function AgentHub() {
  useAgentHubDeepLink();
  useAgentDialogRedirect();

  const [heroPanel, setHeroPanel] = useState<HeroPanel>(null);

  // Hub store path takes precedence; fall back to selected cwd.
  const hubAgentPath = useAgentHubStore((s) => s.agentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const agentPath = hubAgentPath ?? selectedCwd;

  const { data: agent, isLoading } = useCurrentAgent(agentPath);
  const updateAgent = useUpdateAgent();

  const togglePanel = useCallback((panel: 'avatar' | 'personality') => {
    setHeroPanel((prev) => (prev === panel ? null : panel));
  }, []);

  const closePanel = useCallback(() => setHeroPanel(null), []);

  // No path configured at all.
  if (!agentPath) {
    return <NoAgentSelected />;
  }

  // Still loading — render nothing to avoid flash.
  if (isLoading) {
    return null;
  }

  // Path is set but the agent manifest could not be found.
  if (!agent) {
    return <AgentNotFound agentPath={agentPath} />;
  }

  const contextValue = {
    agent,
    projectPath: agentPath,
    onUpdate: (updates: Partial<AgentManifest>) => updateAgent.mutate({ path: agentPath, updates }),
    onPersonalityUpdate: (
      updates: Partial<AgentManifest> & { soulContent?: string; nopeContent?: string }
    ) => {
      const { soulContent: _soul, nopeContent: _nope, ...manifestUpdates } = updates;
      if (Object.keys(manifestUpdates).length > 0) {
        updateAgent.mutate({ path: agentPath, updates: manifestUpdates });
      }
    },
  };

  return (
    <AgentHubProvider value={contextValue}>
      <div data-slot="agent-hub" className="flex h-full flex-col overflow-hidden">
        <AgentHubHero
          onAvatarClick={() => togglePanel('avatar')}
          onPersonalityClick={() => togglePanel('personality')}
        />
        {heroPanel === null ? (
          <>
            <AgentHubTabBar />
            <AgentHubTabContent />
          </>
        ) : heroPanel === 'avatar' ? (
          <AvatarPickerPanel onClose={closePanel} />
        ) : (
          <PersonalityPickerPanel onClose={closePanel} />
        )}
      </div>
    </AgentHubProvider>
  );
}
