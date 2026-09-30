/**
 * The one-time "Next time, trust everything from <source>?" offers this window
 * holds (spec `flow-multiproject` §9.3, V9).
 *
 * The server hands an offer back only to the app that turned the extension on
 * (the approve response's `trustOffer`), and stores nothing, so it shows once
 * and only here: never on another device, never in a push. It goes away when
 * the person answers it, dismisses it, closes the bell, or after
 * {@link TRUST_OFFER_TTL_MS}.
 *
 * Kept self-contained so the generic follow-up offer machinery of the inbox
 * (spec §7.8) can absorb it later: an offer is only an extension id, a source,
 * and when it was made.
 *
 * @module entities/extension/model/trust-offer-store
 */
import { create } from 'zustand';

/** How long an unanswered offer stays offered. */
export const TRUST_OFFER_TTL_MS = 15 * 60_000;

/**
 * How far apart the offer and the history row it sits under may be. The row is
 * written by the server as the approval lands, so the two are seconds apart; a
 * row from an older approval of the same extension never carries the offer.
 */
export const TRUST_OFFER_ROW_WINDOW_MS = 60_000;

/** One offer, made right after a person turned an extension on here. */
export interface TrustOffer {
  /** The extension that was turned on. */
  extensionId: string;
  /** The exact `owner/repo` "Yes" trusts. */
  source: string;
  /** When it was offered, epoch ms. */
  offeredAt: number;
}

interface TrustOfferState {
  /** Offers by extension id. */
  offers: Record<string, TrustOffer>;
  /** Offer to trust `source`, after turning `extensionId` on. */
  offer: (extensionId: string, source: string) => void;
  /** Take one offer away: answered, dismissed, or gone stale. */
  withdraw: (extensionId: string) => void;
  /** Take every offer away, as closing the bell does. */
  withdrawAll: () => void;
}

/** The store behind {@link useTrustOfferFor}. */
export const useTrustOfferStore = create<TrustOfferState>((set, get) => ({
  offers: {},
  offer: (extensionId, source) => {
    const offeredAt = Date.now();
    set((state) => ({
      offers: { ...state.offers, [extensionId]: { extensionId, source, offeredAt } },
    }));
    // Unanswered, it goes on its own. Only this offer: a newer one for the
    // same extension keeps its own clock.
    setTimeout(() => {
      if (get().offers[extensionId]?.offeredAt === offeredAt) get().withdraw(extensionId);
    }, TRUST_OFFER_TTL_MS);
  },
  withdraw: (extensionId) =>
    set((state) => {
      if (!(extensionId in state.offers)) return state;
      const offers = { ...state.offers };
      delete offers[extensionId];
      return { offers };
    }),
  withdrawAll: () => set((state) => (Object.keys(state.offers).length ? { offers: {} } : state)),
}));

/**
 * The offer for the history row of one approval, or null. Expiry is the
 * store's job (it withdraws an offer after {@link TRUST_OFFER_TTL_MS}), so this
 * stays pure.
 *
 * @param offers - The offers this window holds.
 * @param extensionId - The extension the row is about.
 * @param answeredAt - When the row was written (ISO), so only the row for
 *   this approval carries the offer.
 */
export function selectTrustOffer(
  offers: Record<string, TrustOffer>,
  extensionId: string | undefined,
  answeredAt: string
): TrustOffer | null {
  if (!extensionId) return null;
  const offer = offers[extensionId];
  if (!offer) return null;
  const rowAt = Date.parse(answeredAt);
  if (Number.isNaN(rowAt) || Math.abs(rowAt - offer.offeredAt) > TRUST_OFFER_ROW_WINDOW_MS) {
    return null;
  }
  return offer;
}

/**
 * The live offer for one approval's history row, or null.
 *
 * @param extensionId - The extension the row is about.
 * @param answeredAt - When the row was written (ISO).
 */
export function useTrustOfferFor(
  extensionId: string | undefined,
  answeredAt: string
): TrustOffer | null {
  const offers = useTrustOfferStore((state) => state.offers);
  return selectTrustOffer(offers, extensionId, answeredAt);
}
