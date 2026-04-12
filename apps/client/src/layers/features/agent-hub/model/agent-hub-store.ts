import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type AgentHubTab = 'overview' | 'personality' | 'sessions' | 'channels' | 'tasks' | 'tools';

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
      activeTab: 'overview',
      setActiveTab: (tab) => set({ activeTab: tab }),
      agentPath: null,
      setAgentPath: (path) => set({ agentPath: path }),
      openHub: (agentPath, tab) =>
        set({
          agentPath,
          activeTab: tab ?? 'overview',
        }),
    }),
    { name: 'agent-hub' }
  )
);
