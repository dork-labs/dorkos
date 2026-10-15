/**
 * What one space's server understands beyond the version 1 contract, read with
 * `GET /api/v1/features` and remembered for a while (DOR-2878).
 *
 * @module services/communities/remote/availability/space-features
 */
import {
  CommunityWireSpaceFeaturesResponseSchema,
  type CommunityWireSpaceFeaturesResponse,
} from '@dorkos/shared/community-wire';
import { PinnedHttpError } from '../pinned-origin.js';

/** One feature a space may have. */
export type SpaceFeature = keyof CommunityWireSpaceFeaturesResponse['features'];

/** How long a space's answer is kept, either way: a space gains a feature only by an upgrade. */
export const SPACE_FEATURES_TTL_MS = 10 * 60_000;
/** How long a failed read counts as "none" before the next call asks again. */
export const SPACE_FEATURES_RETRY_MS = 60_000;

/**
 * One space's features, read at most once per {@link SPACE_FEATURES_TTL_MS}.
 *
 * A space from before the read answers `404`, which means none, quietly: an old space is not an
 * error. Any other failure also reads as none, so nothing new is ever tried against a space this
 * app cannot confirm, and is asked again after {@link SPACE_FEATURES_RETRY_MS}.
 */
export class SpaceFeatures {
  private known: {
    features: CommunityWireSpaceFeaturesResponse['features'];
    until: number;
  } | null = null;
  private reading: Promise<CommunityWireSpaceFeaturesResponse['features']> | null = null;

  /**
   * Keep one space's features.
   *
   * @param read - Read `GET /api/v1/features` from the space; throws {@link PinnedHttpError}.
   * @param now - The clock, in milliseconds.
   */
  constructor(
    private readonly read: () => Promise<unknown>,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether the space says it has this feature. Never throws. */
  async has(feature: SpaceFeature): Promise<boolean> {
    if (!this.known || this.known.until <= this.now()) {
      this.reading ??= this.load().finally(() => {
        this.reading = null;
      });
      await this.reading;
    }
    return this.known?.features[feature] === true;
  }

  /** Forget the answer, so the next call asks the space again (after it refused a feature). */
  forget(): void {
    this.known = null;
  }

  private async load(): Promise<CommunityWireSpaceFeaturesResponse['features']> {
    try {
      const { features } = CommunityWireSpaceFeaturesResponseSchema.parse(await this.read());
      this.known = { features, until: this.now() + SPACE_FEATURES_TTL_MS };
    } catch (error) {
      const absent = error instanceof PinnedHttpError && error.status === 404;
      this.known = {
        features: {},
        until: this.now() + (absent ? SPACE_FEATURES_TTL_MS : SPACE_FEATURES_RETRY_MS),
      };
    }
    return this.known.features;
  }
}
