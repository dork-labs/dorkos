/**
 * Visibility + dispatch for the proactive compaction chip (DOR-112): a quiet,
 * one-click nudge shown in the chat status area once a session's context
 * usage nears the ceiling — turning the passive `ContextItem` percentage into
 * a timely action.
 *
 * @module features/chat/model/status/use-compaction-chip
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import { dispatchCompactIntent } from '../native-commands';

/**
 * Context-usage percent at which the compaction chip appears. Deliberately
 * the same ~80% point `ContextItem` (`apps/client/src/layers/features/status/
 * ui/ContextItem.tsx`) turns its badge amber — the DOR-112 spec's "context
 * usage fraction ≥ 0.8" is where context pressure starts costing turn quality
 * and latency, so the warning color and the one-click fix agree on what
 * "nearly full" means. Kept as a local constant (not imported from the status
 * feature) per this codebase's convention against cross-feature model
 * imports; if the amber threshold ever moves, move this one too.
 */
export const COMPACTION_CHIP_THRESHOLD_PERCENT = 80;

/** Inputs that decide whether the compaction chip should render. */
export interface CompactionChipVisibilityInput {
  /**
   * The displayed context-usage percent (0-100) — resolved the same way
   * `ContextItem` resolves it (SDK breakdown when available, else the
   * client's coarser estimate), so the two surfaces never disagree. `null`
   * before the first context reading arrives.
   */
  percent: number | null;
  /**
   * Whether the active runtime supports the `compact` command intent, per
   * `compactComposerGate` semantics: `true` while capabilities are still
   * loading (optimistic — the composer gate treats a loading caps map the
   * same way), `false` only once the runtime explicitly declares it
   * unsupported.
   */
  compactSupported: boolean;
  /**
   * Whether a turn is currently streaming. Dispatching `/compact` mid-turn
   * would 409 (`SESSION_LOCKED`) — the chip hides rather than show and rely
   * on the 409 toast, the cleaner of the two options (DOR-112 requirement 1).
   */
  isStreaming: boolean;
}

/**
 * Pure visibility rule for the compaction chip — unit-testable without React.
 * All three conditions must hold: usage at/above the threshold, the runtime
 * can fulfill compact, and no turn is currently streaming.
 *
 * @param input - The current context percent, compact support, and streaming state.
 */
export function shouldShowCompactionChip({
  percent,
  compactSupported,
  isStreaming,
}: CompactionChipVisibilityInput): boolean {
  if (percent === null) return false;
  if (percent < COMPACTION_CHIP_THRESHOLD_PERCENT) return false;
  if (!compactSupported) return false;
  if (isStreaming) return false;
  return true;
}

/** Inputs to {@link useCompactionChip}. */
export interface UseCompactionChipOptions extends CompactionChipVisibilityInput {
  /** Target session id for the dispatch. */
  sessionId: string;
}

/** Compaction-chip state consumed by {@link import('../../ui/status/CompactionChip').CompactionChip}. */
export interface CompactionChipState {
  /** Whether the chip should render at all. */
  visible: boolean;
  /** The percent to show in the copy. Only meaningful when `visible`. */
  percent: number;
  /**
   * True from the moment the chip is clicked until either the compact turn's
   * own streaming state takes over (which hides the chip entirely via
   * `visible`) or the dispatch fails. Guards against a double-dispatch in the
   * brief window before the session stream reflects the new turn — compact
   * intents don't set the `triggerPending` flag `postMessage` does, so
   * `isStreaming` alone cannot cover that window.
   */
  pending: boolean;
  /** Fire the compact intent — exactly the palette's `/compact` dispatch. */
  onCompact: () => void;
}

/**
 * Resolve the compaction chip's visibility and own its click dispatch. Reuses
 * the chat session's existing `isStreaming` signal to know when the compact
 * turn has taken over (no bespoke `/events` stream handling here) and the
 * shared {@link dispatchCompactIntent} helper so a failed click shows the
 * exact same toast as the `/compact` palette entry.
 *
 * @param options - Session id plus the current visibility inputs.
 */
export function useCompactionChip({
  sessionId,
  percent,
  compactSupported,
  isStreaming,
}: UseCompactionChipOptions): CompactionChipState {
  const transport = useTransport();
  const [pending, setPending] = useState(false);
  // Mirrors `pending` but read/written synchronously, so two clicks fired in
  // the same tick (a fast double-click) can't both slip past the `pending`
  // state check before React commits the first one's update.
  const pendingRef = useRef(false);

  // Reset the local guard the instant `isStreaming` flips true — the stream
  // taking over is itself proof the dispatch "arrived". The chip is already
  // hidden the instant `isStreaming` flips true (via `visible` below), so
  // this has no visible effect beyond keeping `pending` honest for the next
  // time it becomes relevant (e.g. a turn that starts but the compaction
  // itself later fails, leaving usage over threshold with the chip due back).
  useEffect(() => {
    if (isStreaming) {
      pendingRef.current = false;
      setPending(false);
    }
  }, [isStreaming]);

  const onCompact = useCallback(() => {
    if (pendingRef.current || !sessionId) return;
    pendingRef.current = true;
    setPending(true);
    void dispatchCompactIntent(transport, sessionId).then((accepted) => {
      // Only a failed dispatch re-enables the chip here — a successful one is
      // about to be superseded by `isStreaming` flipping true, which hides it.
      if (!accepted) {
        pendingRef.current = false;
        setPending(false);
      }
    });
  }, [sessionId, transport]);

  return {
    visible: shouldShowCompactionChip({ percent, compactSupported, isStreaming }),
    percent: percent ?? 0,
    pending,
    onCompact,
  };
}
