import { Banner } from '@/layers/shared/ui';

export interface MemoryProviderBenchedBannerProps {
  /** The id `memory.provider` names — the backend DorkOS is not actually using. */
  configuredId: string;
  /**
   * Whether the mismatch is a runtime fault (benched) rather than a backend
   * that was never registered in the first place. Drives which sentence
   * renders — see the component doc for why the two need different words.
   */
  benched: boolean;
}

/**
 * The standing note for a configured memory backend DorkOS is not actually
 * using — because it faulted and got benched, or because it never registered
 * at all.
 *
 * ## Why this exists
 *
 * The server registry's quarantine-and-fallback design (`services/memory/
 * registry.ts`) is correct on its own terms: a memory backend that faults is
 * benched for the rest of the process, `builtin` takes over silently, and a
 * turn never dies over a notes file. But "silently" is exactly the problem for
 * a person watching — an agent whose configured backend is down starts reading
 * `builtin`'s own empty file, which looks identical to amnesia unless
 * something says otherwise. This is that something.
 *
 * ## Why the trigger is `configuredId !== activeId`, not `benched`
 *
 * `benched` alone misses the likeliest real-world cause: `memory.provider` set
 * to a typo, or a backend module that failed to call `registerMemoryProvider`
 * at all. Neither is a fault the registry ever sees — there is nothing to
 * bench — so `benched` stays `false` and the id nonetheless never serves a
 * single call. `configuredId !== activeId` catches both: the registry always
 * knows what actually answered, whether or not it knows why the configured one
 * did not.
 *
 * ## Why the copy still branches on `benched`
 *
 * The two causes want different verbs. "Stopped answering" is true of a
 * backend that built and then faulted — reads as "something broke, maybe
 * temporarily." Saying that about an id nothing ever registered would be
 * false and would send an operator looking for an outage that was never
 * there; "isn't installed or didn't register" is the honest words for that
 * case instead.
 *
 * ## Why it names the backend but not the raw failure
 *
 * `configuredId` is what an operator chose and can act on (restart, check
 * their own service, fix the id). The underlying error is a short, capped
 * string in `GET /api/system/memory`'s `benchReason` for anyone reading the
 * API directly, but it never reaches this banner — a raw exception message is
 * not written for a person to read on screen, the same reason a runtime's
 * Connect action never surfaces one either.
 *
 * ## Why it cannot be dismissed
 *
 * The condition is standing, not an announcement: true until the process
 * restarts (or, for the unregistered case, until the config or the backend is
 * fixed and DorkOS restarts). Nothing on this surface can fix it from here —
 * there is no settings page for `memory.provider` yet — so the honest move is
 * to keep saying it rather than let it be dismissed into silence.
 *
 * @param configuredId - The backend `memory.provider` names.
 * @param benched - Whether the backend faulted at runtime, versus never having
 *   registered at all.
 */
export function MemoryProviderBenchedBanner({
  configuredId,
  benched,
}: MemoryProviderBenchedBannerProps) {
  return (
    <Banner variant="warning">
      The <span className="font-medium">{configuredId}</span> memory backend{' '}
      {benched ? 'stopped answering' : "isn't installed or didn't register"}. DorkOS switched to its
      own local memory until you restart.
    </Banner>
  );
}
