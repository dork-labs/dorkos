import { useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { useAppStore } from '@/layers/shared/model';
import { AgentHubProvider } from '../model/agent-hub-context';
import { useAgentHubStore } from '../model/agent-hub-store';
import { useAgentHubDeepLink, useAgentDialogRedirect } from '../model/use-agent-hub-deep-link';
import { AgentHubHeader } from './AgentHubHeader';
import { AgentHubNav } from './AgentHubNav';
import { AgentHubContent } from './AgentHubContent';
import { NoAgentSelected } from './NoAgentSelected';
import { AgentNotFound } from './AgentNotFound';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/**
 * Shell component for the Agent Hub right-panel contribution.
 *
 * Resolves the active agent path from the hub store (falling back to the
 * app store's selected cwd), fetches the agent manifest, and renders one
 * of three states:
 *
 * 1. No path set → `NoAgentSelected` empty state
 * 2. Path set but agent not found → `AgentNotFound` empty state
 * 3. Agent loaded → `AgentHubProvider` wrapping nav + content
 */
export function AgentHub() {
  // Sync new deep-link params (?panel=agent-hub&hubTab=...) into the store.
  useAgentHubDeepLink();
  // Redirect legacy ?agent=<tab>&agentPath=<path> to new format.
  useAgentDialogRedirect();

  // Hub store path takes precedence; fall back to selected cwd.
  const hubAgentPath = useAgentHubStore((s) => s.agentPath);
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const agentPath = hubAgentPath ?? selectedCwd;

  const { data: agent, isLoading } = useCurrentAgent(agentPath);
  const updateAgent = useUpdateAgent();

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
      // soulContent / nopeContent are file-level personality fields handled
      // separately by the personality tab component.
      const { soulContent: _soul, nopeContent: _nope, ...manifestUpdates } = updates;
      if (Object.keys(manifestUpdates).length > 0) {
        updateAgent.mutate({ path: agentPath, updates: manifestUpdates });
      }
    },
  };

  return (
    <AgentHubProvider value={contextValue}>
      <div data-slot="agent-hub" className="flex h-full flex-col overflow-hidden">
        <AgentHubHeader />
        <div className="flex flex-1 overflow-hidden">
          <AgentHubNav />
          <AgentHubContent />
        </div>
      </div>
    </AgentHubProvider>
  );
}
