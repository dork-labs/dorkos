/**
 * State for the status-bar runtime chip (spec additional-agent-runtimes, 1.7).
 *
 * Owns the three questions the chip asks:
 *
 * 1. **Has the session started?** Same signal the submit hook gates its
 *    first-turn runtime hint on (`isNewSession` in use-session-submit): the
 *    session's presence in the `['sessions', cwd]` list cache — flipped
 *    instantly by the optimistic insert on first send and kept server-true
 *    thereafter by `session_upserted` broadcasts. Id presence can NOT stand in
 *    for this: the route loader mints `?session=<uuid>` before any message
 *    exists, so `sessionId` is truthy in every pre-first-message state.
 * 2. **Which runtime to display?** Once started, the session row's runtime —
 *    server-authoritative and live-updated, so the chip is correct immediately
 *    after the first send binds the session (no infer-on-miss / stale-cache
 *    trap). Before that, the pending `?runtime=` selection, falling back to
 *    the server default.
 * 3. **Where does a selection go?** Shared app-store state (`pendingRuntime`)
 *    for display plus a best-effort `?runtime=` URL write, which the first send
 *    reads as the runtime hint. The shared store — not per-instance local state
 *    — is what keeps every `useRuntimeChip` consumer in lockstep: the status
 *    bar's chip and ChatPanel's command-palette query resolve the same runtime
 *    the instant a selection changes, with no URL round-trip and no divergence.
 *    Mirrors how `selectedCwd`/`useDirectoryState` share the working directory.
 *
 * @module features/chat/model/status/use-runtime-chip
 */
import { useCallback, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessions } from '@/layers/entities/session';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';

/**
 * Read the `?runtime=` search param straight from the URL. Deliberately not
 * `useSearch` — that hook requires a mounted TanStack router and would crash
 * embedded mode (Obsidian renders ChatPanel with no RouterProvider).
 */
function readRuntimeParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('runtime');
  } catch {
    return null;
  }
}

/** Runtime-chip state consumed by ChatStatusSection. */
export interface RuntimeChipState {
  /**
   * Runtime type the chip displays, or `null` when it should not render —
   * while the capability map / session list are loading, started-ness cannot
   * be told apart from "brand new" and any affordance shown would risk being
   * wrong (a dropdown on a started session, a lock tooltip on a new one).
   */
  runtime: string | null;
  /**
   * The started session's resolved model id (server-authoritative, from its
   * list row), or `null` when unknown — pre-launch, or a runtime that has not
   * reported a model. Pairs with `runtime` to render identity as runtime + model
   * (spec decision 8); a null model degrades the chip to the runtime alone.
   */
  model: string | null;
  /** False once the session has started — runtime is immutable (ADR-0255). */
  canSelect: boolean;
  /** Apply a pre-launch selection (updates display state and the URL). */
  onChangeRuntime: (type: string) => void;
}

/**
 * Resolve the status-bar runtime chip's display state for a session.
 *
 * @param sessionId - Active session id (may be a loader-minted UUID with no
 *   messages yet; empty string when no session context exists).
 */
export function useRuntimeChip(sessionId: string): RuntimeChipState {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { sessions: sessionList, isLoading: sessionListLoading } = useSessions();
  const sessionRow = sessionId ? (sessionList.find((s) => s.id === sessionId) ?? null) : null;
  const hasStarted = sessionRow !== null;
  const startednessKnown = hasStarted || (!sessionListLoading && selectedCwd !== null);

  // Pending pre-launch selection, shared via the app store so both this hook's
  // consumers (status-bar chip + command palette) resolve one value. A selection
  // belongs only to the session it was made in, so clear it whenever the active
  // session changes (switch, agent launch, or the first send binding the
  // canonical id); the new session then resolves from its own ?runtime= param.
  // Effect — never a render-time external-store write, which would update the
  // sibling consumer mid-render.
  const { data: runtimeCaps } = useRuntimeCapabilities();
  const pendingRuntime = useAppStore((s) => s.pendingRuntime);
  const setPendingRuntime = useAppStore((s) => s.setPendingRuntime);
  useEffect(() => {
    setPendingRuntime(null);
  }, [sessionId, setPendingRuntime]);

  // The in-session chip override (shared, reactive) wins; otherwise the
  // ?runtime= launch param read straight off the URL — identical for every
  // consumer and router-free, so it never crashes embedded mode.
  const pendingSelection = pendingRuntime ?? readRuntimeParam();
  const resolved = sessionRow?.runtime ?? pendingSelection ?? runtimeCaps?.defaultRuntime ?? null;

  const navigate = useNavigate();
  const onChangeRuntime = useCallback(
    (type: string) => {
      // Write the shared store first so every consumer re-renders on the same
      // value this tick; the URL write below is the durable/hint channel the
      // first send reads. Embedded mode has no router — the store alone drives
      // the chip there.
      setPendingRuntime(type);
      if (!getPlatform().isEmbedded) {
        void navigate({
          search: (prev: Record<string, unknown>) => ({ ...prev, runtime: type }) as never,
          replace: true,
        });
      }
    },
    [navigate, setPendingRuntime]
  );

  return {
    runtime: startednessKnown ? resolved : null,
    // Identity pairs the runtime with the started session's resolved model. Only
    // a listed session carries a model; pre-launch it stays null so the chip
    // shows the runtime alone (honest — no invented model).
    model: sessionRow?.model ?? null,
    canSelect: !hasStarted,
    onChangeRuntime,
  };
}
