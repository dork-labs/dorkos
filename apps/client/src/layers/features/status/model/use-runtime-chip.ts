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
import { useCallback, useEffect } from 'react';
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
  //
  // The override counts only for the session it was MADE in. The store is a
  // module global that outlives any mount, so an unkeyed read would let a draft
  // session's pick decide what the next conversation runs on.
  const ownPick = pendingRuntime?.sessionId === sessionId ? pendingRuntime.type : null;
  const pendingSelection = ownPick ?? readRuntimeParam();
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
 * A selection belongs to the session it was made in, and says so: it is stored
 * as a {@link PendingLaunchPick} carrying that session's id, so no other session
 * can read it and a remount of the same one keeps it. The effect below only
 * sweeps up a pick the operator has left behind.
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

  // Effect — never a render-time external-store write, which would update the
  // sibling consumer mid-render.
  //
  // Housekeeping, NOT the safety property. Every reader already ignores a pick
  // belonging to another session (`PendingLaunchPick`), so leaving one behind
  // could not leak into this conversation; this just drops what has become
  // litter once the operator has moved on. That ordering matters: a rule
  // enforced by the data cannot be undone by a mount that does not happen, which
  // is exactly how the earlier clear-on-mount and clear-on-transition attempts
  // each broke in one direction or the other.
  //
  // Read through selectors rather than `getState()`: this hook renders under
  // surfaces whose tests supply a hand-written store, and a snapshot read would
  // demand a shape they have no reason to provide. Subscribing is also what makes
  // the sweep react to a pick that arrives after mount.
  const heldRuntime = useAppStore((s) => s.pendingRuntime);
  const heldAccount = useAppStore((s) => s.pendingAccount);
  useEffect(() => {
    const foreign = (pick: { sessionId: string } | null | undefined) =>
      pick != null && pick.sessionId !== sessionId;
    if (foreign(heldRuntime)) setPendingRuntime(null);
    if (foreign(heldAccount)) setPendingAccount(null);
  }, [sessionId, heldRuntime, heldAccount, setPendingRuntime, setPendingAccount]);

  const inPlaceNavigate = useInPlaceNavigate();
  const onChangeRuntime = useCallback(
    (type: string) => {
      // Write the shared store first so every consumer re-renders on the same
      // value this tick; the URL write below is the durable/hint channel the
      // first send reads. The chip rewrites `?runtime=` on the session already on
      // screen, so it goes in place — a lookup in flight must not read it as a
      // departure (DOR-931). `null` in embedded mode, which has no router — the
      // store alone drives the chip there.
      setPendingRuntime({ type, sessionId });
      inPlaceNavigate?.({
        search: (prev: Record<string, unknown>) => ({ ...prev, runtime: type }),
        replace: true,
      });
    },
    [inPlaceNavigate, setPendingRuntime, sessionId]
  );

  return { ...resolved, onChangeRuntime };
}
