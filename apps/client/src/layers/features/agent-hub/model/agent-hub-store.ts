import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAppStore } from '@/layers/shared/model';

export type AgentHubTab = 'sessions' | 'config' | 'toolkit';

interface AgentHubState {
  activeTab: AgentHubTab;
  setActiveTab: (tab: AgentHubTab) => void;
  agentPath: string | null;
  setAgentPath: (path: string | null) => void;
  openHub: (agentPath: string, tab?: AgentHubTab) => void;
}

export const useAgentHubStore = create<AgentHubState>()(
  devtools(
    (set) => ({
      activeTab: 'sessions',
      setActiveTab: (tab) => set({ activeTab: tab }),
      agentPath: null,
      // Both writers below are explicit, click/deep-link-driven selections, so
      // they publish the picked path to the app store's `explicitAgentPath` — the
      // honest signal the right-panel visibility predicates read across the
      // feature boundary (they can't import this feature store). See that field's
      // docs for why the ambient `selectedCwd` is not a truthful stand-in.
      setAgentPath: (path) => {
        set({ agentPath: path });
        useAppStore.getState().setExplicitAgentPath(path);
      },
      openHub: (agentPath, tab) => {
        set({ agentPath, activeTab: tab ?? 'sessions' });
        useAppStore.getState().setExplicitAgentPath(agentPath);
      },
    }),
    { name: 'agent-hub' }
  )
);
