/**
 * The slot through which every surface that hits a gap offers DorkOS credits
 * first (spec `dorkos-account-by-default` §3, the default-first pattern).
 *
 * The offer needs three slices no feature may import together: the one link
 * flow (`features/cloud-link`), what the account can buy or spend
 * (`features/cloud-plan`) and the runtime's own state. So the card is composed
 * one layer up, in `widgets/credits-offer`, and the app shell hands it down
 * through this context. A surface asks {@link useCreditsOfferSlot} for it and
 * calls it where its default belongs; with no provider (a unit test, the Dev
 * Playground) the slot is `null` and the surface shows only its other ways.
 *
 * Deciding WHETHER to offer stays with the surface (`useRuntimeCreditsOffer` in
 * `entities/runtime`): only where the runtime has no working sign-in and the
 * server reports credits wired for it. The slot only draws the offer.
 *
 * @module shared/model/credits-offer/credits-offer-slot
 */
import { createContext, useContext, type ReactNode } from 'react';

/** What a surface hands the credits offer. */
export interface CreditsOfferProps {
  /** The runtime the offer is for (`'claude-code'`). */
  runtime: string;
  /**
   * The surface drawing the offer (`'runtime-connect:claude-code'`), so a link
   * it starts can tell its own code from one another surface started.
   */
  origin: string;
  /**
   * What the button offers: `start` to run on credits where nothing works yet
   * (its words come from the account: "Try…", "Buy…", "Use…"), or
   * `keep-going` once the runtime's own sign-in is out of usage.
   */
  intent?: 'start' | 'keep-going';
  /**
   * What choosing credits does once this computer is linked. Omitted, it puts
   * the runtime's new work on credits by default, recorded as the person's
   * choice. When the person was signed out it runs once the code THIS offer
   * started is approved, and only while the offer is still on screen — or,
   * with {@link CreditsOfferProps.confirmAfterLink}, only when they say so.
   */
  onChoose?: () => unknown;
  /**
   * For a choice that spends at once (sending a turn again, continuing a
   * session): after the link lands, ask instead of acting. `prompt` is the
   * question ("Linked. Send again on DorkOS credits?"), `action` its button.
   */
  confirmAfterLink?: { prompt: string; action: string };
  /** One plain line under the button saying what choosing it changes. */
  note?: string;
  /** What the offer says once the choice is made, in place of the button. */
  chosen?: string;
  /** Draw the button full width, for a surface whose other ways are full-width rows. */
  fullWidth?: boolean;
}

/**
 * What the app shell supplies: a render function rather than a component, the
 * same shape as `RuntimeConnectSlot`, so a surface calls it where its default
 * belongs and never mints a component during render.
 */
export type CreditsOfferSlot = (props: CreditsOfferProps) => ReactNode;

const CreditsOfferContext = createContext<CreditsOfferSlot | null>(null);

/**
 * Supply the credits offer to everything below. Mounted once, by the app shell.
 *
 * @param props.slot - Draws the offer (`CreditsOfferCard` from `widgets/credits-offer`).
 * @param props.children - The app.
 */
export function CreditsOfferProvider({
  slot,
  children,
}: {
  slot: CreditsOfferSlot;
  children: ReactNode;
}) {
  return <CreditsOfferContext.Provider value={slot}>{children}</CreditsOfferContext.Provider>;
}

/** The credits offer's renderer the app shell supplied, or `null` where none was. */
export function useCreditsOfferSlot(): CreditsOfferSlot | null {
  return useContext(CreditsOfferContext);
}
