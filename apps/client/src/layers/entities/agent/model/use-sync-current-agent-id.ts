/**
 * Keep the app store's `currentAgentId` in sync with the agent registered at
 * the selected working directory.
 *
 * @module entities/agent/model/use-sync-current-agent-id
 */
import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useCurrentAgent } from './use-current-agent';

/**
 * Resolve the selected cwd's agent and mirror its id into the app store, so
 * synchronous readers (the extension host, visibility predicates) can tell
 * which agent is active without re-fetching.
 */
export function useSyncCurrentAgentId(): void {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const setCurrentAgentId = useAppStore((s) => s.setCurrentAgentId);
  const { data: agent } = useCurrentAgent(selectedCwd);

  useEffect(() => {
    setCurrentAgentId(agent?.id ?? null);
  }, [agent?.id, setCurrentAgentId]);
}
