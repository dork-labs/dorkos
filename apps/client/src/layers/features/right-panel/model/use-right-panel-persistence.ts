import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useCurrentAgent } from '@/layers/entities/agent';

/**
 * Hydrate the global right panel layout from localStorage on mount.
 *
 * Restores the persisted open/closed state and active tab for the shell-level
 * right panel before any agent is in scope — the sensible initial layout for the
 * dashboard and other non-session routes. Per-agent layouts are bound separately
 * by {@link useRightPanelLayoutPersistence} on the session route.
 */
export function useRightPanelPersistence(): void {
  const loadRightPanelState = useAppStore((s) => s.loadRightPanelState);

  useEffect(() => {
    loadRightPanelState();
  }, [loadRightPanelState]);
}

/**
 * Bind the right panel to the current agent and persist its layout per-agent.
 *
 * Resolves the active agent's stable identity — its registered agent id, or its
 * working directory (cwd) as a fallback when no agent is registered there — and
 * hydrates the panel's open/active-tab layout from that agent's stored entry
 * whenever the identity changes. Toggling the panel or picking a tab writes back
 * under the same key (handled in the store actions), so returning to an agent
 * restores exactly how you left its panel.
 *
 * Mounted on the session route only (its tabs are `/session`-scoped); on unmount
 * it detaches to the global layout so non-session routes keep the pre-DOR-227
 * global behavior.
 */
export function useRightPanelLayoutPersistence(): void {
  const [cwd] = useDirectoryState();
  const { data: agent } = useCurrentAgent(cwd);
  const loadRightPanelForAgent = useAppStore((s) => s.loadRightPanelForAgent);

  // Identity chain: agent id when registered, else cwd. Null only before any
  // directory resolves, in which case the global layout stays in effect.
  const agentKey = agent?.id ?? cwd ?? null;

  useEffect(() => {
    loadRightPanelForAgent(agentKey);
  }, [agentKey, loadRightPanelForAgent]);

  // Detach to global scope when leaving the session route (stable dep → runs on
  // unmount only, not on every agentKey change).
  useEffect(() => {
    return () => loadRightPanelForAgent(null);
  }, [loadRightPanelForAgent]);
}
