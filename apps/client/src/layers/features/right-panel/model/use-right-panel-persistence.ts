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
 * Sentinel for "the agent lookup is still in flight — do not bind yet".
 * Distinct from `null`, which means "no agent context: detach to global".
 */
const KEY_PENDING = Symbol('right-panel-layout-key-pending');

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
 * The cwd fallback applies only once the agent lookup has SETTLED (resolved to
 * "no agent registered here", or errored). While the per-cwd query is still in
 * flight (a cold cache on first visit), binding is deferred entirely — keying by
 * cwd and then flipping to the agent id would hydrate twice, visibly flapping
 * the panel and discarding anything the user did in between.
 *
 * Mounted on the session route only (its tabs are `/session`-scoped); on unmount
 * it detaches to the global layout so non-session routes keep the pre-DOR-227
 * global behavior.
 */
export function useRightPanelLayoutPersistence(): void {
  const [cwd] = useDirectoryState();
  const { data: agent, isPending } = useCurrentAgent(cwd);
  const loadRightPanelForAgent = useAppStore((s) => s.loadRightPanelForAgent);

  // Identity chain: agent id when registered, else cwd — but only once the
  // lookup settled. (The query is disabled without a cwd, which TanStack
  // reports as pending, so the no-cwd detach must be decided first.)
  let agentKey: string | null | typeof KEY_PENDING;
  if (!cwd) {
    agentKey = null; // No agent context at all — stay on the global layout.
  } else if (isPending) {
    agentKey = KEY_PENDING; // Cold cache — defer, no bind and no key flap.
  } else {
    // Settled: registered agent id, else cwd (covers both "no agent here"
    // and a failed lookup — the cwd is still a stable identity).
    agentKey = agent?.id ?? cwd;
  }

  useEffect(() => {
    if (agentKey === KEY_PENDING) return;
    loadRightPanelForAgent(agentKey);
  }, [agentKey, loadRightPanelForAgent]);

  // Detach to global scope when leaving the session route (stable dep → runs on
  // unmount only, not on every agentKey change).
  useEffect(() => {
    return () => loadRightPanelForAgent(null);
  }, [loadRightPanelForAgent]);
}
