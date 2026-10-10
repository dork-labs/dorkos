/**
 * Whether managed remote access can be offered on this computer right now
 * (DOR-2086): one value, `hidden | available | unavailable`, that every remote
 * access surface and the setup route read.
 *
 * It is `available` only when all of these hold:
 *
 * 1. the `DORKOS_MANAGED_REMOTE` switch is on (off until the live supplier
 *    proof passes);
 * 2. this computer is linked, and the link captured for the check is still the
 *    current one when the answers come back;
 * 3. Cloud's session names this computer's instance id;
 * 4. the account's entitlement says remote access is `on_demand` or
 *    `always_available` (`byo` means Cloud does not offer it);
 * 5. `GET /v1/remote/status` answers.
 *
 * A switch that is off, no link, a `byo` entitlement, or a remote route Cloud
 * answers `404` (not deployed here) all read `hidden`: there is nothing to offer,
 * so nothing is shown. A Cloud that could not be reached, or a link Cloud no
 * longer recognises, reads `unavailable`: offered in principle, not right now.
 *
 * None of this ever gates the person's own ngrok tunnel, and reading it never
 * throws: a failure is an answer, not an error.
 *
 * ## Cached, and keyed to the link
 *
 * Answers are kept for {@link AVAILABILITY_TTL_MS} so every surface reading the
 * report does not cost a round trip each, and the read in flight is shared. An
 * answer is only reused while the link it was read under is still current
 * (`CloudV1Context.isCurrent()`), so an unlink or a relink drops it at once. A
 * `404` from the enrolment request route ({@link ManagedAvailability.markAbsent})
 * is kept longer, {@link ABSENT_TTL_MS}, because a service without the route
 * will not grow it in a minute.
 *
 * @module services/core/remote/managed-availability
 */
import {
  EntitlementsSchema,
  RemoteStatusSchema,
  V1_ROUTES,
  type RemoteStatus,
} from '@dork-labs/cloud-api';
import type { RemoteAccessAvailability } from '@dorkos/shared/types';

import { env } from '../../../env.js';
import {
  captureCloudV1Context,
  isAbsent,
  resolveCloudIdentity,
  type CloudIdentity,
  type CloudV1Context,
} from '../cloud/v1-client.js';

/** How long one availability answer is reused under the same link. */
export const AVAILABILITY_TTL_MS = 60_000;

/** How long a `404` from Cloud's remote routes keeps managed access hidden. */
export const ABSENT_TTL_MS = 10 * 60_000;

/** What one availability read found. Carries no secret. */
export interface AvailabilitySnapshot {
  /** Whether managed access can be offered. */
  availability: RemoteAccessAvailability;
  /** The instance id Cloud's session named, when it named one. */
  instanceId: string | null;
  /**
   * Cloud's last answer to `GET /v1/remote/status` under this link, or `null`
   * when it never answered. Kept through a later failed read, so the report can
   * show the last thing Cloud said and mark it stale.
   */
  cloudStatus: RemoteStatus | null;
  /** True when the latest read failed and {@link cloudStatus} is an older answer. */
  cloudStale: boolean;
}

/** What the availability check reads, injectable for tests. */
export interface ManagedAvailabilityDeps {
  /** Whether `DORKOS_MANAGED_REMOTE` is on. */
  flagOn?: () => boolean;
  /** Capture the current Cloud link, or `null` when unlinked. */
  captureContext?: () => CloudV1Context | null;
  /** Ask Cloud who the captured link belongs to. */
  resolveIdentity?: (context: CloudV1Context) => Promise<CloudIdentity>;
  /** The clock. */
  now?: () => number;
}

const HIDDEN: AvailabilitySnapshot = Object.freeze({
  availability: 'hidden',
  instanceId: null,
  cloudStatus: null,
  cloudStale: false,
}) as AvailabilitySnapshot;

interface Cached {
  context: CloudV1Context;
  snapshot: AvailabilitySnapshot;
  until: number;
}

/** The availability check. One per process: {@link managedAvailability}. */
export class ManagedAvailability {
  private readonly flagOn: () => boolean;
  private readonly captureContext: () => CloudV1Context | null;
  private readonly resolveIdentity: (context: CloudV1Context) => Promise<CloudIdentity>;
  private readonly now: () => number;
  private cached: Cached | undefined;
  private absent: { context: CloudV1Context; until: number } | undefined;
  private inFlight: { context: CloudV1Context; read: Promise<AvailabilitySnapshot> } | undefined;

  /**
   * Build the check.
   *
   * @param deps - Seams for tests; production uses the env switch and the live link.
   */
  constructor(deps: ManagedAvailabilityDeps = {}) {
    this.flagOn = deps.flagOn ?? (() => env.DORKOS_MANAGED_REMOTE);
    this.captureContext = deps.captureContext ?? captureCloudV1Context;
    this.resolveIdentity = deps.resolveIdentity ?? resolveCloudIdentity;
    this.now = deps.now ?? Date.now;
  }

  /** Whether the `DORKOS_MANAGED_REMOTE` switch is on. Nothing managed runs without it. */
  get enabled(): boolean {
    return this.flagOn();
  }

  /**
   * The last answer, without asking Cloud. `hidden` when the switch is off,
   * the computer is unlinked, or nothing has been read under the current link.
   */
  peek(): AvailabilitySnapshot {
    if (!this.flagOn()) return HIDDEN;
    const cached = this.cached;
    if (!cached || !cached.context.isCurrent()) return HIDDEN;
    if (this.isMarkedAbsent()) return HIDDEN;
    return cached.snapshot;
  }

  /**
   * Read availability, from the cache when it is fresh and the link unchanged.
   *
   * @param options.fresh - Ask Cloud even when a cached answer would do (the
   *   setup route does, so a person never starts setup on a stale yes).
   */
  async read(options: { fresh?: boolean } = {}): Promise<AvailabilitySnapshot> {
    if (!this.flagOn()) return HIDDEN;
    const context = this.captureContext();
    if (context === null) {
      this.cached = undefined;
      return HIDDEN;
    }
    if (this.isMarkedAbsent()) return HIDDEN;
    const cached = this.cached;
    if (!options.fresh && cached && cached.context.isCurrent() && cached.until > this.now()) {
      return cached.snapshot;
    }
    if (this.inFlight && this.inFlight.context.isCurrent()) return this.inFlight.read;
    const read = this.readUnder(context).finally(() => {
      if (this.inFlight?.read === read) this.inFlight = undefined;
    });
    this.inFlight = { context, read };
    return read;
  }

  /**
   * Record that Cloud answered a managed remote route `404` under the current
   * link: the service here does not offer it, so it reads `hidden` for
   * {@link ABSENT_TTL_MS}, or until the link changes.
   */
  markAbsent(): void {
    const context = this.captureContext();
    if (context === null) return;
    this.absent = { context, until: this.now() + ABSENT_TTL_MS };
    this.cached = undefined;
  }

  /** Forget every cached answer; the next read asks Cloud. */
  invalidate(): void {
    this.cached = undefined;
    this.absent = undefined;
  }

  private isMarkedAbsent(): boolean {
    const absent = this.absent;
    if (!absent) return false;
    if (!absent.context.isCurrent() || absent.until <= this.now()) {
      this.absent = undefined;
      return false;
    }
    return true;
  }

  private async readUnder(context: CloudV1Context): Promise<AvailabilitySnapshot> {
    const previous = this.cached?.context.isCurrent() ? this.cached.snapshot : undefined;
    const { snapshot, absent } = await this.ask(context, previous);
    // An answer read under a link that ended meanwhile is about that link,
    // not this one: say nothing rather than something about the wrong link.
    if (!context.isCurrent()) return HIDDEN;
    if (absent) this.absent = { context, until: this.now() + ABSENT_TTL_MS };
    this.cached = { context, snapshot, until: this.now() + AVAILABILITY_TTL_MS };
    return snapshot;
  }

  /** One round of questions to Cloud. `absent` when a route answered `404`. */
  private async ask(
    context: CloudV1Context,
    previous: AvailabilitySnapshot | undefined
  ): Promise<{ snapshot: AvailabilitySnapshot; absent: boolean }> {
    const hidden = (absent: boolean) => ({ snapshot: { ...HIDDEN }, absent });
    // A failed read keeps the last thing Cloud said, marked stale.
    const unavailable = (instanceId: string | null) => ({
      snapshot: {
        availability: 'unavailable' as const,
        instanceId,
        cloudStatus: previous?.cloudStatus ?? null,
        cloudStale: previous?.cloudStatus != null,
      },
      absent: false,
    });

    let identity: CloudIdentity;
    try {
      identity = await this.resolveIdentity(context);
    } catch (error) {
      return isAbsent(error) ? hidden(true) : unavailable(null);
    }
    const instanceId = identity.instanceId;
    if (instanceId === null) return unavailable(null);

    try {
      const entitlements = await context.client.get(V1_ROUTES.entitlements, EntitlementsSchema);
      if (entitlements.limits.remoteAccess === 'byo') return hidden(false);
    } catch (error) {
      return isAbsent(error) ? hidden(true) : unavailable(instanceId);
    }

    try {
      const status = await context.client.get(V1_ROUTES.remoteStatus, RemoteStatusSchema, {
        query: { instanceId },
      });
      // An answer about another instance is not an answer about this one.
      if (status.instanceId !== undefined && status.instanceId !== instanceId) {
        return unavailable(instanceId);
      }
      return {
        snapshot: { availability: 'available', instanceId, cloudStatus: status, cloudStale: false },
        absent: false,
      };
    } catch (error) {
      return isAbsent(error) ? hidden(true) : unavailable(instanceId);
    }
  }
}

/** The process's availability check, read by the report and the setup route. */
export const managedAvailability = new ManagedAvailability();
