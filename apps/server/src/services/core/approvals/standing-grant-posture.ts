/**
 * Keep standing permissions from outliving the posture that justified them
 * (spec `agent-approval-settings` §3.0, §3.7).
 *
 * Two settings license a standing permission to exist: `auth.enabled`, because a
 * session cookie is the only thing that tells the person in the cockpit from an
 * agent on the same machine, and `approvals.standingGrants`, the master switch.
 * When either is switched off, every live permission ends immediately.
 *
 * The alternative — leaving rows dormant and honoring them again if the setting
 * comes back — is the thing this module exists to prevent. A permission granted
 * while login was on would wake up under a posture that can no longer justify it,
 * and nobody would have decided that.
 *
 * ## Why a boot-wired seam rather than injection
 *
 * `PATCH /api/config` is a module-level router with no construction seam to pass
 * a service through, and it is the only live write path for either setting (both
 * are `operator-only`, so the capability surface refuses them outright). This
 * mirrors `initCapabilityTierGate`, for the same reason and with the same
 * fail-quiet behavior: an unwired seam revokes nothing and says so in the log
 * rather than throwing inside a config write.
 *
 * @module services/core/approvals/standing-grant-posture
 */
import { logger } from '../../../lib/logger.js';
import type { ApprovalGrantService } from './approval-grant-service.js';

/** The two settings that license a standing permission to exist. */
export interface StandingGrantPosture {
  /** Whether local login is on, which is what makes a cookie possible. */
  loginEnabled: boolean;
  /** Whether standing permissions may exist at all. */
  standingGrants: boolean;
}

/** Boot-wired store. Undefined in a boot that never built one. */
let grants: ApprovalGrantService | undefined;

/**
 * Wire the standing-permission store so a posture change can end live
 * permissions. Called once at boot.
 *
 * @param service - The store built at boot.
 */
export function initStandingGrantPosture(service: ApprovalGrantService): void {
  grants = service;
}

/** Drop the wired store. Test-only seam, mirroring `resetCapabilityTierGate`. */
export function resetStandingGrantPosture(): void {
  grants = undefined;
}

/**
 * End every live standing permission when a config change takes away what
 * licensed them.
 *
 * Narrowing only: switching either setting ON grants nothing and revokes
 * nothing, because a permission is always a fresh human decision.
 *
 * @param before - The posture as it was before the write.
 * @param after - The posture as it is after the write.
 * @returns How many permissions were ended. Zero when nothing narrowed.
 */
export function revokeStandingGrantsIfPostureNarrowed(
  before: StandingGrantPosture,
  after: StandingGrantPosture
): number {
  const narrowed =
    (before.loginEnabled && !after.loginEnabled) ||
    (before.standingGrants && !after.standingGrants);
  if (!narrowed) return 0;

  if (!grants) {
    logger.warn(
      '[Approvals] A posture change should have ended standing permissions, but the store is not wired'
    );
    return 0;
  }

  const ended = grants.revokeAll();
  if (ended > 0) {
    logger.info(`[Approvals] Ended ${ended} standing permission(s) after a settings change`);
  }
  return ended;
}
