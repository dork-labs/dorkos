/**
 * State for the status-bar runtime chip (spec additional-agent-runtimes, 1.7).
 *
 * Owns the three questions the chip asks:
 *
 * 1. **Has the session started?** Same signal the submit hook gates its
 *    first-turn runtime hint on (`isNewSession` in use-session-submit): the
 *    session's presence in the session-list cache — flipped
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
 * Split in two on purpose. {@link useResolvedSessionRuntime} answers questions 1
 * and 2 and is a PURE READ — no effects, no router — so any number of surfaces
 * (the chip, the Session readout, the Session panel) can ask them without side
 * effects. {@link useRuntimeChip} adds question 3: the selection action, and the
 * one effect that clears a stale pending selection when the session changes. That
 * effect belongs to the chip alone; a read-only consumer that ran it would wipe a
 * pre-launch runtime choice just by mounting.
 *
 * @module features/status/model/use-runtime-chip
 */
import { useCallback, useEffect, useRef } from 'react';
import { useAppStore, useInPlaceNavigate } from '@/layers/shared/model';
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

/** What a read-only consumer can know about a session's runtime. */
export interface ResolvedSessionRuntime {
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
}

/** Runtime-chip state consumed by ChatStatusSection — a resolution plus its action. */
export interface RuntimeChipState extends ResolvedSessionRuntime {
  /** Apply a pre-launch selection (updates display state and the URL). */
  onChangeRuntime: (type: string) => void;
}

/**
 * Resolve which runtime owns a session, and its resolved model id — read-only.
 *
 * The single resolution every runtime-aware surface reads, so the chip, the
 * Session panel, and the Session readout can never disagree about which runtime
 * a session runs on. Deliberately free of effects and of the router: a readout
 * that mounts later must observe the pending pre-launch selection, never disturb
 * it (see {@link useRuntimeChip}).
 *
 * @param sessionId - Active session id (may be a loader-minted UUID with no
 *   messages yet; empty string when no session context exists).
 */
export function useResolvedSessionRuntime(sessionId: string): ResolvedSessionRuntime {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const { sessions: sessionList, isLoading: sessionListLoading } = useSessions();
  const sessionRow = sessionId ? (sessionList.find((s) => s.id === sessionId) ?? null) : null;
  const hasStarted = sessionRow !== null;
  const startednessKnown = hasStarted || (!sessionListLoading && selectedCwd !== null);

  // Pending pre-launch selection, shared via the app store so every consumer
  // resolves one value.
  const { data: runtimeCaps } = useRuntimeCapabilities();
  const pendingRuntime = useAppStore((s) => s.pendingRuntime);

  // The in-session chip override (shared, reactive) wins; otherwise the
  // ?runtime= launch param read straight off the URL — identical for every
  // consumer and router-free, so it never crashes embedded mode.
  const pendingSelection = pendingRuntime ?? readRuntimeParam();
  const resolved = sessionRow?.runtime ?? pendingSelection ?? runtimeCaps?.defaultRuntime ?? null;

  return {
    runtime: startednessKnown ? resolved : null,
    // Identity pairs the runtime with the started session's resolved model. Only
    // a listed session carries a model; pre-launch it stays null so the chip
    // shows the runtime alone (honest — no invented model).
    model: sessionRow?.model ?? null,
    canSelect: !hasStarted,
  };
}

/**
 * The status-bar runtime chip: {@link useResolvedSessionRuntime} plus the
 * selection action, and the one effect that discards a stale pending selection.
 *
 * A selection belongs to the session it was made in, so the effect clears it on
 * an OBSERVED session change (switch, agent launch, or the first send binding the
 * canonical id); the new session then resolves from its own `?runtime=` param.
 * Mounting clears nothing — see the effect for why that distinction is what
 * protects a billing pick.
 *
 * Prefer {@link useResolvedSessionRuntime} in a read-only consumer regardless:
 * this hook's extra work is the selection action, which a readout has no use for.
 *
 * @param sessionId - Active session id (see {@link useResolvedSessionRuntime}).
 */
export function useRuntimeChip(sessionId: string): RuntimeChipState {
  const resolved = useResolvedSessionRuntime(sessionId);
  const setPendingRuntime = useAppStore((s) => s.setPendingRuntime);
  const setPendingAccount = useAppStore((s) => s.setPendingAccount);

  /**
   * The last session id this instance actually observed. `undefined` means it
   * has observed none yet, which is the mount pass.
   */
  const observedSessionId = useRef<string | undefined>(undefined);

  // Effect — never a render-time external-store write, which would update the
  // sibling consumer mid-render.
  //
  // Both pre-launch picks the chip owns are cleared together. The account hint
  // especially: it decides whose subscription a turn spends, and a pick that
  // survived into the NEXT session would bill work the person never chose it
  // for. "This session only" is the promise the menu makes; this is where it is
  // kept.
  //
  // **A TRANSITION clears; a mount does not.** The hook's contract says one
  // owner, but two surfaces call it today (ChatPanel and ChatStatusSection), so
  // a clear-on-mount discards whatever the other one is holding the moment
  // either remounts — a person's billing pick deleted by a re-render they never
  // asked for. Keying on an observed change makes the rule what it always meant:
  // the pick belongs to the session it was made in, and only leaving that
  // session ends it.
  useEffect(() => {
    const previous = observedSessionId.current;
    observedSessionId.current = sessionId;
    if (previous === undefined || previous === sessionId) return;
    setPendingRuntime(null);
    setPendingAccount(null);
  }, [sessionId, setPendingRuntime, setPendingAccount]);

  const inPlaceNavigate = useInPlaceNavigate();
  const onChangeRuntime = useCallback(
    (type: string) => {
      // Write the shared store first so every consumer re-renders on the same
      // value this tick; the URL write below is the durable/hint channel the
      // first send reads. The chip rewrites `?runtime=` on the session already on
      // screen, so it goes in place — a lookup in flight must not read it as a
      // departure (DOR-931). `null` in embedded mode, which has no router — the
      // store alone drives the chip there.
      setPendingRuntime(type);
      inPlaceNavigate?.({
        search: (prev: Record<string, unknown>) => ({ ...prev, runtime: type }),
        replace: true,
      });
    },
    [inPlaceNavigate, setPendingRuntime]
  );

  return { ...resolved, onChangeRuntime };
}
