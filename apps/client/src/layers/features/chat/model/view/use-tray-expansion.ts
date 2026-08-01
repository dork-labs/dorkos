/**
 * How a reader has arranged one turn's chip tray — held outside the row that
 * the turn's end remounts.
 *
 * @module features/chat/model/view/use-tray-expansion
 */
import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import type { MessagePart } from '@dorkos/shared/types';
import type { TouchChipVerb } from '../../lib/touch-chips';

/** How the roster is sorted: grouped by what happened, or in the order it happened. */
export type ChipOrder = 'grouped' | 'chronological';

/** Everything a reader can set about one turn's tray. */
export interface TrayView {
  /** Whether the tray is open. */
  expanded: boolean;
  /** The verb the roster is narrowed to, or `null` for all of it. */
  verbFilter: TouchChipVerb | null;
  /** The order the roster is listed in. */
  order: ChipOrder;
}

/** A tray nobody has touched: shut, unfiltered, grouped. */
const DEFAULT_VIEW: TrayView = { expanded: false, verbFilter: null, order: 'grouped' };

/** The trays a reader has arranged, one entry per turn they touched. */
interface TrayExpansionState {
  /** Views by tray key. A turn nobody has touched is simply absent. */
  views: Record<string, TrayView>;
  /**
   * Change one turn's tray.
   *
   * @param key - The turn's identity, from {@link trayExpansionKey}.
   * @param patch - The fields to change; the rest keep the values they had.
   */
  update: (key: string, patch: Partial<TrayView>) => void;
}

/**
 * Every tray the reader has arranged, keyed by turn.
 *
 * What this survives is a REMOUNT — the turn ending and swapping its id, a
 * route change and back, the virtualizer recycling a row. What it does not
 * survive is the tab: nothing here is written to disk, so a reload starts every
 * tray shut, unfiltered and grouped. The key scopes it per session, so two
 * sessions never share a tray. There is no eviction because there is nothing to
 * evict: an entry appears only where a person clicked, so this holds as many
 * trays as one reader arranged in one sitting.
 *
 * Exported for tests, which reset it between cases the way a fresh tab starts.
 * Nothing else should reach for it: {@link useTrayExpansion} is the whole API.
 */
export const useTrayExpansionStore = create<TrayExpansionState>((set) => ({
  views: {},
  update: (key, patch) =>
    set((state) => ({
      views: { ...state.views, [key]: { ...(state.views[key] ?? DEFAULT_VIEW), ...patch } },
    })),
}));

/**
 * The identity a turn's tray is filed under: its FIRST tool call.
 *
 * The obvious identity — the message's id — is the one thing that cannot be
 * used, because it is what changes. A running turn renders under a synthetic id
 * (`__in_progress_turn__`); the moment it finishes, the reconcile swaps the
 * whole projection for canonical history and the same turn reappears under its
 * real id. The message list keys rows by that id, so React tears the row down
 * and builds it again at exactly the moment the strip settles — and a tray the
 * reader had opened, filtered and sorted was destroyed by the turn finishing
 * (DOR-827).
 *
 * A tool call's id survives that swap untouched: it is the model's own id for
 * the call, streamed live and then written into the transcript, so both sides of
 * the swap name it identically. The FIRST one is used because it is the one part
 * of a growing turn that never changes — later calls are still arriving.
 *
 * The session scopes it. Tool ids are unique in practice, but a fixture or a
 * test-mode runtime may well reuse one, and two sessions sharing a tray is a
 * confusing thing to debug.
 *
 * @param sessionId - The session the turn belongs to.
 * @param parts - The turn's parts, in transcript order.
 * @returns A key that is stable for the life of the turn.
 */
export function trayExpansionKey(sessionId: string, parts: readonly MessagePart[]): string {
  // There is always one when a strip is on screen: `accumulateTouchChips` folds
  // chips only from `tool_call` parts, and a turn with no chips renders no strip.
  const firstToolCall = parts.find((part) => part.type === 'tool_call');
  return `${sessionId}:${firstToolCall?.toolCallId ?? ''}`;
}

/** One turn's tray as it currently stands, and the ways to change it. */
export interface TrayViewHandle extends TrayView {
  /** Open a shut tray, or shut an open one. */
  toggleExpanded: () => void;
  /** Narrow the roster to one verb, or back to all of it with `null`. */
  setVerbFilter: (verb: TouchChipVerb | null) => void;
  /** List the roster grouped by verb, or in the order it happened. */
  setOrder: (order: ChipOrder) => void;
}

/**
 * Read and change one turn's tray, by a key that outlives its row.
 *
 * @param key - The turn's identity, from {@link trayExpansionKey}.
 * @returns The tray's current arrangement, and the setters for it.
 */
export function useTrayExpansion(key: string): TrayViewHandle {
  const stored = useTrayExpansionStore((state) => state.views[key]);
  const update = useTrayExpansionStore((state) => state.update);
  const view = stored ?? DEFAULT_VIEW;

  // Read through `getState` rather than closing over `view`: the toggle must
  // flip whatever is stored at the moment it is pressed, not whatever this
  // render saw.
  const toggleExpanded = useCallback(
    () => update(key, { expanded: !useTrayExpansionStore.getState().views[key]?.expanded }),
    [key, update]
  );
  const setVerbFilter = useCallback(
    (verbFilter: TouchChipVerb | null) => update(key, { verbFilter }),
    [key, update]
  );
  const setOrder = useCallback((order: ChipOrder) => update(key, { order }), [key, update]);

  return useMemo(
    () => ({ ...view, toggleExpanded, setVerbFilter, setOrder }),
    [view, toggleExpanded, setVerbFilter, setOrder]
  );
}
