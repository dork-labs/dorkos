/**
 * Clear the app store's `explicitAgentPath` when the agent it points at no
 * longer exists, so a deleted agent's Agent Profile tab disappears off /session
 * instead of lingering on a stale selection.
 *
 * @module entities/agent/model/use-reconcile-explicit-agent-path
 */
import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useCurrentAgent } from './use-current-agent';

/**
 * Reconcile the explicitly-opened agent path against agent existence.
 *
 * The sibling of {@link useSyncCurrentAgentId}: where that mirrors the ambient
 * cwd's agent id forward, this heals the click-driven `explicitAgentPath` latch
 * backward. When the operator opens an agent to inspect (Agent Hub → `openHub`),
 * the path is stored and the Agent Profile tab is gated on it off /session. If
 * that agent is later deleted, resolving the path yields no manifest — this hook
 * then clears the field, so the tab is removed rather than rendering
 * `AgentNotFound` forever. Otherwise the selection stays sticky for the session
 * (founder-accepted), exactly as before.
 *
 * Reuses {@link useCurrentAgent} (transport `getAgentByPath`), so it works under
 * both transports. It clears ONLY on a *successfully resolved* "no agent here"
 * (`isSuccess && data === null`) — gating on `isSuccess` (not merely "not
 * loading") means a still-pending query or a transient transport error never
 * clears the field: an error leaves it sticky and a refetch re-opens the tab.
 * Runs as a side-effecting hook; mount it once in a host that owns the app
 * lifetime, beside {@link useSyncCurrentAgentId}.
 */
export function useReconcileExplicitAgentPath(): void {
  const explicitAgentPath = useAppStore((s) => s.explicitAgentPath);
  const setExplicitAgentPath = useAppStore((s) => s.setExplicitAgentPath);
  const { data: agent, isSuccess } = useCurrentAgent(explicitAgentPath);

  useEffect(() => {
    if (explicitAgentPath != null && isSuccess && agent === null) {
      setExplicitAgentPath(null);
    }
  }, [explicitAgentPath, agent, isSuccess, setExplicitAgentPath]);
}
