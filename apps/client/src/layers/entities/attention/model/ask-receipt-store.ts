/**
 * How each recently answered prompt ended, so a card can morph into a receipt
 * instead of vanishing.
 *
 * The rule from the design screen is "never a button that does nothing": when an
 * Ask is answered — here, in another window, or by the clock — every copy of the
 * card says what happened before it leaves. The list of what is still WAITING
 * lives next door in {@link usePendingInteractions}; this holds the sentence a
 * card needs on its way out, for the second or so it is on screen.
 *
 * @module entities/attention/model/ask-receipt-store
 */
import { create } from 'zustand';
import type { InteractionOutcome } from '@dorkos/shared/interaction-events';

/**
 * How many endings are remembered at once.
 *
 * Bounded by count rather than by a timer, because the only reader is a card
 * that is already animating out — nothing needs one of these a minute later, and
 * a timer per receipt would be a scheduler for a fact nobody reads. Fifty is
 * more than any burst a person can answer in one gesture ("Allow all" over five
 * files is five) and small enough to be free.
 */
const RECEIPT_LIMIT = 50;

/** What one answered prompt left behind. */
export interface AskReceipt {
  /** How it ended. */
  outcome: InteractionOutcome;
  /** When, as the wire reported it — ISO, and the receipt prints the time from it. */
  resolvedAt: string;
  /** Who answered, when the server named somebody. */
  resolvedBy?: string;
  /**
   * Whether THIS window is the one that answered.
   *
   * The difference between "You allowed this" and "Already answered at 2:01" —
   * and it is not derivable from anything on the wire, because the event that
   * arrives is identical either way. Only the window that sent the answer knows.
   */
  byThisWindow: boolean;
  /**
   * What the person chose, when this window is the one that chose it. Absent for
   * every ending nobody chose, which is why "You allowed this" can never be
   * printed over an expiry.
   */
  decision?: 'allowed' | 'denied' | 'answered';
}

/** The receipts this window is holding, keyed by interaction id. */
interface AskReceiptState {
  /** Interaction id → how it ended. Capped at {@link RECEIPT_LIMIT}, oldest dropped. */
  receipts: Record<string, AskReceipt>;
  /** Insertion order, so the cap drops the oldest rather than an arbitrary key. */
  order: string[];
}

const useAskReceiptStore = create<AskReceiptState>(() => ({ receipts: {}, order: [] }));

/**
 * Record how one prompt ended.
 *
 * Called twice for the same id on the ordinary path — once optimistically by the
 * window that answered, once when `interaction_resolved` confirms it — and the
 * first write wins on the `byThisWindow` half, because the wire cannot tell the
 * window that acted from one that watched.
 *
 * @param interactionId - The prompt that ended.
 * @param receipt - How it ended.
 */
export function recordAskReceipt(interactionId: string, receipt: AskReceipt): void {
  useAskReceiptStore.setState((state) => {
    const existing = state.receipts[interactionId];
    const merged: AskReceipt = existing
      ? {
          ...receipt,
          byThisWindow: existing.byThisWindow || receipt.byThisWindow,
          ...(existing.decision ? { decision: existing.decision } : {}),
        }
      : receipt;
    const order = existing ? state.order : [...state.order, interactionId];
    const receipts = { ...state.receipts, [interactionId]: merged };
    if (order.length <= RECEIPT_LIMIT) return { receipts, order };
    const [oldest, ...rest] = order;
    delete receipts[oldest];
    return { receipts, order: rest };
  });
}

/**
 * How one prompt ended, or `undefined` while it is still waiting.
 *
 * @param interactionId - The prompt to ask about.
 */
export function useAskReceipt(interactionId: string): AskReceipt | undefined {
  return useAskReceiptStore((state) => state.receipts[interactionId]);
}

/** Forget every receipt. Test seam; nothing in the app calls it. */
export function clearAskReceipts(): void {
  useAskReceiptStore.setState({ receipts: {}, order: [] });
}
