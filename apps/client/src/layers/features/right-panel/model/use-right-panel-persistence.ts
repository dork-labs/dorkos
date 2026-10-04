import { useEffect, useRef } from 'react';
import { useAppStore, useIsBelowDesktop } from '@/layers/shared/model';
import { useDirectoryState } from '@/layers/entities/session';
import { useCurrentAgent } from '@/layers/entities/agent';

/**
 * Hydrate the global right panel layout from localStorage on mount.
 *
 * Restores the persisted open/closed state and active tab for the shell-level
 * right panel before any agent is in scope — the sensible initial layout for the
 * dashboard and other non-session routes. Below desktop width it restores the
 * tab only, so a reload never opens the sheet over the page. Per-agent layouts are bound separately
 * by {@link useRightPanelLayoutPersistence} on the session route.
 */
export function useRightPanelPersistence(): void {
  const loadRightPanelState = useAppStore((s) => s.loadRightPanelState);
  // Below desktop width the panel is a sheet over the page, so a reload brings
  // back its tab but not its open state. Captured once: this runs on mount only.
  const belowDesktop = useIsBelowDesktop();
  const restoreOpen = useRef(!belowDesktop);

  useEffect(() => {
    loadRightPanelState({ restoreOpen: restoreOpen.current });
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
 * An agent with no stored layout inherits the panel you are looking at
 * (DOR-2579) — on desktop only. Below desktop width the panel is a sheet over
 * the chat, so a switch there shows the chat you picked instead.
 *
 * Mounted on the session route only (its tabs are `/session`-scoped); on unmount
 * it detaches to the global layout so non-session routes keep the pre-DOR-227
 * global behavior.
 */
export function useRightPanelLayoutPersistence(): void {
  const [cwd] = useDirectoryState();
  const { data: agent, isPending } = useCurrentAgent(cwd);
  const loadRightPanelForAgent = useAppStore((s) => s.loadRightPanelForAgent);
  // Read through a ref: crossing the breakpoint is not an agent switch, so it
  // must not re-run the bind below. Synced in an effect declared before the
  // bind's, so the bind always reads the current value.
  const belowDesktop = useIsBelowDesktop();
  const belowDesktopRef = useRef(belowDesktop);
  useEffect(() => {
    belowDesktopRef.current = belowDesktop;
  }, [belowDesktop]);

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
    // The cwd travels with the key: a link that asked for the panel named a
    // DIRECTORY, and the key may be an agent id, so the store cannot tell on its
    // own whether a pending link was about the agent binding now.
    loadRightPanelForAgent(agentKey, cwd, { inherit: !belowDesktopRef.current });
  }, [agentKey, cwd, loadRightPanelForAgent]);

  // Detach to global scope when leaving the session route (stable dep → runs on
  // unmount only, not on every agentKey change).
  useEffect(() => {
    return () => loadRightPanelForAgent(null);
  }, [loadRightPanelForAgent]);
}
