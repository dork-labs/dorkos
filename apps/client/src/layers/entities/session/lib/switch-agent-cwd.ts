import type { EffectOwner } from '@/layers/shared/lib';
import { newSessionTarget } from '@/layers/shared/lib';
import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { resolveSessionForCwd, notifySessionLookupFailed } from './resolve-session-for-cwd';
import { beginSessionNavigation, type AppLocation } from './session-navigation-intent';

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
  /** Exact originating extension occurrence; user actions omit it. */
  effectOwner?: EffectOwner;
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
  currentLocation: () => AppLocation;
  /**
   * Navigate to the `/session` route with the resolved directory + session.
   * Kept router-agnostic so the caller owns the route target and the function
   * stays trivially testable.
   */
  navigate: (search: { dir?: string; session?: string; draft?: '1'; launchRef?: string }) => void;
}

/**
 * Switch the app's active agent to `cwd`.
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
  const originalOwner = deps.effectOwner;
  const isStillWanted = beginSessionNavigation(currentLocation);
  const owner = originalOwner
    ? Object.freeze({
        beforeEffect: () => {
          const wanted = isStillWanted();
          originalOwner.beforeEffect();
          if (!wanted) throw new Error('Extension navigation was superseded.');
        },
      })
    : undefined;
  owner?.beforeEffect();

  const resolved = await resolveSessionForCwd({ queryClient, transport, effectOwner: owner }, cwd);
  // Overtaken checks FIRST: an abandoned switch has nothing to say. Reporting a
  // failure the person has already navigated away from would tell them we left
  // them where they are while they are somewhere else.
  const wanted = isStillWanted();
  owner?.beforeEffect();
  if (!wanted) return;
  if (resolved === null) {
    notifySessionLookupFailed(cwd, owner);
    return;
  }

  const target = resolved.isNew
    ? await newSessionTarget(transport, { dir: cwd, session: resolved.sessionId }, owner)
    : { search: { session: resolved.sessionId } };
  const stillWanted = isStillWanted();
  const setCwd = store.setSelectedCwd;
  owner?.beforeEffect();
  if (!stillWanted) return;
  Reflect.apply(setCwd, store, [cwd]);
  const search = target.search;
  owner?.beforeEffect();
  Reflect.apply(navigate, deps, [search]);
}
