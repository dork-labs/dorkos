import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@dorkos/shared/types';

/**
 * App-store slice {@link switchAgentCwd} reads and writes. A structural subset
 * of the full store so the function stays decoupled and easy to test with a
 * small mock.
 */
export interface SwitchAgentCwdStore {
  /** The active working directory — recorded as the switch-back target. */
  selectedCwd: string | null;
  /** Persist the newly-selected working directory. */
  setSelectedCwd: (cwd: string) => void;
  /** Remember the directory being left, powering the palette's "switch back" hint. */
  setPreviousCwd: (cwd: string | null) => void;
}

/** Injected dependencies for {@link switchAgentCwd}. */
export interface SwitchAgentCwdDeps {
  /** App-store slice, e.g. `useAppStore.getState()` read fresh per call. */
  store: SwitchAgentCwdStore;
  /** Query client, read to reuse a cached session for the target directory. */
  queryClient: QueryClient;
  /**
   * Navigate to the `/session` route with the resolved directory + session.
   * Kept router-agnostic so the caller owns the route target and the function
   * stays trivially testable.
   */
  navigate: (search: { dir: string; session: string }) => void;
}

/**
 * Switch the cockpit's active agent to `cwd`.
 *
 * Mirrors the command palette's agent-select path (`handleAgentSelect` →
 * `setDir`): record the switch-back directory, persist the new working
 * directory, then navigate to `/session` reusing the most-recent cached session
 * for that directory (or a fresh UUID) so the URL always carries `?session=` (a
 * null session id resets the chat input). This is the seam the agent's
 * `control_ui switch_agent` command drives, so it lives as a plain function
 * callable from outside React.
 *
 * Frecency is intentionally not recorded here: an agent-issued switch carries
 * only a directory, not the user's explicit agent pick, so it must not reorder
 * the palette's "recent agents" ranking.
 *
 * @param cwd - The target agent's working directory (project path).
 * @param deps - Injected store, query client, and navigate callback.
 */
export function switchAgentCwd(cwd: string, deps: SwitchAgentCwdDeps): void {
  const { store, queryClient, navigate } = deps;
  // Track the directory we're leaving so the palette can offer "switch back".
  if (store.selectedCwd && store.selectedCwd !== cwd) {
    store.setPreviousCwd(store.selectedCwd);
  }
  store.setSelectedCwd(cwd);
  // Reuse the most-recent cached session for the target dir, or a fresh UUID —
  // mirrors useDirectoryState's setDir and the /session route loader.
  const cached = queryClient.getQueryData<Session[]>(['sessions', cwd]);
  const session = cached?.[0]?.id ?? crypto.randomUUID();
  navigate({ dir: cwd, session });
}
