/**
 * What a ready-made agent will run on its own, asked for before it is created.
 *
 * @module features/agent-creation/model/use-offer-schedules
 */
import { isPreviewRefusal, usePermissionPreview } from '@/layers/entities/marketplace';
import type { CreationSeed } from '@/layers/shared/model';
import type { DisclosedEffects, PreviewSchedule } from '@dorkos/shared/marketplace-schemas';

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
  /**
   * The server's refusal, when it would not preview the package because its
   * package checks refused it (DOR-2314). A refused package is one the server
   * will not install, so the creation flow must not create an agent from it:
   * `failed` alone is a check that could not be made, which does not block.
   */
  refusal?: unknown;
  /**
   * What the person was shown, for creating the agent through the marketplace
   * installer (DOR-2325): the install is held to this disclosure and these
   * files. Present once the preview answered.
   */
  approval?: { approvedDisclosure: DisclosedEffects; approvedContentHash: string };
  /**
   * The package's own name, which is the folder a marketplace agent lives in
   * (`agents/<name>`), so the card can say where it lands.
   */
  packageAgentName?: string;
}

/** The marketplace package an offer is, when it is one. */
export type OfferPackage = Pick<CreationSeed, 'packageName' | 'marketplace'>;

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
export function useOfferSchedules(seed: OfferPackage | null): OfferSchedules {
  const packageName = seed?.packageName ?? null;
  const { data, isError, error } = usePermissionPreview(
    packageName,
    seed?.marketplace ? { marketplace: seed.marketplace } : undefined
  );

  return {
    // Optional through `preview` as well as `data`: a 200 whose body is missing
    // the key would otherwise throw inside a hook, taking the dialog down rather
    // than degrading to "not checked". `InstallConfirmationDialog` guards the
    // same read the same way.
    schedules: data?.preview?.schedules ?? [],
    // Deliberately NOT `isLoading`. That is `isPending && isFetching`, and a
    // query can be pending without fetching — TanStack pauses one while the
    // persisted cache restores, and pauses it again on any future networkMode
    // that can pause. Every paused state reported `isLoading: false` with no
    // data, which opened the gate and rendered "nothing scheduled" for a package
    // nobody had asked the server about yet. Asking whether the ANSWER is here
    // cannot go wrong that way: no data and no error means we still do not know.
    // (Same class of bug as `use-onboarding-restoring.test.tsx` pins.)
    isChecking: packageName !== null && data === undefined && !isError,
    failed: packageName !== null && isError,
    ...(packageName !== null && isError && isPreviewRefusal(error) && { refusal: error }),
    ...(data?.disclosed && data.contentHash
      ? {
          approval: { approvedDisclosure: data.disclosed, approvedContentHash: data.contentHash },
          packageAgentName: data.manifest.name,
        }
      : {}),
  };
}
