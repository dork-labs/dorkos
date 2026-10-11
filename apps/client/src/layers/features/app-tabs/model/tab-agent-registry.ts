/**
 * Which agent each open chat tab is with, so two tabs on one agent can tell
 * each other apart (DOR-2820 "smart names").
 *
 * Each tab registers its own agent while it is mounted; a tab is "sharing"
 * when any other mounted tab registered the same one. It lives beside the tabs
 * rather than in the tab store because it is derived, live data: the agent is
 * resolved from the chat, not saved with the tab.
 *
 * @module features/app-tabs/model/tab-agent-registry
 */
import { useCallback, useEffect, useId } from 'react';
import { create } from 'zustand';

interface TabAgentRegistry {
  /** Mounted tab instance → the agent it is with. */
  agents: Readonly<Record<string, string>>;
}

const useTabAgentRegistry = create<TabAgentRegistry>()(() => ({ agents: {} }));

/**
 * Register this tab's agent and report whether another open tab shares it.
 *
 * @param agentKey - The agent this tab's chat is with, or nothing for a tab
 *   that is not a chat (it registers nothing).
 * @returns Whether another mounted tab is with the same agent.
 */
export function useSharesAgentWithAnotherTab(agentKey: string | undefined): boolean {
  const instance = useId();

  useEffect(() => {
    if (!agentKey) return;
    useTabAgentRegistry.setState((state) => ({
      agents: { ...state.agents, [instance]: agentKey },
    }));
    return () => {
      useTabAgentRegistry.setState((state) => {
        const next = { ...state.agents };
        delete next[instance];
        return { agents: next };
      });
    };
  }, [instance, agentKey]);

  return useTabAgentRegistry(
    useCallback(
      (state) =>
        agentKey !== undefined &&
        Object.entries(state.agents).some(([id, key]) => id !== instance && key === agentKey),
      [instance, agentKey]
    )
  );
}
