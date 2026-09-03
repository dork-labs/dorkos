/**
 * What a ready-made agent will run on its own, asked for before it is created.
 *
 * @module features/agent-creation/model/use-offer-schedules
 */
import { usePermissionPreview } from '@/layers/entities/marketplace';
import type { CreationSeed } from '@/layers/shared/model';
import type { PreviewSchedule } from '@dorkos/shared/marketplace-schemas';

/** What {@link useOfferSchedules} found out about an offer's scheduled work. */
export interface OfferSchedules {
  /**
   * Every scheduled job the package ships, with the permission mode it will
   * ACTUALLY get — the server clamps a content-declared `bypassPermissions`
   * before the preview leaves it (`schedule-permission-clamp.ts`), so this is
   * what the job may do, not what its author asked for.
   */
  schedules: PreviewSchedule[];
  /** True while the answer is still in flight — the card knows nothing yet. */
  isChecking: boolean;
  /**
   * True when the check failed. "We could not find out" and "there is nothing
   * to find" are different things to tell someone about to create an agent, and
   * an empty list would render them identically.
   */
  failed: boolean;
}

/**
 * Ask what scheduled work a marketplace agent offer brings with it (DOR-644).
 *
 * An agent package is the one package type with no install confirmation dialog:
 * `useRequestInstall` routes it into the creation flow, so its arrival card is
 * the only place a person is told what they are about to turn on. The browse
 * listing the offer was built from carries no package contents, so the fact has
 * to be fetched — this is the same `POST /packages/:name/preview` the install
 * dialog reads, and the same TanStack Query key, so an offer reached through the
 * package detail sheet answers from cache.
 *
 * A Shape offer carries no `packageName` and there is nothing to fetch; the
 * query stays disabled and every field reads as "nothing scheduled".
 *
 * @param seed - The offer the creation dialog is showing, or `null` when closed.
 * @returns The offer's scheduled jobs, and whether the answer is known yet.
 */
export function useOfferSchedules(seed: CreationSeed | null): OfferSchedules {
  const packageName = seed?.packageName ?? null;
  const { data, isLoading, isError } = usePermissionPreview(packageName);

  return {
    schedules: data?.preview.schedules ?? [],
    isChecking: packageName !== null && isLoading,
    failed: packageName !== null && isError,
  };
}
