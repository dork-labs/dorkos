/**
 * The DorkOS credits offer every surface that hits a gap leads with (spec
 * `dorkos-account-by-default` §3).
 *
 * A widget because it composes two features no feature may import together:
 * the one link flow (`features/cloud-link`) and what the account can spend
 * (`features/cloud-plan`). The app shell supplies {@link renderCreditsOffer}
 * through `CreditsOfferProvider` in `shared/model`, so a runtime's connect
 * step, the chat's auth-error card and the banners can draw it without
 * reaching up a layer.
 *
 * @module widgets/credits-offer
 */
export { CreditsOfferCard, renderCreditsOffer } from './ui/CreditsOfferCard';
export { creditsVerb, type CreditsVerb } from './lib/credits-verb';
