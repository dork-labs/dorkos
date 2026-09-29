/**
 * Which runs boot the marketing-site webServer leg, and which specs need it.
 *
 * The site leg (`next dev` for `apps/site`) is the heaviest leg and the only one
 * that has timed out in the merge queue: `Timed out waiting 242000ms from
 * config.webServer` failed 8 of the first 120 six-shard queue builds,
 * 2026-09-27 20:32Z to 2026-09-28 07:08Z (DOR-2360, ledger
 * `ci/ledger/260928-075416-site-leg-one-shard.md`). Only the two spec files in
 * {@link SITE_SPEC_FILES} use it, yet every shard booted it, so every shard
 * paid its boot time and every shard was one more chance for it to stall.
 *
 * So a sharded run boots it on exactly one shard, {@link SITE_SHARD}, and the
 * balanced-shard reporter pins those two files to that shard. Every shard still
 * COLLECTS the site specs, which is what keeps the duration-balanced cut
 * identical on every runner (`reporters/balanced-shard.ts` explains why that is
 * the correctness property); the reporter then excludes them everywhere but
 * the site shard.
 *
 * @module site-leg
 */

/**
 * Spec files, relative to `tests/`, whose `baseURL` is the marketing site.
 *
 * `__tests__/site-leg.test.ts` scans `tests/` for specs that point at the site
 * and fails if this list and that scan disagree, so a new site spec cannot
 * land on a shard without the leg.
 */
export const SITE_SPEC_FILES = ['features.spec.ts', 'marketplace.spec.ts'] as const;

/** The Playwright project the site specs run in. */
export const SITE_PROJECT = 'chromium';

/** The one shard of a sharded run that boots the site leg and runs its specs. */
export const SITE_SHARD = 1;

/** What a run does about the site leg. */
export interface SitePlan {
  /** Collect the site specs at all (every shard of a sharded CI run does). */
  specs: boolean;
  /** Boot the site leg in this process. */
  leg: boolean;
}

/** The inputs {@link planSiteLeg} decides from. */
export interface SitePlanInput {
  /** Whether this is a CI run. */
  ci: boolean;
  /** `E2E_SITE`: `'1'` forces the site on, `'0'` forces it off. */
  site: string | undefined;
  /** How many shards the suite is cut into (`E2E_SHARD_TOTAL`, default 1). */
  shardTotal: number;
  /** `E2E_SHARD_INDEX`, which shard this is; required when `shardTotal > 1`. */
  shardIndex: string | undefined;
}

/**
 * Decide whether this run collects the site specs and whether it boots the leg.
 *
 * Unsharded (`shardTotal` 1, every local run): the leg boots exactly when the
 * specs run, as it always has. Sharded: every shard collects the specs, and only
 * {@link SITE_SHARD} boots the leg. A sharded run that does not say which shard
 * it is throws rather than guessing, because guessing wrong puts two site specs
 * on a shard with nothing listening on the site port.
 *
 * @param input - The run's flags; see {@link SitePlanInput}.
 */
export function planSiteLeg(input: SitePlanInput): SitePlan {
  const specs = input.site === '1' || (input.ci && input.site !== '0');
  if (!specs || input.shardTotal === 1) return { specs, leg: specs };
  const index = input.shardIndex;
  if (index === undefined || !/^[1-9]\d*$/.test(index) || Number(index) > input.shardTotal) {
    throw new Error(
      `E2E_SHARD_INDEX must name this shard (1..${input.shardTotal}) when E2E_SHARD_TOTAL is ${input.shardTotal}, ` +
        `got ${JSON.stringify(index)}. The site leg boots on shard ${SITE_SHARD} only, so a shard that does not know ` +
        `its index cannot know whether to boot it.`
    );
  }
  return { specs, leg: Number(index) === SITE_SHARD };
}
