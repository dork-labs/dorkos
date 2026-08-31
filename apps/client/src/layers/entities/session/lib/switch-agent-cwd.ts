import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { resolveSessionForCwd, notifySessionLookupFailed } from './resolve-session-for-cwd';
import { beginSessionNavigation, type CockpitLocation } from './session-navigation-intent';

/**
 * App-store slice {@link switchAgentCwd} reads and writes. A structural subset
 * of the full store so the function stays decoupled and easy to test with a
 * small mock.
 */
export interface SwitchAgentCwdStore {
  /** Persist the newly-selected working directory. */
  setSelectedCwd: (cwd: string) => void;
}

/** Injected dependencies for {@link switchAgentCwd}. */
export interface SwitchAgentCwdDeps {
  /** App-store slice, e.g. `useAppStore.getState()` read fresh per call. */
  store: SwitchAgentCwdStore;
  /** Query client, read to reuse a known session for the target directory. */
  queryClient: QueryClient;
  /** Transport, used to ask the server which session that directory is on. */
  transport: Transport;
  /**
   * Reads the router's current location, e.g. `() => router.state.location`. A
   * switch whose lookup comes back to a different destination has been
   * overtaken and must not land.
   */
  currentLocation: () => CockpitLocation;
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
 * `setDir`): resolve which conversation that directory is on, then persist the
 * new working directory and navigate to `/session` carrying it (a null session
 * id resets the chat input). This is the seam the agent's `control_ui
 * switch_agent` command drives, so it lives as a plain function callable from
 * outside React.
 *
 * **Nothing is committed until the destination is known.** The chat stream is
 * keyed on (session id, selected cwd), so writing the new cwd while the lookup
 * is still out would attach the OLD session id under the NEW directory — and
 * the server resolves a transcript from `?cwd=`, so that pairing reads the
 * wrong project. A failed lookup therefore moves nothing at all, and a lookup
 * overtaken by a later click does nothing either.
 *
 * Frecency is intentionally not recorded here: an agent-issued switch carries
 * only a directory, not the user's explicit agent pick, so it must not reorder
 * the palette's "recent agents" ranking.
 *
 * @param cwd - The target agent's working directory (project path).
 * @param deps - Injected store, query client, transport, location reader, and
 *   navigate callback.
 */
export async function switchAgentCwd(cwd: string, deps: SwitchAgentCwdDeps): Promise<void> {
  const { store, queryClient, transport, currentLocation, navigate } = deps;
  const isStillWanted = beginSessionNavigation(currentLocation);

  const resolved = await resolveSessionForCwd({ queryClient, transport }, cwd);
  // Overtaken checks FIRST: an abandoned switch has nothing to say. Reporting a
  // failure the person has already navigated away from would tell them we left
  // them where they are while they are somewhere else.
  if (!isStillWanted()) return;
  if (resolved === null) {
    notifySessionLookupFailed(cwd);
    return;
  }

  store.setSelectedCwd(cwd);
  navigate({ dir: cwd, session: resolved.sessionId });
}
