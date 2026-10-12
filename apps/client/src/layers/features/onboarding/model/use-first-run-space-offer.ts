/**
 * Whether the first run's offer to join the official DorkOS space is due (spec
 * `official-community-space` item 5, DOR-2873).
 *
 * The offer follows a first run that set up an AI, on either path: "Continue
 * without an account" lands on a welcome that asks for AI first, and the
 * community can wait for Settings. Past that, the offer's own rules decide: an
 * official space is configured, this install has no connection to it, and Not
 * now was never chosen.
 *
 * Two surfaces read this, never at once: the Getting started card while it
 * shows, and the sidebar's bottom slot while that card is held back.
 *
 * @module features/onboarding/model/use-first-run-space-offer
 */
import { useOfficialSpaceOffer } from '@/layers/entities/community';
import { useOnboarding } from './use-onboarding';

/** Whether the first run's community offer should be on screen somewhere. */
export function useFirstRunSpaceOffer(): boolean {
  const { firstRunPath } = useOnboarding().state;
  const { offered } = useOfficialSpaceOffer();
  return (firstRunPath === 'dorkos' || firstRunPath === 'own') && offered;
}
