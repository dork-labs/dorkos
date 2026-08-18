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
import type {
  InteractionOutcome,
  InteractionPendingEvent,
} from '@dorkos/shared/interaction-events';

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

/**
 * How long an answered card stays on screen holding its receipt.
 *
 * Long enough to read, and no longer. The card's own exit spends
 * `RESOLVE_HOLD_S + MELT_S` (0.6s) on the hold and the melt; this is that plus a
 * beat, so the sentence is still there while the animation runs and the row is
 * gone before anybody wonders whether it is still answerable.
 */
const SETTLE_MS = 1_200;

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
  /**
   * Prompts that have been answered and are still on screen saying so.
   *
   * The list of what is WAITING drops an answered prompt immediately — it is not
   * waiting any more, and the header's count must not claim it is. But a card
   * that vanished at the same instant would be exactly the disappearance the
   * design rules out ("never a button that does nothing"), so the envelope is
   * held here for {@link SETTLE_MS} and every surface draws it as a receipt.
   */
  settling: readonly InteractionPendingEvent[];
}

const useAskReceiptStore = create<AskReceiptState>(() => ({
  receipts: {},
  order: [],
  settling: [],
}));

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
 * Keep an answered prompt on screen long enough to say how it ended.
 *
 * Called by whichever half learns first — the window that answered, or the
 * resolution event from another one. A second call for the same id is a no-op,
 * so the card is not held twice as long by a race it did not cause.
 *
 * @param ask - The envelope the card was drawn from.
 */
export function settleAsk(ask: InteractionPendingEvent): void {
  const id = ask.interaction.id;
  const { settling } = useAskReceiptStore.getState();
  if (settling.some((held) => held.interaction.id === id)) return;
  useAskReceiptStore.setState({ settling: [...settling, ask] });
  setTimeout(() => {
    useAskReceiptStore.setState((state) => ({
      settling: state.settling.filter((held) => held.interaction.id !== id),
    }));
  }, SETTLE_MS);
}

/** The answered prompts still on screen saying so. */
export function useSettlingAsks(): readonly InteractionPendingEvent[] {
  return useAskReceiptStore((state) => state.settling);
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
  useAskReceiptStore.setState({ receipts: {}, order: [], settling: [] });
}
